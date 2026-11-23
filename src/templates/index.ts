/**
 * Templates for untrace_generate_link: the same documents as the Templates button in Untrace
 * Drive's editor, as bundled strings (no fetch, no file read).
 *
 * A field to fill in is written `<mark>[Field name]</mark>`; the editor shows it highlighted.
 * fillTemplate replaces a field with its value, HTML-escaped and no longer highlighted.
 */
import { ToolRefusal } from "../refusal"
import { INVOICE_HTML } from "./invoice"
import { LETTER_HTML } from "./letter"
import { MEETING_MINUTES_HTML } from "./meeting-minutes"
import { NDA_HTML } from "./nda"
import { PROPOSAL_QUOTE_HTML } from "./proposal-quote"

export { NDA_SOURCE } from "./nda"

export const TEMPLATE_IDS = ["mutual-nda", "invoice", "proposal-quote", "letter", "meeting-minutes"] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

export interface GenerateTemplate {
  id: TemplateId
  name: string
  description: string
  html: string
}

export const GENERATE_TEMPLATES: readonly GenerateTemplate[] = [
  {
    id: "mutual-nda",
    name: "Mutual NDA",
    description: "Common Paper Mutual NDA 1.0 (CC BY 4.0): cover page, standard terms and signature table.",
    html: NDA_HTML,
  },
  {
    id: "invoice",
    name: "Invoice",
    description: "Seller and client details, line items with subtotal, tax and total, and payment details.",
    html: INVOICE_HTML,
  },
  {
    id: "proposal-quote",
    name: "Proposal / quote",
    description: "Summary, scope, deliverables, timeline, price table and an acceptance block.",
    html: PROPOSAL_QUOTE_HTML,
  },
  {
    id: "letter",
    name: "Letter",
    description: "A business letter with sender, recipient, subject, body and closing.",
    html: LETTER_HTML,
  },
  {
    id: "meeting-minutes",
    name: "Meeting minutes",
    description: "Details, attendees, agenda, discussion, decisions and an action items table.",
    html: MEETING_MINUTES_HTML,
  },
]

export function templateById(id: string): GenerateTemplate | null {
  return GENERATE_TEMPLATES.find((t) => t.id === id) ?? null
}

/** Longest value for one field, in characters. */
export const MAX_FIELD_VALUE_CHARS = 2_000
/** Most fields in one call. */
export const MAX_FIELDS = 200

const FIELD = /<mark>\[([^\]<>]*)\]<\/mark>/g

/** The field names still highlighted in `html`, in document order, each once. */
export function templateFields(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(FIELD), (m) => m[1]!))]
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

export interface FilledTemplate {
  html: string
  /** Fields given a non-empty value. */
  fieldsFilled: number
  /** Fields still highlighted, in document order, each once. */
  fieldsLeft: string[]
}

/**
 * Fill `template`'s fields. Each key is a field name as written inside the brackets; its value
 * replaces every `<mark>[Key]</mark>`, HTML-escaped and without the highlight. An empty value
 * leaves the field highlighted. Refuses an unknown key, more than 200 keys or a value over 2,000
 * characters. A refusal never repeats a value.
 */
export function fillTemplate(template: GenerateTemplate, fields: Record<string, string> = {}): FilledTemplate {
  const entries = Object.entries(fields)
  if (entries.length > MAX_FIELDS) throw new ToolRefusal(`Refused: at most ${MAX_FIELDS} fields in one call (got ${entries.length}).`)
  const known = new Set(templateFields(template.html))
  const unknown = entries.filter(([k]) => !known.has(k)).map(([k]) => k)
  if (unknown.length) {
    const shown = unknown.slice(0, 10).map((k) => JSON.stringify(k.length > 80 ? `${k.slice(0, 80)}...` : k))
    const more = unknown.length > shown.length ? ` and ${unknown.length - shown.length} more` : ""
    throw new ToolRefusal(
      `Refused: ${unknown.length === 1 ? "this field is" : "these fields are"} not in template ${template.id}: ${shown.join(", ")}${more}. Call with template only to get its field names in fieldsLeft.`
    )
  }
  const values = new Map<string, string>()
  for (const [k, v] of entries) {
    if (typeof v !== "string") throw new ToolRefusal(`Refused: the value of field ${JSON.stringify(k)} must be text.`)
    if (v.length > MAX_FIELD_VALUE_CHARS) {
      throw new ToolRefusal(`Refused: the value of field ${JSON.stringify(k)} is ${v.length} characters. A field holds at most ${MAX_FIELD_VALUE_CHARS}.`)
    }
    if (v !== "") values.set(k, escapeHtml(v))
  }
  // One pass over the template: a value is never read again as a field.
  const html = template.html.replace(FIELD, (whole, name: string) => values.get(name) ?? whole)
  return { html, fieldsFilled: values.size, fieldsLeft: templateFields(html) }
}
