/**
 * untrace_generate_link: the link opens the document in Drive's editor at /generate. The
 * decoder below is written independently, the way a browser reads the fragment: base64url with
 * atob, then the web DecompressionStream("deflate-raw").
 */
import { mkdir, symlink, writeFile, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { UntraceClient } from "@untracenetwork/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MAX_GENERATE_HTML_BYTES, MAX_GENERATE_PAYLOAD_CHARS, buildGenerateLink, encodeGeneratePayload } from "../src/generate"
import { createServer, type UntraceLike } from "../src/server"
import { harness } from "./helpers"
import { BASE, CLIENT_ID, SECRET, createMockDrive } from "./mock-drive"

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.UNTRACE_BASE_URL
  delete process.env.UNTRACE_CLIENT_ID
  delete process.env.UNTRACE_CLIENT_SECRET
})
afterEach(() => {
  process.env = { ...saved }
  vi.restoreAllMocks()
})

// ---- an independent, browser-style decoder ----

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decodeLink(url: string): Promise<{ format: string; bytes: Uint8Array; payload: string }> {
  const hash = new URL(url).hash.slice(1)
  const m = /^(doc|html)=(.*)$/s.exec(hash)
  if (!m) throw new Error("no doc= or html= in the fragment")
  const raw = b64urlToBytes(m[2]!)
  return { format: m[1]!, payload: m[2]!, bytes: m[1] === "doc" ? await inflateRaw(raw) : raw }
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b))

// ---- documents ----

function prng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const WORDS =
  "market revenue customers growth pricing churn margin cohort funnel retention budget hiring roadmap launch partner channel forecast quarter runway segment pipeline onboarding support compliance storage encryption team milestone risk".split(" ")

/** A multi-page business plan of about `target` bytes: headings, paragraphs, lists and tables. */
function businessPlan(target: number): string {
  const rnd = prng(42)
  const word = () => WORDS[Math.floor(rnd() * WORDS.length)]!
  const sentence = () => {
    const n = 8 + Math.floor(rnd() * 14)
    const w = Array.from({ length: n }, word).join(" ")
    return `${w[0]!.toUpperCase()}${w.slice(1)} ${Math.floor(rnd() * 9000 + 100)}.`
  }
  const parts = ['<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Business plan 2027</title></head><body>']
  let page = 1
  while (parts.join("").length < target) {
    parts.push(`<section style="page-break-after:always"><h1>${page}. ${word()} plan</h1>`)
    for (let p = 0; p < 6; p++) parts.push(`<p>${Array.from({ length: 5 }, sentence).join(" ")}</p>`)
    parts.push(`<h2>Key points</h2><ul>${Array.from({ length: 6 }, () => `<li>${sentence()}</li>`).join("")}</ul>`)
    parts.push('<table style="border-collapse:collapse"><tr><th>Quarter</th><th>Revenue</th><th>Customers</th><th>Margin</th></tr>')
    for (let q = 1; q <= 8; q++) {
      parts.push(`<tr><td>Q${q}</td><td>$${Math.floor(rnd() * 900000)}</td><td>${Math.floor(rnd() * 5000)}</td><td>${(rnd() * 80).toFixed(1)}%</td></tr>`)
    }
    parts.push("</table></section>")
    page++
  }
  parts.push("</body></html>")
  return parts.join("")
}

const ASCII = "<h1>Plan</h1><p>Plain ASCII, with &amp; entities and <b>bold</b>.</p>"
const ARABIC_EMOJI = '<html dir="rtl"><body><h1>خطة العمل</h1><p>مرحبا بالعالم 👋🏽 ✅ 🇱🇧 — “quotes” 日本語</p><p>𝔘𝔫𝔦𝔠𝔬𝔡𝔢 and a ZWJ family 👨‍👩‍👧‍👦</p></body></html>'
const PLAN = businessPlan(300_000)

/** Random text over 64 characters: about 6 bits a character, so deflate cannot shrink it much. */
function noise(chars: number, seed = 7): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ."
  const rnd = prng(seed)
  let s = ""
  for (let i = 0; i < chars; i++) s += A[Math.floor(rnd() * 64)]
  return s
}

// ---- tests ----

type H = Awaited<ReturnType<typeof harness>>
let h: H
afterEach(async () => {
  await h?.close()
  h = undefined as unknown as H
})

describe("untrace_generate_link: round trip", () => {
  const docs: Array<[string, string]> = [
    ["ASCII", ASCII],
    ["Arabic and emoji UTF-8", ARABIC_EMOJI],
    ["a ~300 KB business plan", PLAN],
  ]
  for (const format of ["doc", "html"] as const) {
    it.each(docs)(`${format}: %s decodes back to the same bytes`, async (_name, html) => {
      h = await harness()
      const r = await h.call("untrace_generate_link", { html, format })
      expect(r.isError).toBe(false)
      const out = JSON.parse(r.content[0]!.text!)
      expect(out.format).toBe(format)
      expect(out.htmlBytes).toBe(utf8(html).byteLength)
      expect(out.urlChars).toBe(out.url.length)
      expect(out.url.startsWith(`https://drive.untrace.network/generate#${format}=`)).toBe(true)
      const d = await decodeLink(out.url)
      expect(d.format).toBe(format)
      expect(same(d.bytes, utf8(html))).toBe(true)
      expect(new TextDecoder("utf-8", { fatal: true }).decode(d.bytes)).toBe(html)
      expect(d.payload).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(d.payload).not.toContain("=")
    })
  }

  it("doc is the default, and the answer says how to open it", async () => {
    h = await harness()
    const r = await h.call("untrace_generate_link", { html: ASCII })
    expect(JSON.parse(r.content[0]!.text!).format).toBe("doc")
    expect(r.content[1]!.text).toMatch(/Open the url in a browser.*nothing is uploaded until the person presses Split & Upload/)
  })

  it("the 300 KB plan compresses to a short link", () => {
    expect(PLAN.length).toBeGreaterThan(290_000)
    const doc = buildGenerateLink(PLAN, { format: "doc", origin: "https://drive.untrace.network" })
    const plain = buildGenerateLink(PLAN, { format: "html", origin: "https://drive.untrace.network" })
    expect(doc.urlChars).toBeLessThan(plain.urlChars / 2)
    expect(doc.urlChars).toBeLessThan(MAX_GENERATE_PAYLOAD_CHARS / 10)
  })

  it("points at UNTRACE_BASE_URL's origin (path and trailing slash dropped)", async () => {
    process.env.UNTRACE_BASE_URL = "https://staging.untrace.network/some/path/"
    h = await harness()
    const r = await h.call("untrace_generate_link", { html: ASCII })
    const url = JSON.parse(r.content[0]!.text!).url as string
    expect(url.startsWith("https://staging.untrace.network/generate#doc=")).toBe(true)
    expect(same((await decodeLink(url)).bytes, utf8(ASCII))).toBe(true)
  })

  it("payload alphabet: only A-Z a-z 0-9 _ - for every length mod 3", () => {
    for (let n = 1; n <= 12; n++) {
      for (const f of ["doc", "html"] as const) {
        const p = encodeGeneratePayload(utf8("é".repeat(n) + "?>~".repeat(n)), f)
        expect(p).toMatch(/^[A-Za-z0-9_-]+$/)
      }
    }
  })
})

describe("untrace_generate_link: limits", () => {
  const O = "https://drive.untrace.network"

  it("2 MiB of HTML passes in doc format; one byte more is refused", () => {
    const pad = (n: number) => `<p>${"a".repeat(n - 7)}</p>`
    const ok = buildGenerateLink(pad(MAX_GENERATE_HTML_BYTES), { format: "doc", origin: O })
    expect(ok.htmlBytes).toBe(MAX_GENERATE_HTML_BYTES)
    expect(() => buildGenerateLink(pad(MAX_GENERATE_HTML_BYTES + 1), { format: "doc", origin: O })).toThrow(/2097153 bytes.*at most 2097152 bytes \(2 MB\)/)
  })

  it("the 2 MiB cap counts UTF-8 bytes, not characters", () => {
    const arabic = "م".repeat(MAX_GENERATE_HTML_BYTES / 2) // 2 bytes each: exactly 2 MiB
    expect(buildGenerateLink(arabic, { format: "doc", origin: O }).htmlBytes).toBe(MAX_GENERATE_HTML_BYTES)
    expect(() => buildGenerateLink(`${arabic}x`, { format: "doc", origin: O })).toThrow(/at most 2097152 bytes/)
  })

  it("html format: 1,500,000 payload characters pass, 1,500,002 are refused and point to doc", () => {
    const atCap = (MAX_GENERATE_PAYLOAD_CHARS / 4) * 3 // 1,125,000 bytes -> exactly 1,500,000 characters
    const ok = buildGenerateLink("a".repeat(atCap), { format: "html", origin: O })
    expect(ok.url.length - `${O}/generate#html=`.length).toBe(MAX_GENERATE_PAYLOAD_CHARS)
    expect(() => buildGenerateLink("a".repeat(atCap + 1), { format: "html", origin: O })).toThrow(/1500002 characters.*at most 1500000.*Use format "doc"/)
    // The same document fits easily as doc.
    expect(buildGenerateLink("a".repeat(atCap + 1), { format: "doc", origin: O }).urlChars).toBeLessThan(10_000)
  })

  it("doc format: a payload just under 1,500,000 characters passes, the next one is refused", () => {
    const text = noise(1_700_000)
    const len = (n: number) => encodeGeneratePayload(utf8(text.slice(0, n)), "doc").length
    expect(len(text.length)).toBeGreaterThan(MAX_GENERATE_PAYLOAD_CHARS)
    // Find n where n fits and n + 1 does not.
    let lo = 1_000_000
    let hi = text.length
    expect(len(lo)).toBeLessThanOrEqual(MAX_GENERATE_PAYLOAD_CHARS)
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (len(mid) <= MAX_GENERATE_PAYLOAD_CHARS) lo = mid
      else hi = mid
    }
    const ok = buildGenerateLink(text.slice(0, lo), { format: "doc", origin: O })
    expect(ok.url.length - `${O}/generate#doc=`.length).toBeLessThanOrEqual(MAX_GENERATE_PAYLOAD_CHARS)
    expect(ok.htmlBytes).toBeLessThan(MAX_GENERATE_HTML_BYTES)
    expect(() => buildGenerateLink(text.slice(0, hi), { format: "doc", origin: O })).toThrow(/at most 1500000\. Even compressed it is too long/)
  })

  it("a refusal through the tool never repeats the document", async () => {
    h = await harness()
    const marker = "MARKER-do-not-echo-7f3a"
    const big = `<p>${marker}</p>${"a".repeat(MAX_GENERATE_HTML_BYTES)}`
    const r = await h.call("untrace_generate_link", { html: big })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^refused: Refused: .*at most 2097152 bytes/)
    expect(r.text).not.toContain(marker)
    const r2 = await h.call("untrace_generate_link", { html: "a".repeat(1_200_000) + marker, format: "html" })
    expect(r2.text).toMatch(/^refused: Refused: .*Use format "doc"/)
    expect(r2.text).not.toContain(marker)
  })

  it("an empty or blank document is refused", async () => {
    h = await harness()
    expect((await h.call("untrace_generate_link", { html: "   \n" })).text).toMatch(/^refused: Refused: .*empty/)
  })
})

describe("untrace_generate_link: input", () => {
  it("needs exactly one of html or path", async () => {
    h = await harness()
    await h.write("a.html", ASCII)
    expect((await h.call("untrace_generate_link", {})).text).toMatch(/^refused: Refused: give exactly one of html or path/)
    expect((await h.call("untrace_generate_link", { html: ASCII, path: "a.html" })).text).toMatch(/^refused: Refused: give exactly one of html or path/)
  })

  it("rejects an unknown format", async () => {
    h = await harness()
    const r = await h.call("untrace_generate_link", { html: ASCII, format: "pdf" }).catch((e: Error) => ({ isError: true, text: e.message }))
    expect(r.isError).toBe(true)
  })

  it("path: reads a .html or .htm file inside the root", async () => {
    h = await harness()
    await h.mkdir("docs")
    await h.write("docs/plan.html", PLAN)
    await h.write("letter.HTM", ARABIC_EMOJI)
    for (const [p, html] of [["docs/plan.html", PLAN], [join(h.root, "letter.HTM"), ARABIC_EMOJI]] as const) {
      const r = await h.call("untrace_generate_link", { path: p })
      expect(r.isError).toBe(false)
      const out = JSON.parse(r.content[0]!.text!)
      expect(same((await decodeLink(out.url)).bytes, utf8(html))).toBe(true)
    }
  })

  describe("path refusals", () => {
    let outside: string
    beforeEach(async () => {
      h = await harness()
      outside = await realpath(await mkdtemp(join(tmpdir(), "untrace-gen-outside-")))
      await writeFile(join(outside, "x.html"), "<p>outside</p>")
    })
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true })
    })

    it.each(["../x.html", "a/../../x.html", "/etc/passwd"])("refuses %s (outside the root)", async (p) => {
      expect((await h.call("untrace_generate_link", { path: p })).text).toMatch(/^path_refused:/)
    })

    it("refuses an absolute path outside the root", async () => {
      expect((await h.call("untrace_generate_link", { path: join(outside, "x.html") })).text).toMatch(/^path_refused:.*outside the allowed folder/s)
    })

    it("refuses a symlink that leads outside the root", async () => {
      await symlink(join(outside, "x.html"), join(h.root, "link.html"))
      expect((await h.call("untrace_generate_link", { path: "link.html" })).text).toMatch(/^path_refused:.*symlink/s)
    })

    it("refuses a file that is not .html or .htm", async () => {
      await h.write("notes.txt", ASCII)
      expect((await h.call("untrace_generate_link", { path: "notes.txt" })).text).toMatch(/^refused: Refused: notes\.txt is not an \.html or \.htm file/)
    })

    it("refuses a folder, a missing file, a file over 2 MiB and a file that is not UTF-8", async () => {
      await mkdir(join(h.root, "dir.html"))
      expect((await h.call("untrace_generate_link", { path: "dir.html" })).text).toMatch(/^refused: Refused: dir\.html is not a regular file/)
      expect((await h.call("untrace_generate_link", { path: "missing.html" })).text).toMatch(/^file_missing:/)
      await h.write("big.html", "a".repeat(MAX_GENERATE_HTML_BYTES + 1))
      expect((await h.call("untrace_generate_link", { path: "big.html" })).text).toMatch(/^refused: Refused: big\.html is 2097153 bytes/)
      await h.write("latin1.html", new Uint8Array([0x3c, 0x70, 0x3e, 0xe9, 0x3c]))
      expect((await h.call("untrace_generate_link", { path: "latin1.html" })).text).toMatch(/^refused: Refused: latin1\.html is not UTF-8/)
    })

    it("refuses path when local paths are off (remote server); html still works", async () => {
      await h.close()
      h = await harness({ root: false })
      expect((await h.call("untrace_generate_link", { path: "a.html" })).text).toMatch(/^refused: Refused: local paths are turned off/)
      expect((await h.call("untrace_generate_link", { html: ASCII })).isError).toBe(false)
    })
  })
})

describe("untrace_generate_link: no network, no key, nothing logged", () => {
  it("makes zero requests: fetch is never called and the mock Drive records nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const drive = createMockDrive()
    const client = new UntraceClient({ clientId: CLIENT_ID, clientSecret: SECRET, baseUrl: BASE, fetch: drive.handler, maxRetries: 0 })
    const factory = vi.fn(() => client as unknown as UntraceLike)
    h = await harness({ client: factory })
    await h.write("plan.html", PLAN)
    for (const args of [{ html: PLAN }, { html: ARABIC_EMOJI, format: "html" }, { path: "plan.html" }]) {
      expect((await h.call("untrace_generate_link", args)).isError).toBe(false)
    }
    expect(drive.requests).toHaveLength(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(factory).not.toHaveBeenCalled()
  })

  it("works with no credentials at all, with the default client", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const server = createServer({ root: false })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: "test", version: "0.0.0" })
    await Promise.all([server.connect(a), mcp.connect(b)])
    try {
      const r = (await mcp.callTool({ name: "untrace_generate_link", arguments: { html: ARABIC_EMOJI } })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(r.isError).toBeFalsy()
      expect(same((await decodeLink(JSON.parse(r.content[0]!.text).url)).bytes, utf8(ARABIC_EMOJI))).toBe(true)
      // A file tool on the same server does need the key, and says so.
      const l = (await mcp.callTool({ name: "untrace_list", arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(l.isError).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await mcp.close()
    }
  })

  it("nothing from the document or the link reaches stderr, stdout or the console", async () => {
    const marker = "MARKER-private-draft-91c2"
    const html = `<h1>${marker}</h1>${PLAN}`
    const seen: string[] = []
    const grab = (...a: unknown[]) => {
      seen.push(a.map(String).join(" "))
      return true
    }
    vi.spyOn(process.stderr, "write").mockImplementation(grab as never)
    vi.spyOn(process.stdout, "write").mockImplementation(grab as never)
    for (const m of ["log", "error", "warn", "info", "debug", "trace"] as const) vi.spyOn(console, m).mockImplementation(grab as never)
    h = await harness()
    await h.write("draft.html", html)
    const outs: string[] = []
    for (const args of [{ html }, { html, format: "html" }, { path: "draft.html" }]) {
      const r = await h.call("untrace_generate_link", args)
      expect(r.isError).toBe(false)
      outs.push(JSON.parse(r.content[0]!.text!).url)
    }
    await h.call("untrace_generate_link", { html: `${marker}${"a".repeat(MAX_GENERATE_HTML_BYTES)}` })
    vi.restoreAllMocks()
    const all = seen.join("\n")
    expect(all).not.toContain(marker)
    for (const url of outs) {
      const payload = url.split("=")[1]!
      expect(all).not.toContain(payload.slice(0, 64))
    }
  })
})
