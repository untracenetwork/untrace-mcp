/**
 * untrace_save_document: HTML in, a PDF in the user's Drive out.
 *
 *   1. The HTML (a full page or a fragment, at most 256 KB of UTF-8) is read into document blocks
 *      with the rules of Drive's Generate editor (./doc-blocks).
 *   2. The blocks are laid out on A4, US Letter or Legal with Drive's print styles (./doc-pdf),
 *      at most 10 pages.
 *   3. The PDF goes into a Drive folder through the SDK's normal upload, as this server's key
 *      (the agent key from `agent init` + `agent claim`, or UNTRACE_CLIENT_ID). The SDK encrypts
 *      it on this machine before it is sent.
 *
 * Rendering is local and makes no request; only the upload talks to Drive.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { ToolRefusal } from "./errors"
import { documentTitle, htmlToBlocks, pdfFileName, plainText } from "./doc-blocks"
import { FONT_FILES, PAPER_IDS, renderPdf, type FontFile, type PaperId, type RenderNotes } from "./doc-pdf"

export { PAPER_IDS, type PaperId }

/** Largest HTML accepted, in UTF-8 bytes (256 KiB). */
export const MAX_SAVE_HTML_BYTES = 256 * 1024
/** Most pages one saved document may have. */
export const MAX_SAVE_PAGES = 10

const KB = (n: number) => `${Math.round(n / 1024)} KB`

const fontCache = new Map<FontFile, Uint8Array>()

/** The bundled Geist font files: `fonts/` at the package root (next to dist/ and src/). */
export function loadBundledFont(f: FontFile): Uint8Array {
  let bytes = fontCache.get(f)
  if (!bytes) {
    if (!FONT_FILES.includes(f)) throw new Error(`unknown font ${f}`)
    try {
      bytes = new Uint8Array(readFileSync(fileURLToPath(new URL(`../fonts/${f}.ttf`, import.meta.url))))
    } catch {
      throw new ToolRefusal("Refused: the document fonts are missing from this install of @untracenetwork/mcp. Reinstall the package.")
    }
    fontCache.set(f, bytes)
  }
  return bytes
}

export interface BuiltDocument {
  bytes: Uint8Array
  name: string
  title: string
  pages: number
  htmlBytes: number
  warnings: string[]
}

function glyphWarning(n: RenderNotes): string | null {
  if (!n.missingGlyphs) return null
  const sample = n.missingSample.map((c) => JSON.stringify(c)).join(", ")
  return `${n.missingGlyphs} character(s) are not in the document font (Geist covers Latin, Greek and Cyrillic) and show as "?": ${sample}.`
}

/** HTML to a named PDF. Refuses over 256 KB of HTML, an empty document, or more than 10 pages. */
export async function buildDocumentPdf(
  html: string,
  opts: { name?: string; paper?: PaperId; loadFont?: (f: FontFile) => Uint8Array } = {}
): Promise<BuiltDocument> {
  const htmlBytes = new TextEncoder().encode(html).byteLength
  if (htmlBytes > MAX_SAVE_HTML_BYTES) {
    throw new ToolRefusal(
      `Refused: the HTML is ${htmlBytes} bytes (${KB(htmlBytes)}). untrace_save_document takes at most ${MAX_SAVE_HTML_BYTES} bytes (256 KB) of HTML. Shorten it, or split it into parts and save each part with its own name.`
    )
  }
  if (!html.trim()) throw new ToolRefusal("Refused: the HTML is empty.")
  const blocks = htmlToBlocks(html)
  if (!plainText(blocks) && !blocks.some((b) => b.type === "hr" || b.type === "table")) {
    throw new ToolRefusal("Refused: nothing is left to save after cleanup (no text, lists or tables). Images, scripts and styles are removed. Write the document as text, headings, lists and tables.")
  }
  const heading = documentTitle(blocks)
  const name = pdfFileName(opts.name?.trim() || heading)
  const title = name.replace(/\.pdf$/i, "")
  const r = await renderPdf(blocks, { paper: opts.paper ?? "a4", title, loadFont: opts.loadFont ?? loadBundledFont, maxPages: MAX_SAVE_PAGES })
  if (!r.bytes) {
    throw new ToolRefusal(
      `Refused: the document is ${r.pages} pages. untrace_save_document saves at most ${MAX_SAVE_PAGES} pages. Split it into parts of at most ${MAX_SAVE_PAGES} pages and save each part with its own name, for example "${title} (part 1)".`
    )
  }
  const warnings: string[] = []
  const g = glyphWarning(r.notes)
  if (g) warnings.push(g)
  return { bytes: r.bytes, name, title, pages: r.pages, htmlBytes, warnings }
}

/** Drive's address for one of the owner's own files: All files, in its folder, that row picked out. */
export function driveFileUrl(origin: string, fileId: string, folderId: string | null): string {
  const q = new URLSearchParams({ tab: "all-files" })
  if (folderId) q.set("folder", folderId)
  q.set("file", fileId)
  return `${origin.replace(/\/+$/, "")}/?${q.toString()}`
}

export const SAVE_DESCRIPTION = [
  "Save an HTML document to the user's Untrace Drive as a PDF. This server turns the HTML into the PDF itself, with the same rules and page style as Drive's Generate editor: do not build a PDF yourself.",
  "The PDF is encrypted on the machine running this server before it is stored, then uploaded into a folder as this server's key (the agent key from `untrace-mcp agent init` and `agent claim`, or UNTRACE_CLIENT_ID). Needs the upload scope and role editor or admin on the folder.",
  "Input: exactly one of html (a full page or a fragment), path (a local .html or .htm file inside the allowed folder) or template (mutual-nda, invoice, proposal-quote, letter, meeting-minutes) with fields, as in untrace_generate_link. name sets the file name (.pdf is added); without it the first heading names the file. paper is a4 (default), letter or legal. folderId picks the folder; leave it out when this key can add files to exactly one top-level folder.",
  `Limits: at most ${MAX_SAVE_HTML_BYTES} bytes (256 KB) of HTML and ${MAX_SAVE_PAGES} pages. Over either limit nothing is saved: split the document into parts and save each part with its own name.`,
  "What is kept: headings h1 to h6, paragraphs, line breaks, bold, italic, underline, strikethrough, inline code, highlight (mark), subscript, superscript, bulleted and numbered lists (nested too), quotes, dividers (hr), and tables with header cells (th), colspan and rowspan. A header row repeats on every page a table runs onto, and number cells are right-aligned. div, section, article, header, footer, main, pre and figure become plain paragraphs. A page break: style=\"break-before: page\" (or page-break-before: always) on any element.",
  "What is removed: images, scripts, styles and CSS (except that page break), forms, iframes, svg and every attribute except colspan and rowspan. Links keep their text. Characters outside Latin, Greek and Cyrillic (for example Chinese, Arabic or emoji) show as \"?\" and the answer says so.",
  "Returns {fileId, name, folderId, pages, size, url}. url opens the file in Drive for its owner.",
].join(" ")

export const SAVE_NEXT = "Saved. Give the user the file name and the url; the url opens the file in Untrace Drive."
