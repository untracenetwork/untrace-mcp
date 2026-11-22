/**
 * untrace_generate_link: put an HTML document in a Drive link, so it opens in Drive's editor.
 *
 *   <origin>/generate#doc=<base64url(deflate-raw(utf8 html))>   default
 *   <origin>/generate#html=<base64url(utf8 html)>               no compression
 *
 * The link itself is built by ./generate-link: pure, no Node built-ins, so it also runs in
 * browsers and edge workers (import `@untracenetwork/mcp/generate`). This file adds the
 * server-side parts: the Drive origin from UNTRACE_BASE_URL, reading a local file as UTF-8, and
 * the "what next" line. Building the link is local: no network, no developer key.
 * See docs/GENERATE.md.
 */
import { ToolRefusal } from "./errors"
import { DEFAULT_DRIVE_ORIGIN } from "./generate-link"

export {
  CHAT_LINK_WARN_HTML_BYTES,
  DEFAULT_DRIVE_ORIGIN,
  MAX_GENERATE_HTML_BYTES,
  MAX_GENERATE_PAYLOAD_CHARS,
  GenerateLinkError,
  buildGenerateLink,
  bytesToBase64Url,
  chatLinkWarning,
  deflateRaw,
  encodeGeneratePayload,
  type GenerateFormat,
  type GenerateLink,
} from "./generate-link"

/** The Drive origin links point at: UNTRACE_BASE_URL (its origin) or the default. */
export function driveOrigin(base: string | undefined = process.env.UNTRACE_BASE_URL): string {
  const v = base?.trim()
  if (!v) return DEFAULT_DRIVE_ORIGIN
  let u: URL
  try {
    u = new URL(v)
  } catch {
    throw new ToolRefusal("Refused: UNTRACE_BASE_URL is not a valid URL.")
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ToolRefusal("Refused: UNTRACE_BASE_URL must be http or https.")
  if (u.username || u.password) throw new ToolRefusal("Refused: UNTRACE_BASE_URL must not contain a user name or password.")
  return u.origin
}

/** Read `bytes` as UTF-8, refusing anything that is not. */
export function decodeUtf8File(bytes: Uint8Array, shownPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new ToolRefusal(`Refused: ${shownPath} is not UTF-8 text. Save the HTML as UTF-8.`)
  }
}

/** Public guide for building the link, also at https://untrace.network/docs/generate-links. */
export const GENERATE_GUIDE_URL = "https://untrace.network/docs/generate-links"

/**
 * The tool's description: the whole public guide, so any agent reading the tool list can build
 * the link itself, without this server. Every limit and rule is Drive's own code:
 * lib/generate/fragment.ts (limits, decoding) and lib/generate/sanitize.ts (what survives).
 */
export const GENERATE_DESCRIPTION = [
  "Turn an HTML document into a link that opens it in Untrace Drive's editor (https://drive.untrace.network/generate). Opening and editing need no sign-in. Nothing is uploaded until the person presses Split & Upload, which asks them to sign in if they are not and saves the PDF encrypted to their Drive.",
  "The document travels only in the part of the link after #, which browsers never send to a server.",
  "Input: exactly one of html (the document), path (a local .html or .htm file inside the allowed folder) or template (one of Drive's templates: mutual-nda, invoice, proposal-quote, letter, meeting-minutes). With template, fields fills its highlighted [Field] values by name; call once with template alone to get the names in fieldsLeft, then again with fields.",
  "Limits: more than 2 MB of HTML (2,097,152 bytes of UTF-8) is refused, and so is a payload over 1,500,000 characters. Above about 200 KB of HTML the answer carries a warning: the link works, but some chat apps and browsers cut very long links, so open it directly in a browser. format doc (default) compresses; html does not and stops at about 1.1 MB of HTML.",
  "What is kept: headings h1 to h6, paragraphs, line breaks, bold, italic, underline, strikethrough (s, del), inline code, highlight (mark), subscript, superscript, bulleted and numbered lists, quotes (blockquote), dividers (hr), and tables with header cells (th), colspan and rowspan. div, section, article, header, footer, main, pre, figure and caption become plain paragraphs. A full page (html, head, body) is fine: only the body is used, and the PDF is named after the first heading.",
  "What is removed: images (the cleanup lets only data:image/png, jpeg, gif, webp, avif or bmp through, and the editor has no image block yet, so do not rely on images), scripts, event handlers (on...), style and link tags, every attribute except colspan and rowspan (so no style, class, id or srcset), iframes, objects, embeds, forms, svg, math, base and meta, and anything loaded from another site. Links keep their text but lose their href. Design with headings, lists and tables, not CSS: the print view sets its own type and spacing.",
  'Build the link yourself, no server needed: payload = base64url (A-Z a-z 0-9 - _, no = padding) of raw DEFLATE (RFC 1951, no zlib header) of the UTF-8 HTML; link = https://drive.untrace.network/generate#doc=<payload>. JavaScript: new Blob([html]).stream().pipeThrough(new CompressionStream("deflate-raw")). Python: zlib.compressobj(9, zlib.DEFLATED, -15). Without compression: #html=<base64url of the UTF-8 HTML>.',
  `Full guide with examples: ${GENERATE_GUIDE_URL}. This tool works offline and needs no key. The link holds the whole document: give it to the person to open, never post it publicly.`,
].join(" ")

export const GENERATE_NEXT =
  "Open the url in a browser. The document opens in Untrace Drive's editor with no sign-in; nothing is uploaded until the person presses Split & Upload, which asks them to sign in if they are not and saves the PDF encrypted to their Drive."
