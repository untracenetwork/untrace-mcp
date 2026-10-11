/**
 * Streamable HTTP + OAuth 2.1 (authorization code + PKCE, confidential client), over a real
 * listening server, driven the way Claude and ChatGPT drive it.
 */
import { createHash, randomBytes } from "node:crypto"
import { request as httpRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { CLIENT_SECRET_PREFIX } from "@untracenetwork/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createHttpApp, listen, pkceMatches, safeEqual, type HttpOptions } from "../src/http"
import type { UntraceLike } from "../src/server"
import { KEY, mockClient } from "./helpers"

const CONNECTOR_SECRET = "c0nnector-secret-0123456789abcdefghijklmnop"
const CLAUDE = "https://claude.ai/api/mcp/auth_callback"
const PUBLIC = "https://mcp.example.com"

let server: Server
let base: string
let now = 1_800_000_000_000
let client: ReturnType<typeof mockClient>

async function start(extra: Partial<HttpOptions> = {}) {
  client = mockClient()
  const { app } = createHttpApp({
    publicUrl: PUBLIC,
    clientId: KEY,
    oauthClientSecret: CONNECTOR_SECRET,
    client: client as unknown as UntraceLike,
    now: () => now,
    ...extra,
  })
  server = await listen(app, 0, "127.0.0.1")
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
beforeEach(async () => {
  now = 1_800_000_000_000
  await start()
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
})

// Requests carry Host: mcp.example.com, as they would behind the TLS proxy.
type Res = Omit<Response, "json"> & { json(): Promise<any> }
const req = (path: string, init: RequestInit = {}): Promise<Res> =>
  fetch(base + path, { redirect: "manual", ...init, headers: { host: "mcp.example.com", ...(init.headers as Record<string, string>) } })

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}
const basic = (id = KEY, secret = CONNECTOR_SECRET) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`

async function authorize(p: Record<string, string>) {
  const res = await req(`/authorize?${new URLSearchParams(p)}`)
  return { res, loc: res.headers.get("location") ? new URL(res.headers.get("location")!) : null }
}
async function getCode(redirectUri = CLAUDE) {
  const { verifier, challenge } = pkce()
  const { loc } = await authorize({
    response_type: "code",
    client_id: KEY,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st8",
    resource: `${PUBLIC}/mcp`,
  })
  return { code: loc!.searchParams.get("code")!, verifier, loc: loc! }
}
const tokenReq = (body: Record<string, string>, auth: string | null = basic()) =>
  req("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(auth ? { authorization: auth } : {}) }, body: new URLSearchParams(body).toString() })

async function getTokens() {
  const { code, verifier } = await getCode()
  const res = await tokenReq({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE, resource: `${PUBLIC}/mcp` })
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
}
const rpc = (token: string | null, body: unknown) =>
  req("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

describe("discovery", () => {
  it("serves protected resource and authorization server metadata", async () => {
    const prm = await (await req("/.well-known/oauth-protected-resource/mcp")).json()
    expect(prm).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] })
    const as = await (await req("/.well-known/oauth-authorization-server")).json()
    expect(as).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      authorization_response_iss_parameter_supported: true,
    })
    expect(as.registration_endpoint).toBeUndefined()
  })

  it("an unauthenticated MCP call gets 401 with the resource metadata URL", async () => {
    const res = await rpc(null, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`)
  })
})

describe("authorize", () => {
  it("redirects with a code, the state and iss", async () => {
    const { code, loc } = await getCode()
    expect(loc.origin + loc.pathname).toBe(CLAUDE)
    expect(code).toMatch(/^uc_/)
    expect(loc.searchParams.get("state")).toBe("st8")
    expect(loc.searchParams.get("iss")).toBe(PUBLIC)
  })

  it("accepts the ChatGPT callbacks", async () => {
    expect((await getCode("https://chatgpt.com/connector_platform_oauth_redirect")).code).toMatch(/^uc_/)
    expect((await getCode("https://chatgpt.com/connector/oauth/abc_123")).code).toMatch(/^uc_/)
  })

  it("never redirects to an unlisted URI or for an unknown client", async () => {
    const { challenge } = pkce()
    const evil = await authorize({ response_type: "code", client_id: KEY, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" })
    expect(evil.res.status).toBe(400)
    expect(evil.loc).toBeNull()
    const loop = await authorize({ response_type: "code", client_id: KEY, redirect_uri: "http://localhost:6274/cb", code_challenge: challenge, code_challenge_method: "S256" })
    expect(loop.res.status).toBe(400)
    const other = await authorize({ response_type: "code", client_id: "utc_9Ab3cDe4FgH5jKm6NpQ7rS", redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: "S256" })
    expect(other.res.status).toBe(400)
    expect((await other.res.json()).error).toBe("invalid_client")
  })

  it("requires PKCE S256 and the right resource", async () => {
    const plain = await authorize({ response_type: "code", client_id: KEY, redirect_uri: CLAUDE, code_challenge: "x".repeat(43), code_challenge_method: "plain" })
    expect(plain.loc!.searchParams.get("error")).toBe("invalid_request")
    const { challenge } = pkce()
    const wrong = await authorize({ response_type: "code", client_id: KEY, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.example/mcp" })
    expect(wrong.loc!.searchParams.get("error")).toBe("invalid_target")
    expect(wrong.loc!.searchParams.get("iss")).toBe(PUBLIC)
  })

  it("loopback redirects only when allowed", async () => {
    await new Promise((r) => server.close(r))
    await start({ allowLoopbackRedirects: true })
    expect((await getCode("http://localhost:6274/oauth/callback")).code).toMatch(/^uc_/)
  })
})

describe("token", () => {
  it("exchanges a code once, with the verifier and the client secret", async () => {
    const { code, verifier } = await getCode()
    const res = await tokenReq({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const t = await res.json()
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600 })
    expect(t.access_token).toMatch(/^uat_/)
    const again = await tokenReq({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLAUDE })
    expect((await again.json()).error).toBe("invalid_grant")
  })

  it("client_secret_post works too", async () => {
    const { code, verifier } = await getCode()
    const res = await tokenReq({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: KEY, client_secret: CONNECTOR_SECRET }, null)
    expect(res.status).toBe(200)
  })

  it("rejects a wrong secret, a wrong verifier, a wrong redirect and an expired code", async () => {
    let c = await getCode()
    expect((await tokenReq({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier }, basic(KEY, "wrong-secret"))).status).toBe(401)
    c = await getCode()
    expect((await (await tokenReq({ grant_type: "authorization_code", code: c.code, code_verifier: pkce().verifier })).json()).error).toBe("invalid_grant")
    c = await getCode()
    expect((await (await tokenReq({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" })).json()).error).toBe("invalid_grant")
    c = await getCode()
    now += 61_000
    expect((await (await tokenReq({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier })).json()).error).toBe("invalid_grant")
  })

  it("rotates refresh tokens: each works once", async () => {
    const t = await getTokens()
    const r1 = await tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token })
    const t2 = await r1.json()
    expect(t2.access_token).toMatch(/^uat_/)
    expect(t2.refresh_token).not.toBe(t.refresh_token)
    expect((await (await tokenReq({ grant_type: "refresh_token", refresh_token: t.refresh_token })).json()).error).toBe("invalid_grant")
  })

  it("revocation kills an access token", async () => {
    const t = await getTokens()
    await req("/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: basic() }, body: `token=${t.access_token}` })
    expect((await rpc(t.access_token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401)
  })

  it("rate limits the token endpoint", async () => {
    let last = 0
    for (let i = 0; i < 61; i++) last = (await tokenReq({ grant_type: "refresh_token", refresh_token: "x" })).status
    expect(last).toBe(429)
  })
})

describe("MCP over HTTP", () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }

  it("initialize, list tools and call one with a valid token", async () => {
    const t = await getTokens()
    const r0 = await rpc(t.access_token, init)
    expect(r0.status).toBe(200)
    expect((await r0.json()).result.serverInfo.name).toBe("untrace-mcp")
    const r1 = await (await rpc(t.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()
    expect(r1.result.tools).toHaveLength(13)
    const r2 = await (await rpc(t.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "untrace_whoami", arguments: {} } })).json()
    expect(JSON.parse(r2.result.content[0].text).clientId).toBe(KEY)
  })

  it("local paths are off on the HTTP server", async () => {
    const t = await getTokens()
    const r = await (await rpc(t.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "untrace_upload_file", arguments: { path: "etc/passwd" } } })).json()
    expect(r.result.isError).toBe(true)
    expect(r.result.content[0].text).toMatch(/local paths are turned off/)
  })

  it("an expired or unknown token is refused", async () => {
    const t = await getTokens()
    now += 3601_000
    expect((await rpc(t.access_token, init)).status).toBe(401)
    expect((await rpc("uat_nope", init)).status).toBe(401)
  })

  it("GET and DELETE on /mcp are 405 (stateless)", async () => {
    const t = await getTokens()
    expect((await req("/mcp", { headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(405)
  })

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const r = httpRequest(`${base}/healthz`, { headers: { host } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        r.on("error", reject)
        r.end()
      })
    expect(await status("evil.example")).toBe(403)
    expect(await status("mcp.example.com")).toBe(200)
  })
})

describe("configuration checks", () => {
  const ok: HttpOptions = { publicUrl: PUBLIC, clientId: KEY, oauthClientSecret: CONNECTOR_SECRET }
  it("refuses http public URLs, paths, short or raw-secret connector secrets, bad client ids", () => {
    expect(() => createHttpApp({ ...ok, publicUrl: "http://mcp.example.com" })).toThrow(/https/)
    expect(() => createHttpApp({ ...ok, publicUrl: "https://mcp.example.com/x" })).toThrow(/origin only/)
    expect(() => createHttpApp({ ...ok, oauthClientSecret: "short" })).toThrow(/32 characters/)
    expect(() => createHttpApp({ ...ok, oauthClientSecret: `${CLIENT_SECRET_PREFIX}${"a".repeat(43)}` })).toThrow(/separate random value/)
    expect(() => createHttpApp({ ...ok, clientId: "nope" })).toThrow(/utc_/)
    expect(() => createHttpApp({ ...ok, publicUrl: "http://localhost:8787" })).not.toThrow()
  })

  it("helpers: PKCE and constant-time compare", () => {
    const { verifier, challenge } = pkce()
    expect(pkceMatches(verifier, challenge)).toBe(true)
    expect(pkceMatches("short", challenge)).toBe(false)
    expect(safeEqual("a", "a")).toBe(true)
    expect(safeEqual("a", "ab")).toBe(false)
  })
})
