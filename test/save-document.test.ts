/**
 * untrace_save_document: HTML to a PDF (rendered here) to the user's Drive (uploaded with this
 * server's key). Covers the HTML mapping against Drive's own editor output, the limits (256 KB of
 * HTML, 10 pages), that the PDF is a valid file with the right page count, the upload call, the
 * end-to-end path through the real SDK, and redaction on errors.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { CLIENT_SECRET_PREFIX, UntraceClient, UntraceServerError } from "@untracenetwork/sdk"
import { PDFDocument } from "pdf-lib"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { documentTitle, htmlToBlocks, pdfFileName, type DocNode } from "../src/doc-blocks"
import { PAPERS, isNumericCell, mmToPt } from "../src/doc-pdf"
import { MAX_SAVE_HTML_BYTES, MAX_SAVE_PAGES, buildDocumentPdf, driveFileUrl } from "../src/save-document"
import type { UntraceLike } from "../src/server"
import { FOLDER_ID, SECRET, harness, mockClient } from "./helpers"
import { BASE, CLIENT_ID, FOLDER_ID as MOCK_FOLDER, SECRET as MOCK_SECRET, createMockDrive } from "./mock-drive"

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/drive-generate-corpus.json", import.meta.url)), "utf8")) as {
  cases: Record<string, { html: string; value: DocNode[] }>
}

/** Same shape as Drive's editor value: marks only when set, spans as numbers. */
function norm(n: any): any {
  if (typeof n.text === "string") {
    const o: Record<string, unknown> = { text: n.text }
    for (const k of ["bold", "italic", "underline", "strikethrough", "code", "subscript", "superscript", "highlight"]) if (n[k]) o[k] = true
    return o
  }
  const o: Record<string, unknown> = { type: n.type }
  const cs = n.colSpan ?? Number(n.attributes?.colspan)
  const rs = n.rowSpan ?? Number(n.attributes?.rowspan)
  if (Number.isInteger(cs) && cs > 1 && cs <= 50) o.colSpan = cs
  if (Number.isInteger(rs) && rs > 1 && rs <= 500) o.rowSpan = rs
  o.children = n.children.map(norm)
  return o
}

/**
 * Where this renderer differs from Drive's editor on purpose. Drive keeps a table caption as the
 * table's first child (the print view then shows it inside the table); here it is a paragraph
 * above the table. Drive keeps only the last paragraph of a list item that holds a heading and a
 * paragraph; here no text is lost.
 */
const DIFFERS = new Set(["tables", "li_with_blocks"])

const PDF_MAGIC = "%PDF-"
const pages = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount()
const para = (i: number) => `<p>Paragraph ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(4)}</p>`

describe("HTML to document blocks (Drive's Generate editor corpus)", () => {
  const names = Object.keys(corpus.cases)
  it("the corpus is loaded", () => {
    expect(names.length).toBeGreaterThanOrEqual(40)
  })

  it.each(names.filter((n) => !DIFFERS.has(n)))("%s maps like Drive's editor", (name) => {
    const c = corpus.cases[name]!
    expect(htmlToBlocks(c.html).map(norm)).toEqual(c.value.map(norm))
  })

  it("a caption becomes a paragraph above the table, and a list item keeps all its text", () => {
    const t = htmlToBlocks(corpus.cases.tables!.html).map(norm)
    expect(t[0]).toEqual({ type: "p", children: [{ text: "Cap" }] })
    expect(t[1].type).toBe("table")
    expect(t[1].children).toHaveLength(4)
    expect(htmlToBlocks(corpus.cases.li_with_blocks!.html).map(norm)).toEqual([
      { type: "ul", children: [{ type: "li", children: [{ type: "lic", children: [{ text: "Head in li\np in li" }] }] }] },
    ])
  })

  it("marks, links, images and dangerous tags", () => {
    const b = htmlToBlocks('<p><a href="https://x.example">site</a> <img src="https://x.example/a.png"> <b><i>bi</i></b></p><script>alert(1)</script><iframe src="https://x.example"></iframe>')
    expect(b.map(norm)).toEqual([{ type: "p", children: [{ text: "site " }, { text: "bi", bold: true, italic: true }] }])
  })

  it("break-before: page starts a new page block", () => {
    const b = htmlToBlocks('<p>one</p><h2 style="break-before: page">two</h2><div style="page-break-after: always">three</div><p>four</p>')
    expect(b.map((x) => [x.type, Boolean(x.breakBefore)])).toEqual([
      ["p", false],
      ["h2", true],
      ["p", false],
      ["p", true],
    ])
  })

  it("names the file after the first heading, like Drive", () => {
    expect(documentTitle(htmlToBlocks("<p>intro</p><h2>Q3 <em>plan</em></h2>"))).toBe("Q3 plan")
    expect(pdfFileName("a/b: c?")).toBe("a b c.pdf")
    expect(pdfFileName("report.pdf")).toBe("report.pdf")
    expect(pdfFileName(null)).toBe("Untitled document.pdf")
    expect(pdfFileName("x".repeat(200))).toBe(`${"x".repeat(80)}.pdf`)
  })

  it("numeric cells follow Drive's rule", () => {
    for (const v of ["1,200", "$1,200.50", "(42)", "12%", "EUR 9", "-3"]) expect(isNumericCell(v)).toBe(true)
    for (const v of ["", "Year", "v2", "1 2"]) expect(isNumericCell(v)).toBe(false)
  })
})

describe("the PDF", () => {
  it("is a valid PDF that pdf-lib reloads, with the page count it reports and Drive's paper size", async () => {
    const html = `<h1>Report</h1><p>Hello <b>bold</b> <code>code</code> <mark>m</mark></p><ul><li>a<ul><li>b</li></ul></li></ul><ol><li>c</li></ol><blockquote>q</blockquote><hr><table><tr><th>Year</th><th>Total</th></tr><tr><td>2025</td><td>$1,200</td></tr></table><p style="break-before: page">Page two</p>`
    for (const paper of ["a4", "letter", "legal"] as const) {
      const r = await buildDocumentPdf(html, { paper })
      expect(new TextDecoder().decode(r.bytes.slice(0, 5))).toBe(PDF_MAGIC)
      const doc = await PDFDocument.load(r.bytes)
      expect(doc.getPageCount()).toBe(2)
      expect(r.pages).toBe(2)
      const { width, height } = doc.getPage(0).getSize()
      expect(width).toBeCloseTo(mmToPt(PAPERS[paper].widthMm), 1)
      expect(height).toBeCloseTo(mmToPt(PAPERS[paper].heightMm), 1)
      expect(doc.getTitle()).toBe("Report")
      expect(r.name).toBe("Report.pdf")
    }
  })

  it("long text flows onto more pages; a long table repeats rows across pages", async () => {
    const one = await buildDocumentPdf(Array.from({ length: 5 }, (_, i) => para(i)).join(""))
    expect(one.pages).toBe(1)
    const more = await buildDocumentPdf(Array.from({ length: 40 }, (_, i) => para(i)).join(""))
    expect(more.pages).toBeGreaterThan(1)
    expect(await pages(more.bytes)).toBe(more.pages)
    const rows = Array.from({ length: 80 }, (_, i) => `<tr><td>Row ${i}</td><td>${i}</td></tr>`).join("")
    const t = await buildDocumentPdf(`<table><tr><th>Name</th><th>Value</th></tr>${rows}</table>`)
    expect(t.pages).toBeGreaterThan(1)
    expect(await pages(t.bytes)).toBe(t.pages)
  })

  it("the page break makes exactly one new page per break", async () => {
    const html = Array.from({ length: 4 }, (_, i) => `<h2 style="break-before: page">Part ${i}</h2><p>x</p>`).join("")
    expect((await buildDocumentPdf(html)).pages).toBe(4)
  })

  it("characters the font cannot draw are reported, not dropped silently", async () => {
    const r = await buildDocumentPdf("<p>Caf\u00e9 \u0416 \u6f22</p>")
    expect(r.warnings.join(" ")).toMatch(/1 character\(s\).*"\u6f22"/)
    expect((await buildDocumentPdf("<p>Caf\u00e9 \u0416 \u03a9 \u20ac</p>")).warnings).toEqual([])
  })

  it("a very long word and a wide table still fit the page", async () => {
    const r = await buildDocumentPdf(`<p>${"x".repeat(3000)}</p><table><tr>${"<td>wide cell text</td>".repeat(30)}</tr></table>`)
    expect(await pages(r.bytes)).toBe(r.pages)
  })
})

describe("limits", () => {
  it(`refuses more than ${MAX_SAVE_HTML_BYTES} bytes of HTML with a plain message`, async () => {
    const at = "<p>" + "a".repeat(MAX_SAVE_HTML_BYTES - 7) + "</p>"
    expect(new TextEncoder().encode(at).length).toBe(MAX_SAVE_HTML_BYTES)
    await expect(buildDocumentPdf(at + "x")).rejects.toThrow(/^Refused: the HTML is 262145 bytes \(256 KB\)\. untrace_save_document takes at most 262144 bytes \(256 KB\) of HTML\. Shorten it, or split it/)
  })

  it("counts UTF-8 bytes, not characters", async () => {
    await expect(buildDocumentPdf("\u20ac".repeat(MAX_SAVE_HTML_BYTES / 3 + 1))).rejects.toThrow(/Refused: the HTML is 262146 bytes/)
  })

  it(`refuses more than ${MAX_SAVE_PAGES} pages and says to split the document`, async () => {
    const at = Array.from({ length: MAX_SAVE_PAGES }, (_, i) => `<h2 style="break-before: page">Part ${i}</h2>`).join("")
    expect((await buildDocumentPdf(at)).pages).toBe(MAX_SAVE_PAGES)
    const over = at + '<p style="break-before: page">one more</p>'
    await expect(buildDocumentPdf(over, { name: "Plan" })).rejects.toThrow(/^Refused: the document is 11 pages\. untrace_save_document saves at most 10 pages\. Split it into parts of at most 10 pages and save each part with its own name, for example "Plan \(part 1\)"\./)
  })

  it("refuses an empty document or one with nothing left after cleanup", async () => {
    await expect(buildDocumentPdf("  \n")).rejects.toThrow(/^Refused: the HTML is empty/)
    await expect(buildDocumentPdf('<img src="data:image/png;base64,AA=="><script>x()</script>')).rejects.toThrow(/^Refused: nothing is left to save/)
  })
})

describe("untrace_save_document tool", () => {
  type H = Awaited<ReturnType<typeof harness>>
  let h: H
  beforeEach(async () => {
    h = await harness()
  })
  afterEach(async () => {
    await h.close()
  })

  it("renders the PDF and uploads it with this server's key, into the folder given", async () => {
    const r = await h.call("untrace_save_document", { html: "<h1>Board memo</h1><p>Text</p>", folderId: FOLDER_ID })
    expect(r.isError).toBe(false)
    expect(h.client.files.upload).toHaveBeenCalledTimes(1)
    const input = h.client.files.upload.mock.calls[0]![0] as { folderId: string; name: string; mime: string; data: Uint8Array }
    expect(input.folderId).toBe(FOLDER_ID)
    expect(input.name).toBe("Board memo.pdf")
    expect(input.mime).toBe("application/pdf")
    expect(await pages(input.data)).toBe(1)
    const out = JSON.parse(r.content[0]!.text!)
    expect(out).toMatchObject({ name: "Board memo.pdf", folderId: FOLDER_ID, pages: 1, paper: "a4", size: input.data.length })
    expect(out.url).toBe(driveFileUrl("https://drive.untrace.network", out.fileId, FOLDER_ID))
    expect(out.url).toMatch(/^https:\/\/drive\.untrace\.network\/\?tab=all-files&folder=[0-9a-f-]+&file=[0-9a-f-]+$/)
    expect(r.content[1]!.text).toMatch(/^Saved\./)
  })

  it("name and paper are used; a template works like in untrace_generate_link", async () => {
    await h.call("untrace_save_document", { html: "<p>x</p>", name: "Q3 / plan", paper: "letter", folderId: FOLDER_ID })
    const a = h.client.files.upload.mock.calls[0]![0] as { name: string; data: Uint8Array }
    expect(a.name).toBe("Q3 plan.pdf")
    expect((await PDFDocument.load(a.data)).getPage(0).getSize().width).toBeCloseTo(612, 0)
    const t = await h.call("untrace_save_document", { template: "invoice", fields: { "Invoice number": "INV-7" }, folderId: FOLDER_ID })
    expect(t.isError).toBe(false)
    expect(JSON.parse(t.content[0]!.text!).template).toBe("invoice")
  })

  it("without folderId it uses the only top-level folder the key can add files to", async () => {
    const r = await h.call("untrace_save_document", { html: "<p>x</p>" })
    expect(r.isError).toBe(false)
    expect((h.client.files.upload.mock.calls[0]![0] as { folderId: string }).folderId).toBe(FOLDER_ID)
  })

  it("without folderId and several or no writable folders it refuses and uploads nothing", async () => {
    const f2 = { folderId: "1c7a9d2f-3e4b-4c6d-9e0f-2a3b4c5d6e7f", name: "Other", parentId: null, role: "editor" }
    const viewer = { folderId: "2c7a9d2f-3e4b-4c6d-9e0f-2a3b4c5d6e7f", name: "Read only", parentId: null, role: "viewer" }
    h.client.folders.list.mockResolvedValueOnce({ folders: [{ folderId: FOLDER_ID, name: "Docs", role: "admin" }, f2, viewer], nextCursor: null })
    const many = await h.call("untrace_save_document", { html: "<p>x</p>" })
    expect(many.text).toMatch(/^refused: Refused: this key can add files to 2 folders\. Pass folderId, one of: Docs \(/)
    h.client.folders.list.mockResolvedValueOnce({ folders: [viewer], nextCursor: null })
    const none = await h.call("untrace_save_document", { html: "<p>x</p>" })
    expect(none.text).toMatch(/^refused: Refused: this key was not added to any folder it can add files to/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
  })

  it("over the limits nothing reaches Drive", async () => {
    const big = await h.call("untrace_save_document", { html: "a".repeat(MAX_SAVE_HTML_BYTES + 1), folderId: FOLDER_ID })
    expect(big.text).toMatch(/^refused: Refused: the HTML is 262145 bytes/)
    const long = await h.call("untrace_save_document", { html: Array.from({ length: 11 }, (_, i) => `<p style="break-before: page">${i}</p>`).join(""), folderId: FOLDER_ID })
    expect(long.text).toMatch(/^refused: Refused: the document is 11 pages\..*Split it into parts/)
    expect(h.client.files.upload).not.toHaveBeenCalled()
    expect(h.client.folders.list).not.toHaveBeenCalled()
  })

  it("input rules: exactly one source, fields only with template", async () => {
    expect((await h.call("untrace_save_document", {})).text).toMatch(/^refused: Refused: give exactly one of html, path or template/)
    expect((await h.call("untrace_save_document", { html: "<p>x</p>", fields: { a: "b" } })).text).toMatch(/fields works only with template/)
  })

  it("reads a local .html file inside the allowed folder", async () => {
    await h.write("memo.html", "<h1>From a file</h1>")
    const r = await h.call("untrace_save_document", { path: "memo.html", folderId: FOLDER_ID })
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.content[0]!.text!).name).toBe("From a file.pdf")
    await h.write("big.html", "a".repeat(MAX_SAVE_HTML_BYTES + 1))
    expect((await h.call("untrace_save_document", { path: "big.html", folderId: FOLDER_ID })).text).toMatch(/^refused: Refused: big\.html is 262145 bytes\. untrace_save_document takes at most/)
  })

  it("is listed with a description in plain words and the 256 KB and 10 page limits", async () => {
    const { tools } = await h.mcp.listTools()
    const t = tools.find((x) => x.name === "untrace_save_document")!
    expect(t.description).toMatch(/256 KB/)
    expect(t.description).toMatch(/10 pages/)
    expect(t.description).toMatch(/encrypted on the machine running this server before it is stored/)
    expect(t.description).not.toMatch(/never see|\u2014/i)
    expect(t.annotations!.readOnlyHint).toBe(false)
    expect(t.annotations!.destructiveHint).toBe(false)
  })
})

describe("untrace_save_document errors are redacted", () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })
  const BODY = SECRET.slice(CLIENT_SECRET_PREFIX.length)

  it("an upload error that carries the secret comes back without it", async () => {
    process.env.UNTRACE_CLIENT_SECRET = SECRET
    const client = mockClient()
    const err = new UntraceServerError({ status: 500, code: "server_error", message: "boom" })
    Object.defineProperty(err, "message", { value: `boom ${BODY} Bearer abc.def.ghi ${SECRET}` })
    client.files.upload.mockRejectedValueOnce(err)
    const h = await harness({ client })
    try {
      const r = await h.call("untrace_save_document", { html: "<p>x</p>", folderId: FOLDER_ID })
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/^server_error:/)
      expect(r.text).not.toContain(BODY)
      expect(r.text).not.toContain("abc.def.ghi")
      expect(r.text).toContain("[redacted]")
    } finally {
      await h.close()
    }
  })

  it("a document that contains the secret is refused in the answer, not echoed", async () => {
    process.env.UNTRACE_CLIENT_SECRET = SECRET
    const h = await harness()
    try {
      const r = await h.call("untrace_save_document", { html: `<h1>${SECRET}</h1>`, folderId: FOLDER_ID })
      expect(r.text).not.toContain(BODY)
    } finally {
      await h.close()
    }
  })
})

describe("end to end with the real SDK and the mock Drive", () => {
  it("the PDF is encrypted before it leaves, lands in the folder, and decrypts back to the same PDF", async () => {
    const drive = createMockDrive({ scopes: ["download", "upload"] })
    const client = new UntraceClient({ clientId: CLIENT_ID, clientSecret: MOCK_SECRET, baseUrl: BASE, fetch: drive.handler, maxRetries: 0 })
    const h = await harness({ client: (() => client as unknown as UntraceLike) as never })
    try {
      const r = await h.call("untrace_save_document", { html: "<h1>Secret plan</h1><p>the quarterly numbers</p>", folderId: MOCK_FOLDER })
      expect(r.isError).toBe(false)
      const out = JSON.parse(r.content[0]!.text!)
      expect(out.name).toBe("Secret plan.pdf")
      expect(out.url.startsWith(`${BASE}/?tab=all-files&folder=${MOCK_FOLDER}&file=`)).toBe(true)
      // The upload went out with this key's token, and the body is ciphertext.
      const up = drive.requests.find((q) => q.url.endsWith("/api/v1/files/upload"))!
      expect(up.headers.authorization).toMatch(/^Bearer tok_/)
      expect(Buffer.from(up.body).toString("latin1")).not.toContain(PDF_MAGIC)
      const token = drive.requests.find((q) => q.url.endsWith("/api/v1/oauth/token"))!
      expect(new URLSearchParams(Buffer.from(token.body).toString()).get("client_id")).toBe(CLIENT_ID)
      const down = await client.files.download(out.fileId)
      expect(down.mime).toBe("application/pdf")
      expect(new TextDecoder().decode(down.bytes.slice(0, 5))).toBe(PDF_MAGIC)
      expect(await pages(down.bytes)).toBe(1)
    } finally {
      await h.close()
    }
  })
})
