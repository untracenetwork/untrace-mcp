/**
 * untrace_generate_link with template and fields. The templates are the same HTML as Drive's
 * editor; their sha256 is pinned below so any drift shows up as a failing test.
 */
import { createHash } from "node:crypto"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  GENERATE_TEMPLATES,
  MAX_FIELDS,
  MAX_FIELD_VALUE_CHARS,
  NDA_SOURCE,
  TEMPLATE_IDS,
  fillTemplate,
  templateById,
  templateFields,
} from "../src/templates"
import { harness } from "./helpers"

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.UNTRACE_BASE_URL
  delete process.env.UNTRACE_CLIENT_ID
  delete process.env.UNTRACE_CLIENT_SECRET
})
afterEach(() => {
  process.env = { ...saved }
})

type H = Awaited<ReturnType<typeof harness>>
let h: H
afterEach(async () => {
  await h?.close()
  h = undefined as unknown as H
})

// ---- an independent, browser-style decoder ----

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function decodeLink(url: string): Promise<string> {
  const m = /^(doc|html)=(.*)$/s.exec(new URL(url).hash.slice(1))
  if (!m) throw new Error("no doc= or html= in the fragment")
  let bytes = b64urlToBytes(m[2]!)
  if (m[1] === "doc") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
const tpl = (id: string) => templateById(id)!

// ---- pins ----

/** sha256 of each template's HTML (UTF-8), the same bytes as Drive's editor templates. */
const PINS: Record<string, { sha256: string; bytes: number }> = {
  "mutual-nda": { sha256: "32c1403566bf513d8fab9a7bdb6e7d3fe960319b72d3c0f2283fd1040f993c85", bytes: 10_076 },
  invoice: { sha256: "1b8a505d71ce813c90fc62bf4ac01ddaed9361b6f7014b1348422e13c989044b", bytes: 2_072 },
  "proposal-quote": { sha256: "47ca31724b6956ed0b5a962d1dd4a1a2987b9583d72716fc5d8270d7c3b1c2b4", bytes: 2_501 },
  letter: { sha256: "41a9c3bcb520f41923d48f2f1e3738e21b6eee4a7ff79c2940bc5a70bcdca4be", bytes: 854 },
  "meeting-minutes": { sha256: "a6d0b14abc978d5911508010f5ec3089ed0af86116128a3e868c72c1ea615140", bytes: 1_684 },
}

describe("templates: the bundled HTML", () => {
  it("has exactly the five ids, in the editor's order", () => {
    expect(GENERATE_TEMPLATES.map((t) => t.id)).toEqual(["mutual-nda", "invoice", "proposal-quote", "letter", "meeting-minutes"])
    expect([...TEMPLATE_IDS]).toEqual(GENERATE_TEMPLATES.map((t) => t.id))
    for (const t of GENERATE_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
    }
  })

  it.each(Object.entries(PINS))("%s: sha256 and size are pinned", (id, pin) => {
    const html = tpl(id).html
    expect(sha256(html)).toBe(pin.sha256)
    expect(new TextEncoder().encode(html).byteLength).toBe(pin.bytes)
  })

  it("the NDA keeps the Common Paper CC BY 4.0 credit line, on the cover page and after the standard terms", () => {
    const html = tpl("mutual-nda").html
    expect(html).toContain(
      "<p><small>Common Paper Mutual Non-Disclosure Agreement (Version 1.0) free to use under CC BY 4.0 (creativecommons.org/licenses/by/4.0).</small></p>"
    )
    expect(html).toContain(
      "<p><small>Common Paper Mutual Non-Disclosure Agreement Version 1.0 free to use under CC BY 4.0 (creativecommons.org/licenses/by/4.0).</small></p>"
    )
    expect(NDA_SOURCE).toEqual({
      name: "Common Paper Mutual Non-Disclosure Agreement",
      version: "1.0",
      licence: "CC BY 4.0",
      repo: "CommonPaper/Mutual-NDA",
      commit: "2a3068b6c0ab6015c440f541d5b215bc3ac2f4cb",
    })
  })

  it("holds no URL, script, style or event attribute", () => {
    for (const t of GENERATE_TEMPLATES) {
      expect(t.html).not.toMatch(/https?:|<script|<style|\son\w+=|href=|src=/i)
    }
  })
})

// ---- the tool ----

describe("untrace_generate_link: template, no fields", () => {
  it.each([...TEMPLATE_IDS])("%s: the link opens exactly the template, and fieldsLeft lists every field", async (id) => {
    h = await harness()
    for (const format of ["doc", "html"] as const) {
      const r = await h.call("untrace_generate_link", { template: id, format })
      expect(r.isError).toBe(false)
      const out = JSON.parse(r.content[0]!.text!)
      expect(out.template).toBe(id)
      expect(out.format).toBe(format)
      expect(out.fieldsFilled).toBe(0)
      expect(out.fieldsLeft).toEqual(templateFields(tpl(id).html))
      expect(out.fieldsLeft.length).toBeGreaterThan(0)
      expect(out.htmlBytes).toBe(PINS[id]!.bytes)
      expect(out.url.startsWith(`https://drive.untrace.network/generate#${format}=`)).toBe(true)
      expect(await decodeLink(out.url)).toBe(tpl(id).html)
    }
  })

  it("an empty fields object is the blank template too", async () => {
    h = await harness()
    const r = await h.call("untrace_generate_link", { template: "letter", fields: {} })
    expect(r.isError).toBe(false)
    expect(await decodeLink(r.json?.url ?? JSON.parse(r.content[0]!.text!).url)).toBe(tpl("letter").html)
  })

  it("fieldsLeft is in document order, each name once", () => {
    const left = templateFields(tpl("letter").html)
    expect(left.slice(0, 5)).toEqual(["Your name or business name", "Street address", "City, postal code, country", "Email", "Phone"])
    expect(new Set(left).size).toBe(left.length)
    // "Recipient name" appears twice in the letter, once in fieldsLeft.
    expect(tpl("letter").html.split("<mark>[Recipient name]</mark>").length - 1).toBe(2)
    expect(left.filter((f) => f === "Recipient name")).toHaveLength(1)
  })
})

describe("untrace_generate_link: filling fields", () => {
  it("a value replaces every copy of its field, unmarked, and fieldsLeft drops it", async () => {
    h = await harness()
    const r = await h.call("untrace_generate_link", { template: "letter", fields: { "Recipient name": "Maya Haddad", Date: "14 November 2026" } })
    expect(r.isError).toBe(false)
    const out = JSON.parse(r.content[0]!.text!)
    expect(out.fieldsFilled).toBe(2)
    expect(out.fieldsLeft).not.toContain("Recipient name")
    expect(out.fieldsLeft).not.toContain("Date")
    expect(out.fieldsLeft).toEqual(templateFields(tpl("letter").html).filter((f) => f !== "Recipient name" && f !== "Date"))
    const html = await decodeLink(out.url)
    expect(html).not.toContain("[Recipient name]")
    expect(html).not.toContain("[Date]")
    expect(html).toContain("<p><strong>Maya Haddad</strong><br>")
    expect(html).toContain("<p>Dear Maya Haddad,</p>")
    expect(html).toContain("<p>14 November 2026</p>")
    expect(html.split("Maya Haddad").length - 1).toBe(2)
    // Everything else is the template, byte for byte.
    expect(html).toBe(tpl("letter").html.replaceAll("<mark>[Recipient name]</mark>", "Maya Haddad").replace("<mark>[Date]</mark>", "14 November 2026"))
  })

  it("NDA: a party field keyed as written inside the brackets", async () => {
    h = await harness()
    const r = await h.call("untrace_generate_link", { template: "mutual-nda", fields: { "Party 1 company": "Acme Ltd" } })
    const out = JSON.parse(r.content[0]!.text!)
    const html = await decodeLink(out.url)
    expect(html).toContain("<td>Acme Ltd</td>")
    expect(html).not.toContain("[Party 1 company]")
    expect(out.fieldsLeft).toContain("Party 2 company")
  })

  it("values are HTML-escaped: <script> arrives as text", async () => {
    h = await harness()
    const value = `<script>alert("x")</script> & 'Tom' <b>`
    const r = await h.call("untrace_generate_link", { template: "letter", fields: { Subject: value } })
    expect(r.isError).toBe(false)
    const html = await decodeLink(JSON.parse(r.content[0]!.text!).url)
    expect(html).toContain("<p><strong>Subject: &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Tom&#39; &lt;b&gt;</strong></p>")
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<b>")
  })

  it("a value that looks like a field is not filled again", () => {
    const f = fillTemplate(tpl("letter"), { Subject: "<mark>[Date]</mark>", Date: "today" })
    expect(f.html).toContain("Subject: &lt;mark&gt;[Date]&lt;/mark&gt;")
    expect(f.html).toContain("<p>today</p>")
  })

  it("an empty value leaves the field highlighted and counts as not filled", async () => {
    h = await harness()
    const r = await h.call("untrace_generate_link", { template: "letter", fields: { Subject: "", Date: "Monday" } })
    const out = JSON.parse(r.content[0]!.text!)
    expect(out.fieldsFilled).toBe(1)
    expect(out.fieldsLeft).toContain("Subject")
    expect(out.fieldsLeft).not.toContain("Date")
    expect(await decodeLink(out.url)).toContain("<mark>[Subject]</mark>")
  })

  it("filling every field leaves fieldsLeft empty and no mark in the document", () => {
    for (const t of GENERATE_TEMPLATES) {
      const all = Object.fromEntries(templateFields(t.html).map((k, i) => [k, `v${i}`]))
      const f = fillTemplate(t, all)
      expect(f.fieldsLeft).toEqual([])
      expect(f.fieldsFilled).toBe(Object.keys(all).length)
      expect(f.html).not.toContain("<mark>")
    }
  })
})

describe("untrace_generate_link: template refusals", () => {
  const SECRET_VALUE = "VALUE-do-not-echo-91c2"

  it("exactly one of html, path or template", async () => {
    h = await harness()
    await h.write("a.html", "<p>a</p>")
    for (const args of [{}, { html: "<p>a</p>", template: "letter" }, { path: "a.html", template: "letter" }, { html: "<p>a</p>", path: "a.html", template: "letter" }]) {
      const r = await h.call("untrace_generate_link", args)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^refused: Refused: give exactly one of html, path or template\./)
    }
  })

  it("fields without template are refused, and the value is not repeated", async () => {
    h = await harness()
    await h.write("a.html", "<p>a</p>")
    for (const args of [{ html: "<p>a</p>" }, { path: "a.html" }]) {
      const r = await h.call("untrace_generate_link", { ...args, fields: { Subject: SECRET_VALUE } })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^refused: Refused: fields works only with template\./)
      expect(r.text).not.toContain(SECRET_VALUE)
    }
  })

  it("an unknown template id is refused", async () => {
    h = await harness()
    const r = await h.call("untrace_generate_link", { template: "lease" }).catch((e: Error) => ({ isError: true, text: e.message }))
    expect(r.isError).toBe(true)
  })

  it("an unknown field is refused by name, never with its value", async () => {
    h = await harness()
    const r = await h.call("untrace_generate_link", { template: "letter", fields: { Subject: SECRET_VALUE, "Party 1 company": SECRET_VALUE } })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^refused: Refused: this field is not in template letter: "Party 1 company"\. Call with template only/)
    expect(r.text).not.toContain(SECRET_VALUE)
  })

  it("more than 200 fields are refused; 200 known-or-not keys reach the name check", async () => {
    h = await harness()
    const many = Object.fromEntries(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => [`k${i}`, SECRET_VALUE]))
    const r = await h.call("untrace_generate_link", { template: "invoice", fields: many })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/^refused: Refused: at most 200 fields in one call \(got 201\)\./)
    expect(r.text).not.toContain(SECRET_VALUE)
    const atCap = Object.fromEntries(Array.from({ length: MAX_FIELDS }, (_, i) => [`k${i}`, SECRET_VALUE]))
    const r2 = await h.call("untrace_generate_link", { template: "invoice", fields: atCap })
    expect(r2.text).toMatch(/^refused: Refused: these fields are not in template invoice: "k0", .*"k9" and 190 more\./)
    expect(r2.text).not.toContain(SECRET_VALUE)
  })

  it("a value of 2,000 characters passes; 2,001 is refused without repeating it", async () => {
    h = await harness()
    const ok = "a".repeat(MAX_FIELD_VALUE_CHARS - SECRET_VALUE.length) + SECRET_VALUE
    const r = await h.call("untrace_generate_link", { template: "letter", fields: { Subject: ok } })
    expect(r.isError).toBe(false)
    expect(await decodeLink(JSON.parse(r.content[0]!.text!).url)).toContain(ok)
    const r2 = await h.call("untrace_generate_link", { template: "letter", fields: { Subject: ok + "b" } })
    expect(r2.isError).toBe(true)
    expect(r2.text).toMatch(/^refused: Refused: the value of field "Subject" is 2001 characters\. A field holds at most 2000\./)
    expect(r2.text).not.toContain(SECRET_VALUE)
  })

  it("a non-text value is refused without repeating it", async () => {
    h = await harness()
    const r = await h
      .call("untrace_generate_link", { template: "letter", fields: { Subject: { nested: SECRET_VALUE } } })
      .catch((e: Error) => ({ isError: true, text: e.message }))
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain(SECRET_VALUE)
  })

  it("no refusal message ever contains a field value", () => {
    const cases: Array<Record<string, string>> = [
      { Nope: SECRET_VALUE },
      { Subject: SECRET_VALUE.repeat(300) },
      Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`x${i}`, SECRET_VALUE])),
    ]
    for (const fields of cases) {
      let msg = ""
      try {
        fillTemplate(tpl("letter"), fields)
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).toMatch(/^Refused: /)
      expect(msg).not.toContain(SECRET_VALUE)
    }
  })
})
