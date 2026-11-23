/**
 * The hosted MCP server (worker/): the Worker's fetch handler, called with Request objects the
 * way Cloudflare calls it, plus one session with the official MCP client. The decoder is written
 * independently, the way a browser reads the fragment.
 */
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { afterEach, describe, expect, it, vi } from "vitest"

import { buildGenerateLink, CHAT_LINK_WARN_HTML_BYTES, MAX_GENERATE_HTML_BYTES } from "../src/generate-link"
import { FRAMEWORKS, setupGuide } from "../src/guide"
import { harness } from "./helpers"

// Imported per test, so on a tree without the Worker each test fails on its own.
const worker = () => import("../worker/src/mcp")

const root = fileURLToPath(new URL("../", import.meta.url))
const read = (p: string) => readFileSync(`${root}${p}`, "utf8")
const pkg = JSON.parse(read("package.json")) as { version: string }

afterEach(() => vi.restoreAllMocks())

// ---- a fake Rate Limiting binding ----

function limiter(allow = true) {
  const keys: string[] = []
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: allow }) }
}

const ORIGIN = "https://mcp.untrace.network"
const URL_MCP = `${ORIGIN}/mcp`
const IP = "2001:db8::7"
const ACCEPT = "application/json, text/event-stream"

async function post(body: unknown, opts: { env?: object; headers?: Record<string, string>; raw?: string } = {}) {
  const { handle } = await worker()
  const env = opts.env ?? { RATE_LIMITER: limiter() }
  const req = new Request(URL_MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, "cf-connecting-ip": IP, ...opts.headers },
    body: opts.raw ?? JSON.stringify(body),
  })
  return handle(req, env as never)
}

let nextId = 1
const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) })
const PV = { "mcp-protocol-version": "2025-06-18" }

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean }
async function callTool(name: string, args: unknown, env?: object): Promise<ToolResult> {
  const res = await post(rpc("tools/call", { name, arguments: args }), { env, headers: PV })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: ToolResult }
  return body.result
}
const gen = (args: unknown) => callTool("untrace_generate_link", args)

// ---- an independent, browser-style decoder ----

function b64urlToBytes(s: string): Uint8Array {
  expect(s).toMatch(/^[A-Za-z0-9_-]*$/)
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
async function decodeLink(url: string): Promise<string> {
  const u = new URL(url)
  expect(u.origin + u.pathname).toBe("https://drive.untrace.network/generate")
  const m = /^(doc|html)=(.*)$/s.exec(u.hash.slice(1))
  if (!m) throw new Error("no doc= or html= in the fragment")
  const raw = b64urlToBytes(m[2]!)
  return new TextDecoder("utf-8", { fatal: true }).decode(m[1] === "doc" ? await inflateRaw(raw) : raw)
}

const PLAN = "<h1>Northwind Coffee: plan</h1><p>Two shops by 2027.</p><table><tr><th>Year</th><th>Shops</th></tr><tr><td>2027</td><td>2</td></tr></table>"
const ARABIC = "<h1>خطة العمل</h1><p>متجران بحلول 2027 ☕ 🚀</p>"
/** ASCII HTML of exactly `n` bytes. */
const sized = (n: number) => {
  const head = "<h1>Plan</h1><p>"
  const tail = "</p>"
  return head + "a".repeat(n - head.length - tail.length) + tail
}

describe("health", () => {
  it("GET /health is 200 JSON: ok, name, the package version and the tool names, no-store", async () => {
    const { handle, HOSTED_TOOL_NAMES } = await worker()
    const res = await handle(new Request(`${ORIGIN}/health`), {})
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/^application\/json/)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ ok: true, name: "untrace-mcp", version: pkg.version, tools: [...HOSTED_TOOL_NAMES] })
    expect([...HOSTED_TOOL_NAMES]).toEqual(["untrace_generate_link", "untrace_setup_guide"])
  })

  it("HEAD /health is 200 with no body", async () => {
    const { handle } = await worker()
    const res = await handle(new Request(`${ORIGIN}/health`, { method: "HEAD" }), {})
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.text()).toBe("")
  })
})

describe("MCP protocol (Streamable HTTP, stateless, JSON)", () => {
  it("initialize answers the asked revision, the tools capability and no session id", async () => {
    const res = await post(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/^application\/json/)
    expect(res.headers.get("mcp-session-id")).toBeNull()
    const { result } = (await res.json()) as any
    expect(result.protocolVersion).toBe("2025-06-18")
    expect(result.capabilities.tools).toBeTruthy()
    expect(result.serverInfo).toMatchObject({ name: "untrace-mcp", version: pkg.version })
  })

  it("initialize negotiates every revision the SDK supports, and answers the newest for an unknown one", async () => {
    const { SUPPORTED_PROTOCOL_VERSIONS } = await worker()
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2025-11-25")
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain("2025-03-26")
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
      const res = await post(rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "t", version: "1" } }))
      expect(((await res.json()) as any).result.protocolVersion).toBe(v)
    }
    const res = await post(rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } }))
    expect(((await res.json()) as any).result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0])
  })

  it("notifications/initialized is accepted with 202 and no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { headers: PV })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe("")
  })

  it("ping answers an empty result", async () => {
    const res = await post(rpc("ping"), { headers: PV })
    expect(((await res.json()) as any).result).toEqual({})
  })

  it("tools/list shows exactly the two keyless tools, with the stdio tool's schema minus path", async () => {
    const { HOSTED_TOOL_NAMES } = await worker()
    const res = await post(rpc("tools/list"), { headers: PV })
    const { tools } = ((await res.json()) as any).result
    expect(tools.map((t: { name: string }) => t.name)).toEqual([...HOSTED_TOOL_NAMES])

    const h = await harness()
    try {
      const local = (await h.mcp.listTools()).tools
      const localGen = local.find((t) => t.name === "untrace_generate_link")!
      const hostedGen = tools.find((t: { name: string }) => t.name === "untrace_generate_link")
      const { path: _path, ...localProps } = localGen.inputSchema.properties as Record<string, { description?: string }>
      expect(Object.keys(hostedGen.inputSchema.properties)).toEqual(Object.keys(localProps))
      for (const k of ["format", "fields"]) expect(hostedGen.inputSchema.properties[k]).toEqual(localProps[k])
      expect(hostedGen.inputSchema.properties.template.enum).toEqual((localProps.template as any).enum)
      expect(hostedGen.annotations).toEqual(localGen.annotations)
      expect(hostedGen.description).not.toMatch(/\bpath\b|UNTRACE_MCP_ROOT|allowed folder/)
      for (const part of ["2 MB", "200 KB", "deflate-raw", "base64url", "RFC 1951", "#doc=", "What is kept", "What is removed", "never post it publicly"]) {
        expect(hostedGen.description).toContain(part)
      }
      const localGuide = local.find((t) => t.name === "untrace_setup_guide")!
      const hostedGuide = tools.find((t: { name: string }) => t.name === "untrace_setup_guide")
      expect(hostedGuide).toEqual(JSON.parse(JSON.stringify(localGuide)))
    } finally {
      await h.close()
    }
  })

  it("unknown method -32601, unknown tool is an error, bad JSON -32700, not JSON-RPC is 400", async () => {
    const m = (await (await post(rpc("resources/list"), { headers: PV })).json()) as any
    expect(m.error.code).toBe(-32601)
    const t = await post(rpc("tools/call", { name: "untrace_upload_file", arguments: {} }), { headers: PV })
    const tb = (await t.json()) as any
    // The SDK answers an unknown tool as a tool error result (isError), naming it.
    expect(String(tb.error?.code ?? (tb.result.isError ? "isError" : "none"))).toMatch(/-32602|isError/)
    expect(JSON.stringify(tb)).toMatch(/untrace_upload_file not found/)
    const bad = await post(null, { raw: "{not json", headers: PV })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as any).error.code).toBe(-32700)
    const notRpc = await post({ id: 1, method: "ping" }, { headers: PV })
    expect(notRpc.status).toBe(400)
    expect(((await notRpc.json()) as any).error).toBeTruthy()
  })

  it("an unknown Mcp-Protocol-Version header on a normal request is 400 naming the supported revisions", async () => {
    const res = await post(rpc("tools/list"), { headers: { "mcp-protocol-version": "2099-01-01" } })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.message).toMatch(/2025-06-18/)
  })

  it("a body that is not application/json is 415", async () => {
    const res = await post(rpc("ping"), { headers: { "content-type": "text/plain", ...PV } })
    expect(res.status).toBe(415)
  })
})

describe("untrace_generate_link on the Worker", () => {
  it.each([
    ["ASCII, doc", PLAN, "doc"],
    ["Arabic and emoji, doc", ARABIC, "doc"],
    ["ASCII, html", PLAN, "html"],
    ["Arabic and emoji, html", ARABIC, "html"],
  ] as const)("equals buildGenerateLink and decodes back to the same HTML (%s)", async (_label, html, format) => {
    const result = await gen({ html, format })
    expect(result.isError).toBeFalsy()
    const link = JSON.parse(result.content[0]!.text)
    const want = await buildGenerateLink(html, { format })
    expect(link).toEqual({ url: want.url, format: want.format, htmlBytes: want.htmlBytes, urlChars: want.urlChars })
    expect(await decodeLink(link.url)).toBe(html)
    expect(result.content[1]!.text).toMatch(/Open the url in a browser/)
  })

  it("answers exactly what the stdio tool answers for the same input (html, both formats, and a template)", async () => {
    const h = await harness()
    try {
      for (const args of [{ html: ARABIC }, { html: PLAN, format: "html" }, { template: "letter", fields: { Email: "ana@example.com" } }, { template: "invoice" }]) {
        const local = await h.mcp.callTool({ name: "untrace_generate_link", arguments: args })
        const hosted = await gen(args)
        expect(hosted).toEqual(JSON.parse(JSON.stringify(local)))
      }
    } finally {
      await h.close()
    }
  })

  it("format defaults to doc", async () => {
    const link = JSON.parse((await gen({ html: PLAN })).content[0]!.text)
    expect(link.format).toBe("doc")
  })

  it("refuses more than 2 MB of HTML, without repeating it", async () => {
    const { MAX_GENERATE_HTML_BYTES: cap } = await worker()
    expect(cap).toBe(MAX_GENERATE_HTML_BYTES)
    const html = sized(MAX_GENERATE_HTML_BYTES + 1).replace("<p>a", "<p>SECRET-MARKER-a")
    const result = await gen({ html })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(new RegExp(`^refused: Refused: the HTML is ${html.length} bytes`))
    expect(JSON.stringify(result)).not.toContain("SECRET-MARKER")
  })

  it("accepts exactly 2 MB of HTML", async () => {
    const html = sized(MAX_GENERATE_HTML_BYTES)
    const result = await gen({ html })
    expect(result.isError).toBeFalsy()
    expect(await decodeLink(JSON.parse(result.content[0]!.text).url)).toBe(html)
  })

  it("warns above about 200 KB, and not at 200 KB", async () => {
    const at = JSON.parse((await gen({ html: sized(CHAT_LINK_WARN_HTML_BYTES) })).content[0]!.text)
    expect(at.warning).toBeUndefined()
    const over = await gen({ html: sized(CHAT_LINK_WARN_HTML_BYTES + 1) })
    expect(over.isError).toBeFalsy()
    expect(JSON.parse(over.content[0]!.text).warning).toMatch(/200 KB/)
  })

  it("refuses an empty document, a bad format, no input, two inputs and the local-only path", async () => {
    for (const [args, re] of [
      [{ html: "   " }, /the HTML is empty/],
      [{ html: PLAN, format: "pdf" }, /format/],
      [{}, /exactly one of html or template/],
      [{ html: PLAN, template: "letter" }, /exactly one of html or template/],
      [{ path: "plan.html" }, /exactly one of html or template/],
      [{ html: PLAN, fields: { a: "b" } }, /fields works only with template/],
      [{ template: "letter", fields: { Nope: "x" } }, /not in template letter/],
    ] as const) {
      const result = await gen(args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.content[0]!.text).toMatch(re)
    }
  })
})

describe("untrace_setup_guide on the Worker", () => {
  it.each(FRAMEWORKS.map((f) => [f]))("answers the package's guide for %s", async (framework) => {
    const result = await callTool("untrace_setup_guide", { framework })
    expect(result.content).toEqual([{ type: "text", text: setupGuide(framework, true) }])
    const short = await callTool("untrace_setup_guide", { framework, includeReference: false })
    expect(short.content[0]!.text).toBe(setupGuide(framework, false))
  })

  it("refuses an unknown framework", async () => {
    const result = await callTool("untrace_setup_guide", { framework: "cobol" })
    expect(result.isError).toBe(true)
  })
})

describe("HTTP edges", () => {
  it("GET, DELETE and PUT /mcp are 405 with Allow: POST", async () => {
    const { handle } = await worker()
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await handle(new Request(URL_MCP, { method, headers: { accept: "text/event-stream" } }), { RATE_LIMITER: limiter() })
      expect(res.status).toBe(405)
      expect(res.headers.get("allow")).toBe("POST, OPTIONS")
      expect(((await res.json()) as any).error.code).toBe(-32000)
    }
  })

  it("a CORS preflight from claude.ai is 204 with the MCP headers allowed, and answers carry CORS", async () => {
    const { handle } = await worker()
    const res = await handle(
      new Request(URL_MCP, {
        method: "OPTIONS",
        headers: { origin: "https://claude.ai", "access-control-request-method": "POST", "access-control-request-headers": "content-type, mcp-protocol-version" },
      }),
      { RATE_LIMITER: limiter() }
    )
    expect(res.status).toBe(204)
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
    expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/)
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Mcp-Protocol-Version/i)
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Content-Type/i)
    const ok = await post(rpc("ping"), { headers: PV })
    expect(ok.headers.get("access-control-allow-origin")).toBe("*")
    expect(ok.headers.get("cache-control")).toBe("no-store")
  })

  it("a body over 2.5 MB is 413: by Content-Length before any read, and when streamed without one", async () => {
    const { handle, MAX_BODY_BYTES } = await worker()
    expect(MAX_BODY_BYTES).toBe(2.5 * 1024 * 1024)
    // Declared too large: refused without touching the body (the stream is never pulled).
    let pulled = 0
    const never = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++
        c.enqueue(new Uint8Array(65536))
      },
    })
    const declared = new Request(URL_MCP, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT, "content-length": String(MAX_BODY_BYTES + 1) },
      body: never,
      duplex: "half",
    } as RequestInit)
    const byLength = await handle(declared, { RATE_LIMITER: limiter() })
    expect(byLength.status).toBe(413)
    expect(declared.bodyUsed).toBe(false)
    expect(pulled).toBeLessThanOrEqual(1) // at most the stream's own start-up pull, never read by the Worker

    const big = new TextEncoder().encode(JSON.stringify(rpc("tools/call", { name: "untrace_generate_link", arguments: { html: sized(2 * MAX_BODY_BYTES) } })))
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= big.length) return c.close()
        c.enqueue(big.subarray(sent, sent + 65536))
        sent += 65536
      },
    })
    const req = new Request(URL_MCP, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT, ...PV }, body: stream, duplex: "half" } as RequestInit)
    expect(req.headers.get("content-length")).toBeNull()
    const streamed = await handle(req, { RATE_LIMITER: limiter() })
    expect(streamed.status).toBe(413)
    expect(sent).toBeLessThan(big.length)
  })

  it("over the per-IP limit is 429 with a JSON-RPC error and Retry-After, keyed by CF-Connecting-IP", async () => {
    const lim = limiter(false)
    const res = await post(rpc("tools/list"), { env: { RATE_LIMITER: lim }, headers: PV })
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("60")
    const body = (await res.json()) as any
    expect(body.jsonrpc).toBe("2.0")
    expect(body.error.code).toBe(-32000)
    expect(body.error.message).toMatch(/60 a minute/)
    expect(lim.keys).toEqual([IP])
  })

  it("the limiter is checked before the body is read", async () => {
    const res = await post(null, { env: { RATE_LIMITER: limiter(false) }, raw: "{not json" })
    expect(res.status).toBe(429)
  })

  it("no binding (tests, local runs) means no limit, and a limiter outage does not block", async () => {
    expect((await post(rpc("ping"), { env: {}, headers: PV })).status).toBe(200)
    const down = { limit: async () => Promise.reject(new Error("down")) }
    expect((await post(rpc("ping"), { env: { RATE_LIMITER: down }, headers: PV })).status).toBe(200)
  })

  it("an unknown path is 404 JSON", async () => {
    const { handle } = await worker()
    for (const path of ["/", "/x", "/mcp/extra", "/healthz"]) {
      const res = await handle(new Request(`${ORIGIN}${path}`), { RATE_LIMITER: limiter() })
      expect(res.status, path).toBe(404)
      expect(await res.json()).toEqual({ error: "not_found" })
    }
  })
})

describe("privacy", () => {
  it("never writes to the console: not the body, not the link, not on errors", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const html = `<h1>Private plan</h1><p>MARKER-${Date.now()}</p>`
    await post(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))
    await gen({ html })
    await gen({ html: sized(MAX_GENERATE_HTML_BYTES + 1) })
    await gen({ html, path: "x" })
    await callTool("untrace_setup_guide", { framework: "node" })
    await post(rpc("tools/call", { name: "nope", arguments: {} }), { headers: PV })
    await post(null, { raw: "{not json" })
    await post(rpc("tools/list"), { headers: { "mcp-protocol-version": "2099-01-01" } })
    await post(rpc("tools/list"), { env: { RATE_LIMITER: limiter(false) } })
    await post(rpc("ping"), { env: { RATE_LIMITER: { limit: async () => Promise.reject(new Error("down")) } }, headers: PV })
    const { handle } = await worker()
    await handle(new Request(URL_MCP), {})
    await handle(new Request(`${ORIGIN}/health`), {})
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it("the Worker source has no console call, no storage and no outbound fetch", () => {
    for (const f of readdirSync(`${root}worker/src`).map((n) => `worker/src/${n}`).concat(["src/keyless.ts", "src/generate-link.ts", "src/refusal.ts", "src/templates/index.ts", "src/guide.ts"])) {
      expect(read(f), f).not.toMatch(/console\.|caches\.|\bfetch\((?!request: Request)|\bprocess\.(env|cwd)|["']node:/)
    }
  })

  it("wrangler.toml: no account id, no zone, no storage bindings, no vars, the rate limit matches the code", async () => {
    const { RATE_LIMIT_PER_MINUTE } = await worker()
    const toml = read("worker/wrangler.toml")
    const live = toml
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n")
    expect(live).not.toMatch(/account_id|zone_id|zone_name|kv_namespaces|r2_buckets|d1_databases|durable_objects|queues|analytics_engine|hyperdrive|services|\[vars\]|\[\[secrets|^routes|^route\b/m)
    expect(live).toMatch(/^workers_dev = false$/m)
    expect(live).toMatch(/\[\[ratelimits\]\]\s*\nname = "RATE_LIMITER"/)
    expect(live).toMatch(new RegExp(`limit = ${RATE_LIMIT_PER_MINUTE}\\s*\\n\\s*period = 60`))
    expect(RATE_LIMIT_PER_MINUTE).toBe(60)
    expect(live).toMatch(/\[observability\]\s*\nenabled = false/)
    expect(live).toMatch(/^compatibility_date = "\d{4}-\d{2}-\d{2}"$/m)
    expect(toml).toMatch(/^# routes = \[\{ pattern = "mcp\.untrace\.network", custom_domain = true \}\]$/m)
  })

  it("the Worker pulls in no Drive SDK, no secret redaction, no filesystem and no stdio server", () => {
    for (const f of [...readdirSync(`${root}worker/src`).map((n) => `worker/src/${n}`), "src/keyless.ts", "src/generate.ts", "src/templates/index.ts"]) {
      const imports = [...read(f).matchAll(/^import[^"]*"([^"]+)"/gm)].map((m) => m[1]!)
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/@untracenetwork\/sdk|\/redact$|\/errors$|\/server$|\/paths$|\/http$|^node:|express/)
    }
  })

  it("worker/README.md: no em dashes, says why the Drive tools are not hosted", () => {
    const r = read("worker/README.md")
    expect(r).not.toMatch(/\u2014/)
    expect(r).toMatch(/would have to hold each person's developer key/)
    expect(r).toContain("npx wrangler@4 deploy --config worker/wrangler.toml")
  })

  it("the Worker entry exports only the default handler", async () => {
    const mod = await import("../worker/src/index")
    expect(Object.keys(mod)).toEqual(["default"])
  })

  it("the npm package is unchanged: worker/ is not in files, the build entries or the tarball rules", () => {
    const p = JSON.parse(read("package.json"))
    expect(p.files).toEqual(["dist", "fonts", "README.md", "LICENSE", "llms.txt", "SKILL.md"])
    expect(read("tsup.config.ts")).not.toMatch(/worker/)
  })
})

describe("the official MCP client", () => {
  it("connects, lists the tools, gets a link and a guide, with no 4xx or 5xx", async () => {
    const { handle, HOSTED_TOOL_NAMES } = await worker()
    const statuses: string[] = []
    const env = { RATE_LIMITER: limiter() }
    const fetchToWorker = async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      const headers = new Headers(req.headers)
      headers.set("cf-connecting-ip", IP)
      const res = await handle(new Request(req, { headers }), env)
      statuses.push(`${req.method} ${res.status}`)
      return res
    }
    const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), { fetch: fetchToWorker as typeof fetch })
    const client = new Client({ name: "test", version: "1" })
    await client.connect(transport)
    expect(client.getServerVersion()).toMatchObject({ name: "untrace-mcp", version: pkg.version })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([...HOSTED_TOOL_NAMES])
    const result = (await client.callTool({ name: "untrace_generate_link", arguments: { html: ARABIC } })) as ToolResult
    expect(await decodeLink(JSON.parse(result.content[0]!.text).url)).toBe(ARABIC)
    const tpl = (await client.callTool({ name: "untrace_generate_link", arguments: { template: "mutual-nda" } })) as ToolResult
    expect(JSON.parse(tpl.content[0]!.text).template).toBe("mutual-nda")
    const guide = (await client.callTool({ name: "untrace_setup_guide", arguments: { framework: "nextjs" } })) as ToolResult
    expect(guide.content[0]!.text).toBe(setupGuide("nextjs", true))
    await client.ping()
    await client.close()
    expect(statuses.filter((s) => /^POST [45]/.test(s))).toEqual([])
    expect(statuses).toContain("POST 202")
    expect(env.RATE_LIMITER.keys.every((k) => k === IP)).toBe(true)
  })
})
