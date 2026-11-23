/**
 * The hosted Untrace MCP server: a Cloudflare Worker that serves the tools needing no developer
 * key (untrace_generate_link, untrace_setup_guide) over MCP Streamable HTTP. Stateless, JSON
 * responses, no sign-in, no storage.
 *
 * The tools are the npm package's own (src/keyless.ts) on the official MCP SDK server
 * (McpServer + the Web Standard Streamable HTTP transport), so the hosted answer equals the stdio
 * answer for the same input. One server and one transport per request.
 *
 * Privacy: the HTML reaches this Worker inside the tools/call request and stays in memory while
 * the link is built. Nothing is stored and nothing is logged: this folder never calls console,
 * the Worker has no storage binding and Workers Logs are off. The link's fragment (after #) is
 * never sent to Drive.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js"

import { DEFAULT_DRIVE_ORIGIN, GenerateLinkError, MAX_GENERATE_HTML_BYTES, type GenerateFormat } from "../../src/generate-link"
import { FRAMEWORKS } from "../../src/guide"
import { SETUP_GUIDE_TOOL, generateLinkResult, generateLinkTool, readDocumentInput, setupGuideResult } from "../../src/keyless"
import { ToolRefusal } from "../../src/refusal"
import type { TemplateId } from "../../src/templates"
import { VERSION } from "../../src/version"

export const MCP_PATH = "/mcp"
export const HEALTH_PATH = "/health"
/** The tools this Worker serves, in tools/list order. */
export const HOSTED_TOOL_NAMES = ["untrace_generate_link", "untrace_setup_guide"] as const
/** Largest request body read, in bytes (2.5 MiB): room for 2 MiB of HTML plus JSON escaping. */
export const MAX_BODY_BYTES = 2.5 * 1024 * 1024
/** Requests per minute per IP address. Must match [[ratelimits]] in wrangler.toml (a test checks). */
export const RATE_LIMIT_PER_MINUTE = 60
/** Revisions this server speaks, newest first: the ones the MCP SDK it is built on supports. */
export { SUPPORTED_PROTOCOL_VERSIONS }
export { MAX_GENERATE_HTML_BYTES }

/** The Workers Rate Limiting binding ([[ratelimits]] in wrangler.toml). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}
export interface Env {
  /** Missing (tests, local runs): no limit. */
  RATE_LIMITER?: RateLimiter
}

const INSTRUCTIONS = [
  "Untrace tools that need no sign-in and no key.",
  "To hand the user a document to edit in Drive (a plan, a report, a letter), write it as HTML and call untrace_generate_link, or pass template (mutual-nda, invoice, proposal-quote, letter, meeting-minutes) and its fields; give them the link and do not post it anywhere public.",
  "Developers adding Untrace to their own app: call untrace_setup_guide once the stack is known.",
  "Files in a person's Drive are not reachable from here: that needs the npm package @untracenetwork/mcp with the person's own developer key.",
].join(" ")

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...extra } })
const rpcError = (code: number, message: string, status: number, extra: Record<string, string> = {}, data?: unknown) =>
  json({ jsonrpc: "2.0", id: null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status, extra)

/** A tool error result: refusals keep their message (never the document), anything else a fixed one. */
function toolFailure(err: unknown) {
  const refusal = err instanceof ToolRefusal || err instanceof GenerateLinkError
  const text = refusal ? `refused: ${(err as Error).message}` : "error: The request could not be completed. Try again."
  return { isError: true as const, content: [{ type: "text" as const, text }] }
}

/**
 * The SDK's default JSON Schema validator (Ajv) compiles code at run time, which Workers refuse.
 * It is used only to check elicitation answers, and this server never elicits: refuse them all.
 */
const NO_ELICITATION = {
  getValidator: () => () => ({ valid: false as const, data: undefined, errorMessage: "This server does not ask for input." }),
}

/** A fresh MCP server with the hosted tools. Stateless: one per request. */
export function createHostedServer(): McpServer {
  const server = new McpServer({ name: "untrace-mcp", title: "Untrace", version: VERSION }, { instructions: INSTRUCTIONS, jsonSchemaValidator: NO_ELICITATION })
  server.registerTool(
    "untrace_generate_link",
    generateLinkTool("hosted"),
    async ({ html, format, template, fields }: { html?: string; format?: GenerateFormat; template?: TemplateId; fields?: Record<string, string> }) => {
      try {
        const { doc, filled } = await readDocumentInput({ html, template, fields })
        return await generateLinkResult(doc, filled, { format: format ?? "doc", origin: DEFAULT_DRIVE_ORIGIN })
      } catch (err) {
        return toolFailure(err)
      }
    }
  )
  server.registerTool("untrace_setup_guide", SETUP_GUIDE_TOOL, async ({ framework, includeReference }: { framework: (typeof FRAMEWORKS)[number]; includeReference?: boolean }) =>
    setupGuideResult({ framework, includeReference })
  )
  return server
}

async function rateLimited(request: Request, env: Env): Promise<boolean> {
  if (!env.RATE_LIMITER) return false
  try {
    const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" })
    return !success
  } catch {
    return false // a limiter outage must not take the tools down
  }
}

/** Copy `res` with CORS and no-store added (the SDK transport sets neither). */
function withHeaders(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

async function handleMcpPost(request: Request, env: Env): Promise<Response> {
  // Both checks come before the body is read.
  if (await rateLimited(request, env)) {
    return rpcError(-32000, `Too many requests: at most ${RATE_LIMIT_PER_MINUTE} a minute from one address. Retry in a minute.`, 429, { "Retry-After": "60" })
  }
  const declared = Number(request.headers.get("Content-Length"))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return rpcError(-32000, "Request too large: at most 2.5 MB. Drive opens at most 2 MB of HTML; shorten the document.", 413)
  }
  const server = createHostedServer()
  // Stateless (no session id), JSON answers. The transport also stops reading a body without a
  // Content-Length at MAX_BODY_BYTES (413).
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES })
  try {
    await server.connect(transport)
    return withHeaders(await transport.handleRequest(request))
  } finally {
    await transport.close().catch(() => {})
    await server.close().catch(() => {})
  }
}

function health(request: Request): Response {
  const body = JSON.stringify({ ok: true, name: "untrace-mcp", version: VERSION, tools: [...HOSTED_TOOL_NAMES] })
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } })
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (pathname === MCP_PATH || pathname === `${MCP_PATH}/`) {
    if (request.method === "POST") return handleMcpPost(request, env)
    // No event stream and no session: the spec lets a server decline GET with 405.
    return rpcError(-32000, "Method not allowed. This server is stateless: use POST.", 405, { Allow: "POST, OPTIONS" })
  }
  if (pathname === HEALTH_PATH && (request.method === "GET" || request.method === "HEAD")) return health(request)
  return json({ error: "not_found" }, 404)
}
