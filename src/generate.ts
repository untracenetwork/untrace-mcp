/**
 * untrace_generate_link: put an HTML document in a Drive link, so it opens in Drive's editor.
 *
 *   <origin>/generate#doc=<base64url(deflate-raw(utf8 html))>   default
 *   <origin>/generate#html=<base64url(utf8 html)>               no compression
 *
 * The document travels in the URL fragment only. Browsers never send the part after `#`, so the
 * draft never reaches a server. Building the link is local: no network, no developer key.
 * See docs/GENERATE.md.
 */
import { deflateRawSync } from "node:zlib"

import { ToolRefusal } from "./errors"

/** Longest payload Drive reads (characters after `doc=` or `html=`). */
export const MAX_GENERATE_PAYLOAD_CHARS = 1_500_000
/** Largest HTML Drive opens, in UTF-8 bytes (2 MiB). */
export const MAX_GENERATE_HTML_BYTES = 2 * 1024 * 1024
/** Drive's origin when UNTRACE_BASE_URL is not set. */
export const DEFAULT_DRIVE_ORIGIN = "https://drive.untrace.network"

export type GenerateFormat = "doc" | "html"

export interface GenerateLink {
  url: string
  format: GenerateFormat
  /** Size of the HTML in UTF-8 bytes. */
  htmlBytes: number
  /** Length of the whole URL in characters. */
  urlChars: number
}

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

/** The fragment payload for `bytes` in `format`: base64url without padding. */
export function encodeGeneratePayload(bytes: Uint8Array, format: GenerateFormat): string {
  const body = format === "doc" ? deflateRawSync(bytes, { level: 9 }) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return body.toString("base64url")
}

const MB = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`

/**
 * Build the link. Refuses an empty document, more than 2 MiB of HTML, or a payload over
 * 1,500,000 characters. Error messages never contain the document.
 */
export function buildGenerateLink(html: string, opts: { format?: GenerateFormat; origin?: string } = {}): GenerateLink {
  const format = opts.format ?? "doc"
  if (format !== "doc" && format !== "html") throw new ToolRefusal('Refused: format is "doc" or "html".')
  if (typeof html !== "string" || !html.trim()) throw new ToolRefusal("Refused: the HTML is empty.")
  const bytes = new TextEncoder().encode(html)
  if (bytes.byteLength > MAX_GENERATE_HTML_BYTES) {
    throw new ToolRefusal(
      `Refused: the HTML is ${bytes.byteLength} bytes (${MB(bytes.byteLength)}). Drive opens at most ${MAX_GENERATE_HTML_BYTES} bytes (2 MB). Shorten the document or use smaller images.`
    )
  }
  const payload = encodeGeneratePayload(bytes, format)
  if (payload.length > MAX_GENERATE_PAYLOAD_CHARS) {
    const fix =
      format === "html"
        ? 'Use format "doc" (compressed), which fits far more.'
        : "Even compressed it is too long: shorten the document or use smaller images."
    throw new ToolRefusal(
      `Refused: the link payload would be ${payload.length} characters. Drive reads at most ${MAX_GENERATE_PAYLOAD_CHARS}. ${fix}`
    )
  }
  const url = `${opts.origin ?? driveOrigin()}/generate#${format}=${payload}`
  return { url, format, htmlBytes: bytes.byteLength, urlChars: url.length }
}

/** Read `bytes` as UTF-8, refusing anything that is not. */
export function decodeUtf8File(bytes: Uint8Array, shownPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new ToolRefusal(`Refused: ${shownPath} is not UTF-8 text. Save the HTML as UTF-8.`)
  }
}

export const GENERATE_NEXT =
  "Open the url in a browser. The document opens in Untrace Drive's editor; nothing is uploaded until the person presses Split & Upload."
