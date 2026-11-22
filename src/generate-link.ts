/**
 * Build an Untrace Drive Generate link: an HTML document inside a link that opens it in Drive's
 * editor (/generate). The wire format is Drive's docs/api/generate-handoff.md:
 *
 *   <origin>/generate#doc=<base64url(deflate-raw(utf8 html))>   default
 *   <origin>/generate#html=<base64url(utf8 html)>               no compression
 *
 * The document travels in the URL fragment only. Browsers never send the part after `#` to a
 * server.
 *
 * PURE AND PORTABLE: no Node built-ins, no Buffer, no process, no imports. It uses only web
 * platform APIs (TextEncoder, CompressionStream("deflate-raw"), btoa), so the same module runs in
 * Node 20.12+, browsers and edge workers. Import it as `@untracenetwork/mcp/generate`.
 */

/** Longest payload Drive reads (characters after `doc=` or `html=`). Drive: lib/generate/fragment.ts MAX_FRAGMENT_CHARS. */
export const MAX_GENERATE_PAYLOAD_CHARS = 1_500_000
/** Largest HTML Drive opens, in UTF-8 bytes (2 MiB). Drive: lib/generate/fragment.ts MAX_HTML_BYTES. */
export const MAX_GENERATE_HTML_BYTES = 2 * 1024 * 1024
/**
 * Above this much HTML (200 KiB) the link still works, but some chat apps and browsers cut very
 * long links, so the answer carries a warning. Drive's handoff doc: "Keep documents under about
 * 200 KB of HTML when the link is pasted into a chat."
 */
export const CHAT_LINK_WARN_HTML_BYTES = 200 * 1024
/** Drive's production origin. */
export const DEFAULT_DRIVE_ORIGIN = "https://drive.untrace.network"

export type GenerateFormat = "doc" | "html"

export interface GenerateLink {
  url: string
  format: GenerateFormat
  /** Size of the HTML in UTF-8 bytes. */
  htmlBytes: number
  /** Length of the whole URL in characters. */
  urlChars: number
  /** Set when the HTML is over CHAT_LINK_WARN_HTML_BYTES: the link may be cut if pasted into a chat. */
  warning?: string
}

/** A refusal: the link was not built. The message never contains the document. */
export class GenerateLinkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GenerateLinkError"
  }
}

/** RFC 4648 section 5 alphabet (`-`, `_`), no `=` padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ""
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Raw DEFLATE (RFC 1951): no zlib or gzip header, no checksum. */
export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate-raw"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The fragment payload for `bytes` in `format`. */
export async function encodeGeneratePayload(bytes: Uint8Array, format: GenerateFormat): Promise<string> {
  return bytesToBase64Url(format === "doc" ? await deflateRaw(bytes) : bytes)
}

const MB = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
const KB = (n: number) => `${Math.round(n / 1024)} KB`

/** The warning text for `htmlBytes` of HTML, or undefined at or under the chat-link guidance. */
export function chatLinkWarning(htmlBytes: number): string | undefined {
  if (htmlBytes <= CHAT_LINK_WARN_HTML_BYTES) return undefined
  return `The HTML is ${htmlBytes} bytes (about ${KB(htmlBytes)}), over about 200 KB. The link works, but some chat apps and browsers cut very long links: open it directly in a browser instead of pasting it into a chat, or shorten the document.`
}

/**
 * Build the link. Refuses (GenerateLinkError) an empty document, more than 2 MiB of UTF-8 HTML,
 * or a payload over 1,500,000 characters. Warns, without refusing, above 200 KiB of HTML.
 */
export async function buildGenerateLink(
  html: string,
  opts: { format?: GenerateFormat; origin?: string } = {}
): Promise<GenerateLink> {
  const format = opts.format ?? "doc"
  if (format !== "doc" && format !== "html") throw new GenerateLinkError('Refused: format is "doc" or "html".')
  if (typeof html !== "string" || !html.trim()) throw new GenerateLinkError("Refused: the HTML is empty.")
  const bytes = new TextEncoder().encode(html)
  if (bytes.byteLength > MAX_GENERATE_HTML_BYTES) {
    throw new GenerateLinkError(
      `Refused: the HTML is ${bytes.byteLength} bytes (${MB(bytes.byteLength)}). Drive opens at most ${MAX_GENERATE_HTML_BYTES} bytes (2 MB). Shorten the document.`
    )
  }
  const payload = await encodeGeneratePayload(bytes, format)
  if (payload.length > MAX_GENERATE_PAYLOAD_CHARS) {
    const fix =
      format === "html" ? 'Use format "doc" (compressed), which fits far more.' : "Even compressed it is too long: shorten the document."
    throw new GenerateLinkError(`Refused: the link payload would be ${payload.length} characters. Drive reads at most ${MAX_GENERATE_PAYLOAD_CHARS}. ${fix}`)
  }
  const origin = (opts.origin ?? DEFAULT_DRIVE_ORIGIN).replace(/\/+$/, "")
  const url = `${origin}/generate#${format}=${payload}`
  const warning = chatLinkWarning(bytes.byteLength)
  return { url, format, htmlBytes: bytes.byteLength, urlChars: url.length, ...(warning ? { warning } : {}) }
}
