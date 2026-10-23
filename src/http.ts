/**
 * Streamable HTTP transport with OAuth 2.1, so the server works as a Claude custom connector
 * and as a ChatGPT app (MCP authorization spec, 2025-11-25).
 *
 * This server is its own small authorization server for exactly ONE OAuth client: the Untrace
 * developer key it runs as. The OAuth client id is UNTRACE_CLIENT_ID. The OAuth client secret is
 * UNTRACE_MCP_OAUTH_CLIENT_SECRET, a separate random value the operator creates
 * (`untrace-mcp new-connector-secret`). It only opens this server: it is never the
 * developer key secret and never accepted by Drive, so Claude or ChatGPT never store a value
 * that works against Drive, and it can be rotated without rotating the developer key.
 *
 * Flow: authorization code + PKCE (S256), confidential client (client_secret_basic or
 * client_secret_post), redirect URIs from an allowlist, RFC 9207 `iss` on every redirect,
 * RFC 8707 `resource` checked, RFC 9728 protected resource metadata, refresh tokens rotated.
 * The authorize step needs no login page: a code is worthless without the client secret.
 * Tokens live in memory only; a restart signs every client out and they reconnect.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { Server } from "node:http"

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js"
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CLIENT_SECRET_PREFIX, UntraceClient } from "@untracenetwork/sdk"
import express, { type Request, type Response } from "express"

import { createServer, type ServerOptions, type UntraceLike } from "./server"

export const MCP_PATH = "/mcp"
export const ACCESS_TOKEN_TTL_S = 3600
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600
export const CODE_TTL_S = 60

/** Callback URLs of the hosted MCP clients this server is meant for. Exact match. */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
]
/** ChatGPT's per-app callback form, https://chatgpt.com/connector/oauth/{callback_id}. */
const CHATGPT_CALLBACK_RE = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

export interface HttpOptions {
  /** Public HTTPS origin clients reach this server at, e.g. https://mcp.example.com. */
  publicUrl: string
  /** The OAuth client id (= UNTRACE_CLIENT_ID). */
  clientId: string
  /** The OAuth client secret Claude or ChatGPT present (UNTRACE_MCP_OAUTH_CLIENT_SECRET). At least 32 characters. */
  oauthClientSecret: string
  /** Extra exact redirect URIs to allow, on top of DEFAULT_REDIRECT_URIS. */
  redirectUris?: string[]
  /** Allow loopback redirect URIs (any port), for local testing with MCP Inspector. Default false. */
  allowLoopbackRedirects?: boolean
  /** Untrace client shared by every request (one token cache). */
  client?: UntraceLike | (() => UntraceLike)
  /** Passed to createServer. Default: no local paths unless UNTRACE_MCP_ROOT is set. */
  root?: ServerOptions["root"]
  maxInlineBytes?: number
  /** Interface to bind (only used for DNS rebinding protection). Default 127.0.0.1. */
  host?: string
  /** Clock, for tests. Milliseconds. */
  now?: () => number
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest()
const b64url = (b: Buffer) => b.toString("base64url")
const token = (prefix: string) => `${prefix}${b64url(randomBytes(32))}`

/** Constant-time string comparison through SHA-256, so lengths do not leak either. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

/** PKCE S256: base64url(SHA-256(verifier)) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  return safeEqual(b64url(sha256(verifier)), challenge)
}

function normalizeResource(v: string): string {
  const hash = v.indexOf("#")
  return (hash === -1 ? v : v.slice(0, hash)).replace(/\/$/, "")
}

interface CodeRecord {
  redirectUri: string
  challenge: string
  resource: string
  expiresAt: number
}
interface TokenRecord {
  expiresAt: number
  resource: string
}

/** Tiny fixed-window limiter per client address. */
function limiter(max: number, windowMs: number, now: () => number) {
  const hits = new Map<string, { n: number; reset: number }>()
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? "unknown"
    const t = now()
    let h = hits.get(key)
    if (!h || h.reset <= t) {
      h = { n: 0, reset: t + windowMs }
      hits.set(key, h)
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k)
    }
    if (++h.n > max) {
      res.setHeader("Retry-After", String(Math.ceil((h.reset - t) / 1000)))
      res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many requests. Retry later." })
      return
    }
    next()
  }
}

export function createHttpApp(opts: HttpOptions) {
  const now = opts.now ?? Date.now
  const base = new URL(opts.publicUrl)
  if (base.protocol !== "https:" && !LOOPBACK.has(base.hostname)) throw new Error("UNTRACE_MCP_PUBLIC_URL must be https (or a loopback http URL for local testing)")
  if (base.pathname !== "/" || base.search || base.hash) throw new Error("UNTRACE_MCP_PUBLIC_URL must be an origin only, like https://mcp.example.com")
  if (typeof opts.oauthClientSecret !== "string" || opts.oauthClientSecret.length < 32) throw new Error("UNTRACE_MCP_OAUTH_CLIENT_SECRET must be at least 32 characters (run: untrace-mcp new-connector-secret)")
  if (opts.oauthClientSecret.startsWith(CLIENT_SECRET_PREFIX)) throw new Error("UNTRACE_MCP_OAUTH_CLIENT_SECRET must be a separate random value, never the developer key secret")
  if (!/^utc_[1-9A-HJ-NP-Za-km-z]{22}$/.test(opts.clientId)) throw new Error("UNTRACE_CLIENT_ID must be utc_ followed by 22 base58 characters")
  const issuer = base.origin
  const resource = `${issuer}${MCP_PATH}`
  const prmUrl = `${issuer}/.well-known/oauth-protected-resource${MCP_PATH}`
  const allowed = new Set([...DEFAULT_REDIRECT_URIS, ...(opts.redirectUris ?? [])])

  const redirectAllowed = (uri: string): boolean => {
    if (allowed.has(uri) || CHATGPT_CALLBACK_RE.test(uri)) return true
    if (!opts.allowLoopbackRedirects) return false
    try {
      const u = new URL(uri)
      return u.protocol === "http:" && LOOPBACK.has(u.hostname) && !u.username && !u.password && !u.hash
    } catch {
      return false
    }
  }

  // Only SHA-256 hashes of codes and tokens are kept.
  const codes = new Map<string, CodeRecord>()
  const accessTokens = new Map<string, TokenRecord>()
  const refreshTokens = new Map<string, TokenRecord>()
  const key = (t: string) => sha256(t).toString("hex")
  const sweep = () => {
    const t = now()
    for (const m of [codes, accessTokens, refreshTokens] as Map<string, { expiresAt: number }>[]) for (const [k, v] of m) if (v.expiresAt <= t) m.delete(k)
  }

  const host = opts.host ?? "127.0.0.1"
  const app = createMcpExpressApp({ host, allowedHosts: LOOPBACK.has(base.hostname) ? undefined : [base.hostname, "localhost", "127.0.0.1"] })
  app.disable("x-powered-by")
  app.set("trust proxy", "loopback")

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://untrace.network/docs/mcp",
  }
  const protectedResource = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    resource_name: "Untrace Drive",
    resource_documentation: "https://untrace.network/docs/mcp",
  }
  const sendJson = (body: unknown) => (_req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.json(body)
  }
  app.get("/.well-known/oauth-authorization-server", sendJson(metadata))
  app.get(`/.well-known/oauth-authorization-server${MCP_PATH}`, sendJson(metadata))
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, sendJson(protectedResource))
  app.get("/.well-known/oauth-protected-resource", sendJson(protectedResource))
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true })
  })

  const oauthError = (res: Response, status: number, error: string, description: string) => {
    res.setHeader("Cache-Control", "no-store")
    res.status(status).json({ error, error_description: description })
  }

  // -- authorize -------------------------------------------------------------
  app.all("/authorize", limiter(60, 60_000, now), express.urlencoded({ extended: false }), (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).end()
      return
    }
    const q = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>
    const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : undefined)
    const clientId = str("client_id")
    const redirectUri = str("redirect_uri")
    // Errors before the redirect URI is trusted are shown here, never redirected.
    if (!clientId || !safeEqual(clientId, opts.clientId)) {
      oauthError(res, 400, "invalid_client", "Unknown client_id. Use the Untrace client id this server runs as.")
      return
    }
    if (!redirectUri || !redirectAllowed(redirectUri)) {
      oauthError(res, 400, "invalid_request", "redirect_uri is not on this server's allowlist (UNTRACE_MCP_REDIRECT_URIS).")
      return
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri)
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
      u.searchParams.set("iss", issuer)
      const state = str("state")
      if (state) u.searchParams.set("state", state)
      res.redirect(302, u.href)
    }
    if (str("response_type") !== "code") return back({ error: "unsupported_response_type", error_description: "Only response_type=code is supported." })
    const challenge = str("code_challenge")
    if (!challenge || str("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return back({ error: "invalid_request", error_description: "PKCE with code_challenge_method=S256 is required." })
    }
    const asked = str("resource")
    if (asked && normalizeResource(asked) !== resource) return back({ error: "invalid_target", error_description: `This server only issues tokens for ${resource}.` })
    sweep()
    const code = token("uc_")
    codes.set(key(code), { redirectUri, challenge, resource, expiresAt: now() + CODE_TTL_S * 1000 })
    back({ code })
  })

  // -- client authentication ---------------------------------------------------
  const authenticateClient = (req: Request): boolean => {
    let id: string | undefined
    let secret: string | undefined
    const h = req.headers.authorization
    if (h && /^basic /i.test(h)) {
      const raw = Buffer.from(h.slice(6).trim(), "base64").toString("utf8")
      const i = raw.indexOf(":")
      if (i < 0) return false
      try {
        id = decodeURIComponent(raw.slice(0, i))
        secret = decodeURIComponent(raw.slice(i + 1))
      } catch {
        return false
      }
    } else {
      id = typeof req.body?.client_id === "string" ? req.body.client_id : undefined
      secret = typeof req.body?.client_secret === "string" ? req.body.client_secret : undefined
    }
    if (!id || !secret) return false
    // Both comparisons always run.
    const idOk = safeEqual(id, opts.clientId)
    const secretOk = safeEqual(secret, opts.oauthClientSecret)
    return idOk && secretOk
  }

  const issueTokens = (res: Response, tokenResource: string) => {
    const access = token("uat_")
    const refresh = token("urt_")
    const t = now()
    accessTokens.set(key(access), { expiresAt: t + ACCESS_TOKEN_TTL_S * 1000, resource: tokenResource })
    refreshTokens.set(key(refresh), { expiresAt: t + REFRESH_TOKEN_TTL_S * 1000, resource: tokenResource })
    res.setHeader("Cache-Control", "no-store")
    res.json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh })
  }

  // -- token ---------------------------------------------------------------------
  app.post("/token", limiter(60, 60_000, now), express.urlencoded({ extended: false }), express.json(), (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    if (!authenticateClient(req)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="untrace-mcp"')
      return oauthError(res, 401, "invalid_client", "Client authentication failed.")
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const grant = body.grant_type
    sweep()
    if (grant === "authorization_code") {
      const code = typeof body.code === "string" ? body.code : ""
      const rec = codes.get(key(code))
      codes.delete(key(code)) // single use, even on failure
      if (!rec || rec.expiresAt <= now()) return oauthError(res, 400, "invalid_grant", "The authorization code is unknown, used or expired.")
      if (typeof body.redirect_uri === "string" && body.redirect_uri !== rec.redirectUri) return oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request.")
      if (typeof body.code_verifier !== "string" || !pkceMatches(body.code_verifier, rec.challenge)) return oauthError(res, 400, "invalid_grant", "code_verifier does not match the code_challenge.")
      if (typeof body.resource === "string" && normalizeResource(body.resource) !== rec.resource) return oauthError(res, 400, "invalid_target", "resource does not match the authorization request.")
      return issueTokens(res, rec.resource)
    }
    if (grant === "refresh_token") {
      const rt = typeof body.refresh_token === "string" ? body.refresh_token : ""
      const rec = refreshTokens.get(key(rt))
      refreshTokens.delete(key(rt)) // rotation: a refresh token works once
      if (!rec || rec.expiresAt <= now()) return oauthError(res, 400, "invalid_grant", "The refresh token is unknown, used or expired.")
      if (typeof body.resource === "string" && normalizeResource(body.resource) !== rec.resource) return oauthError(res, 400, "invalid_target", "resource does not match.")
      return issueTokens(res, rec.resource)
    }
    return oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.")
  })

  // -- revoke (RFC 7009) -----------------------------------------------------------
  app.post("/revoke", limiter(60, 60_000, now), express.urlencoded({ extended: false }), express.json(), (req, res) => {
    if (!authenticateClient(req)) return oauthError(res, 401, "invalid_client", "Client authentication failed.")
    const t = typeof req.body?.token === "string" ? req.body.token : ""
    accessTokens.delete(key(t))
    refreshTokens.delete(key(t))
    res.status(200).end()
  })

  // -- MCP endpoint ------------------------------------------------------------------
  const verifier = {
    async verifyAccessToken(t: string): Promise<AuthInfo> {
      const rec = accessTokens.get(key(t))
      if (!rec || rec.expiresAt <= now()) throw new InvalidTokenError("The access token is unknown or expired.")
      return { token: t, clientId: opts.clientId, scopes: [], expiresAt: Math.floor(rec.expiresAt / 1000), resource: new URL(rec.resource) }
    },
  }
  const bearer = requireBearerAuth({ verifier, resourceMetadataUrl: prmUrl, expectedResource: new URL(resource) })

  // One Untrace client for all requests, so the Drive token is cached across calls.
  let shared: UntraceLike | null = null
  const clientFactory = (): UntraceLike => {
    if (shared) return shared
    const c = opts.client
    shared = typeof c === "function" ? c() : (c ?? (new UntraceClient() as unknown as UntraceLike))
    return shared
  }

  const handle = async (req: Request, res: Response) => {
    const server = createServer({ client: clientFactory, root: opts.root ?? (process.env.UNTRACE_MCP_ROOT ? undefined : false), maxInlineBytes: opts.maxInlineBytes })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null })
    }
  }
  app.post(MCP_PATH, bearer, handle)
  const notAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST")
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: use POST." }, id: null })
  }
  app.get(MCP_PATH, bearer, notAllowed)
  app.delete(MCP_PATH, bearer, notAllowed)

  return { app, issuer, resource, redirectAllowed }
}

/** Start listening. Resolves once the port is bound. */
export function listen(app: ReturnType<typeof createHttpApp>["app"], port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, host, (err?: Error) => (err ? reject(err) : resolve(s)))
  })
}
