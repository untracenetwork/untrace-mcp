/**
 * The two tools that need no developer key and make no request: untrace_generate_link and
 * untrace_setup_guide. Their schemas and handlers live here so the npm package (src/server.ts)
 * and the hosted Worker (worker/) serve exactly the same tool for the same input.
 *
 * No Node built-ins and no filesystem: reading a local file is passed in (readPath) by the
 * package's server only. The hosted Worker has no `path` input.
 */
import { z } from "zod"

import { GENERATE_NEXT, MAX_GENERATE_HTML_BYTES, buildGenerateLink, generateDescription, type GenerateFormat } from "./generate"
import { FRAMEWORKS, setupGuide, type Framework } from "./guide"
import { ToolRefusal } from "./refusal"
import { MAX_FIELDS, MAX_FIELD_VALUE_CHARS, TEMPLATE_IDS, fillTemplate, templateById, type TemplateId } from "./templates"

export type Where = "local" | "hosted"
type Text = { type: "text"; text: string }

// ---- untrace_setup_guide ----

export const SETUP_GUIDE_TOOL = {
  title: "Set up the Drive SDK in an app",
  description:
    "Return step-by-step instructions, with code, for adding Untrace Drive to a developer's own Next.js, Node.js, React or Vue app with the @untracenetwork packages. Works offline and needs no key.",
  inputSchema: {
    framework: z.enum(FRAMEWORKS).describe("nextjs, node, react or vue."),
    includeReference: z.boolean().optional().default(true).describe("Also include the scopes, roles and errors reference. Default true."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
}

export async function setupGuideResult({ framework, includeReference }: { framework: Framework; includeReference?: boolean }): Promise<{ content: Text[] }> {
  return { content: [{ type: "text" as const, text: setupGuide(framework, includeReference ?? true) }] }
}

// ---- untrace_generate_link ----

export type FilledFields = { template: TemplateId; fieldsFilled: number; fieldsLeft: string[] }
export interface DocumentInput {
  html?: string
  path?: string
  template?: TemplateId
  fields?: Record<string, string>
}

const TEMPLATE_HELP = {
  local: "Start from one of Drive's templates instead of html or path: mutual-nda, invoice, proposal-quote, letter or meeting-minutes.",
  hosted: "Start from one of Drive's templates instead of html: mutual-nda, invoice, proposal-quote, letter or meeting-minutes.",
}

/** The tool's title, description, input schema and annotations. `hosted` has no `path` input. */
export function generateLinkTool(where: Where) {
  return {
    title: "Open an HTML document in Drive's editor",
    description: generateDescription(where),
    inputSchema: {
      html: z
        .string()
        .min(1)
        .max(4 * MAX_GENERATE_HTML_BYTES)
        .optional()
        .describe(where === "local" ? "The HTML document, when neither path nor template is given." : "The HTML document, when no template is given."),
      ...(where === "local"
        ? { path: z.string().min(1).optional().describe("A local .html or .htm file, relative to the allowed folder (UNTRACE_MCP_ROOT). Not available on a remote server.") }
        : {}),
      format: z.enum(["doc", "html"]).optional().default("doc").describe("doc (default): compressed, fits far more. html: plain base64url, only for small documents."),
      template: z.enum(TEMPLATE_IDS).optional().describe(TEMPLATE_HELP[where]),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          `Only with template. Field name (as written inside the brackets, for example "Party 1 company") to value. Each value replaces every copy of that field, as plain text, no longer highlighted. An empty value leaves the field highlighted. At most ${MAX_FIELDS} fields, ${MAX_FIELD_VALUE_CHARS} characters each.`
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }
}

/**
 * The document's HTML from exactly one of html, path or template. `readPath` reads a local file;
 * leave it out where there is no filesystem (the hosted Worker): `path` is then not an input.
 */
export async function readDocumentInput(a: DocumentInput, readPath?: (path: string) => Promise<string>): Promise<{ doc: string; filled: FilledFields | null }> {
  const sources = readPath ? [a.html, a.path, a.template] : [a.html, a.template]
  if (sources.filter((v) => v != null).length !== 1) throw new ToolRefusal(readPath ? "Refused: give exactly one of html, path or template." : "Refused: give exactly one of html or template.")
  if (a.fields != null && a.template == null) throw new ToolRefusal("Refused: fields works only with template.")
  if (a.template != null) {
    const t = templateById(a.template)
    if (!t) throw new ToolRefusal(`Refused: template is one of ${TEMPLATE_IDS.join(", ")}.`)
    const f = fillTemplate(t, a.fields ?? {})
    return { doc: f.html, filled: { template: t.id, fieldsFilled: f.fieldsFilled, fieldsLeft: f.fieldsLeft } }
  }
  if (a.path != null && readPath) return { doc: await readPath(a.path), filled: null }
  return { doc: a.html!, filled: null }
}

/**
 * Build the link and the tool's answer. Local only: never touches the Drive client, so it works
 * without a key and makes no request. `redact` is the package's secret redaction (the Worker holds
 * no secrets and passes none); this module does not import it, so it stays free of the Drive SDK.
 */
export async function generateLinkResult(
  doc: string,
  filled: FilledFields | null,
  opts: { format?: GenerateFormat; origin?: string; redact?: (text: string) => string }
): Promise<{ content: Text[] }> {
  const link = await buildGenerateLink(doc, { format: opts.format ?? "doc", origin: opts.origin })
  const result = {
    url: link.url,
    format: link.format,
    htmlBytes: link.htmlBytes,
    urlChars: link.urlChars,
    ...(link.warning ? { warning: link.warning } : {}),
    ...(filled ?? {}),
  }
  const text = JSON.stringify(result, null, 2)
  // Redaction must never cut into the link: if it would change anything, refuse instead.
  if (opts.redact && opts.redact(text) !== text) throw new ToolRefusal("Refused: the link could not be returned safely. Change the document slightly and try again.")
  return { content: [{ type: "text" as const, text }, { type: "text" as const, text: link.warning ? `${link.warning} ${GENERATE_NEXT}` : GENERATE_NEXT }] }
}
