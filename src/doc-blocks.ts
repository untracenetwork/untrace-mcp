/**
 * HTML to document blocks, for untrace_save_document.
 *
 * The blocks are the same shape as the value of Drive's Generate editor (Plate nodes: p, h1 to
 * h6, blockquote, ul, ol, li, lic, table, tr, td, th, hr, and text leaves with mark flags), and
 * the rules follow what Drive does to imported HTML:
 *   1. lib/generate/sanitize.ts: only a short list of tags survives; scripts, styles, frames,
 *      forms, svg and math go; every attribute except colspan and rowspan goes; images go
 *      (the editor has no image block); links keep their text.
 *   2. The editor's HTML deserializer: div is a paragraph, section/article/header/footer/main
 *      and pre are transparent, adjacent lists of the same kind merge, whitespace collapses.
 *
 * Where Drive's deserializer drops text (a list item with two paragraphs keeps only the last
 * one, for example), this keeps all of it. One addition Drive does not have: a style with
 * `break-before: page` / `page-break-before: always` (or the `after` forms) starts a new page.
 *
 * Pure: no Node built-ins, no network.
 */
import { parse } from "parse5"
import type { DefaultTreeAdapterMap } from "parse5"

type P5Node = DefaultTreeAdapterMap["node"]
type P5Element = DefaultTreeAdapterMap["element"]
type P5Text = DefaultTreeAdapterMap["textNode"]

export interface Marks {
  bold?: true
  italic?: true
  underline?: true
  strikethrough?: true
  code?: true
  subscript?: true
  superscript?: true
  highlight?: true
}
export const MARK_KEYS = ["bold", "italic", "underline", "strikethrough", "code", "subscript", "superscript", "highlight"] as const

export interface TextLeaf extends Marks {
  text: string
}

export type BlockType = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote" | "ul" | "ol" | "li" | "lic" | "table" | "tr" | "td" | "th" | "hr"

export interface Block {
  type: BlockType
  children: DocNode[]
  /** td/th only: 2 to 50 (Drive's serializer limit). */
  colSpan?: number
  /** td/th only: 2 to 500. */
  rowSpan?: number
  /** Start this block on a new page. */
  breakBefore?: true
}

export type DocNode = Block | TextLeaf

export const isText = (n: DocNode): n is TextLeaf => typeof (n as TextLeaf).text === "string"

/** Removed with everything inside (DOMPurify FORBID_TAGS / FORBID_CONTENTS in Drive's cleanup). */
const DROP = new Set([
  "script", "style", "link", "meta", "base", "iframe", "frame", "frameset", "svg", "math", "template", "title", "head",
  "noembed", "noframes", "xmp", "plaintext", "audio", "video", "img", "picture", "source", "track", "canvas", "embed",
  "input", "colgroup", "col", "map", "area", "param", "object-data",
])

const MARK_TAGS: Record<string, keyof Marks> = {
  strong: "bold",
  b: "bold",
  em: "italic",
  i: "italic",
  u: "underline",
  s: "strikethrough",
  del: "strikethrough",
  strike: "strikethrough",
  code: "code",
  mark: "highlight",
  sub: "subscript",
  sup: "superscript",
}

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"])
/** Elements that make a block of their own (so a div holding one is not one paragraph). */
const BLOCK_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "table", "hr", "div"])

interface RawLeaf extends Marks {
  text: string
  pre?: boolean
  br?: boolean
}

const attr = (el: P5Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value

/** True when an inline style asks for a page break before (or after) the element. */
export function pageBreak(el: P5Element): { before: boolean; after: boolean } {
  const s = (attr(el, "style") ?? "").toLowerCase().replace(/\s+/g, "")
  return {
    before: /(?:^|;)(?:page-break-before:always|break-before:(?:page|always))/.test(s),
    after: /(?:^|;)(?:page-break-after:always|break-after:(?:page|always))/.test(s),
  }
}

function hasBlockDescendant(el: P5Element): boolean {
  for (const c of el.childNodes) {
    if (!("tagName" in c)) continue
    if (DROP.has(c.tagName)) continue
    if (BLOCK_TAGS.has(c.tagName) && c.tagName !== "div") return true
    if (hasBlockDescendant(c)) return true
  }
  return false
}

function sameMarks(a: Marks, b: Marks): boolean {
  return MARK_KEYS.every((k) => Boolean(a[k]) === Boolean(b[k]))
}

function markCopy(m: Marks): Marks {
  const out: Marks = {}
  for (const k of MARK_KEYS) if (m[k]) out[k] = true
  return out
}

const WS = /[ \t\n\r\f\u00a0]+/g

/** Collapse whitespace like the editor does: runs become one space, none at the start of a block. */
export function finishInline(raw: readonly RawLeaf[], opts: { loose?: boolean } = {}): TextLeaf[] {
  const out: TextLeaf[] = []
  let prevSpace = true
  for (const r of raw) {
    let t: string
    if (r.br) {
      t = "\n"
      prevSpace = true
    } else if (r.pre) {
      t = r.text
      if (t) prevSpace = /[ \t\n]$/.test(t)
    } else {
      // Per text run, as the editor does: a run of whitespace is one space; a whitespace-only
      // run after a space (or at the start of a line) goes; a leading space goes at a line start.
      t = r.text.replace(WS, " ")
      const lineStart = out.length === 0 || out[out.length - 1]!.text.endsWith("\n")
      if (t === " " && (prevSpace || lineStart)) t = ""
      else if (lineStart && t.startsWith(" ")) t = t.slice(1)
      if (t) prevSpace = t.endsWith(" ")
    }
    if (!t) continue
    const leaf: TextLeaf = { text: t, ...markCopy(r) }
    const last = out[out.length - 1]
    if (last && sameMarks(last, leaf)) last.text += t
    else out.push(leaf)
  }
  // A line break on its own is an empty line, as in the browser.
  if (out.length === 1 && out[0]!.text === "\n") return [{ text: "", ...markCopy(out[0]!) }]
  return out.length ? out : [{ text: "" }]
}

const hasContent = (raw: readonly RawLeaf[]) => raw.some((r) => r.br || r.text.replace(WS, "") !== "")

/** Collects blocks in order; loose inline content between blocks becomes a paragraph. */
class Flow {
  readonly blocks: Block[] = []
  private run: RawLeaf[] = []
  private breakNext = false

  /** looseType: the block that loose inline content becomes (p, or the heading it sits in). */
  constructor(private readonly looseType: BlockType = "p") {}

  inline(leaf: RawLeaf) {
    this.run.push(leaf)
  }

  flush() {
    if (!this.run.length) return
    const run = this.run
    this.run = []
    if (hasContent(run)) this.push({ type: this.looseType, children: finishInline(run, { loose: true }) })
  }

  push(b: Block) {
    this.flush()
    if (this.breakNext) {
      b.breakBefore = true
      this.breakNext = false
    }
    const last = this.blocks[this.blocks.length - 1]
    // Adjacent lists of the same kind become one list, as in the editor.
    if (last && (b.type === "ul" || b.type === "ol") && last.type === b.type && !b.breakBefore) {
      last.children.push(...b.children)
      return
    }
    this.blocks.push(b)
  }

  pageBreak() {
    this.flush()
    this.breakNext = true
  }

  finish(): Block[] {
    this.flush()
    return this.blocks
  }
}

interface Ctx {
  marks: Marks
  pre: boolean
}

/** Inline content of an element, its nested blocks flattened into it. */
function inlineOf(el: P5Element, ctx: Ctx): RawLeaf[] {
  const f = new Flow()
  const raw: RawLeaf[] = []
  const sink = {
    inline: (l: RawLeaf) => raw.push(l),
  }
  walkInline(el.childNodes, ctx, sink, f)
  // Any blocks found inside (rare: the HTML parser closes a p before most of them) join as lines.
  for (const b of f.finish()) {
    if (raw.length) raw.push({ text: "", br: true })
    raw.push(...flattenToRaw(b))
  }
  return raw
}

function flattenToRaw(b: Block): RawLeaf[] {
  const out: RawLeaf[] = []
  const walk = (n: DocNode) => {
    if (isText(n)) {
      if (n.text) out.push({ ...markCopy(n), text: n.text, pre: true })
      return
    }
    let first = true
    for (const c of n.children) {
      if (!first && !isText(c)) out.push(n.type === "tr" ? { text: " ", pre: true } : { text: "", br: true })
      walk(c)
      first = false
    }
  }
  walk(b)
  return out
}

function walkInline(nodes: readonly P5Node[], ctx: Ctx, sink: { inline(l: RawLeaf): void }, blocks: Flow) {
  for (const n of nodes) {
    if (n.nodeName === "#text") {
      sink.inline({ text: (n as P5Text).value, ...ctx.marks, pre: ctx.pre || undefined })
      continue
    }
    if (!("tagName" in n)) continue
    const el = n as P5Element
    const tag = el.tagName
    if (DROP.has(tag)) continue
    const mark = MARK_TAGS[tag]
    if (mark) {
      // Inside pre the editor keeps the text but not the code mark.
      const marks = mark === "code" && ctx.pre ? ctx.marks : { ...ctx.marks, [mark]: true }
      walkInline(el.childNodes, { ...ctx, marks }, sink, blocks)
    } else if (tag === "br") {
      sink.inline({ text: "", br: true, ...ctx.marks })
    } else if (tag === "pre") {
      walkInline(el.childNodes, { ...ctx, pre: true }, sink, blocks)
    } else if (BLOCK_TAGS.has(tag) && tag !== "div") {
      walk(el, ctx, blocks)
    } else {
      walkInline(el.childNodes, ctx, sink, blocks)
    }
  }
}

/** The editor drops the newlines at the start and the end of a pre block; spaces stay. */
function trimPreNewlines(raw: RawLeaf[]) {
  for (const r of raw) {
    if (r.br || !r.pre) break
    r.text = r.text.replace(/^\n+/, "")
    if (r.text) break
  }
  for (let i = raw.length - 1; i >= 0; i--) {
    const r = raw[i]!
    if (r.br || !r.pre) break
    r.text = r.text.replace(/\n+$/, "")
    if (r.text) break
  }
}

function walkChildren(nodes: readonly P5Node[], ctx: Ctx, flow: Flow) {
  for (const n of nodes) walk(n, ctx, flow)
}

function walk(n: P5Node, ctx: Ctx, flow: Flow) {
  if (n.nodeName === "#text") {
    flow.inline({ text: (n as P5Text).value, ...ctx.marks, pre: ctx.pre || undefined })
    return
  }
  if (!("tagName" in n)) return
  const el = n as P5Element
  const tag = el.tagName
  if (DROP.has(tag)) return
  const br = pageBreak(el)
  if (br.before) flow.pageBreak()
  walkElement(el, tag, ctx, flow)
  if (br.after) flow.pageBreak()
}

function walkElement(el: P5Element, tag: string, ctx: Ctx, flow: Flow) {
  const mark = MARK_TAGS[tag]
  if (mark) {
    walkChildren(el.childNodes, { ...ctx, marks: { ...ctx.marks, [mark]: true } }, flow)
    return
  }
  if (tag === "br") {
    flow.inline({ text: "", br: true, ...ctx.marks })
    return
  }
  if (tag === "hr") {
    flow.push({ type: "hr", children: [{ text: "", ...markCopy(ctx.marks) }] })
    return
  }
  if (tag === "p" || HEADINGS.has(tag)) {
    flow.flush()
    if (hasBlockDescendant(el)) {
      // A table or list inside a p (the parser allows it without a doctype): keep the order.
      const inner = new Flow(tag as BlockType)
      walkChildren(el.childNodes, ctx, inner)
      for (const b of inner.finish()) flow.push(b)
      return
    }
    flow.push({ type: tag as BlockType, children: finishInline(inlineOf(el, ctx)) })
    return
  }
  if (tag === "div") {
    flow.flush()
    if (hasBlockDescendant(el)) {
      walkChildren(el.childNodes, ctx, flow)
      flow.flush()
    } else {
      flow.push({ type: "p", children: finishInline(inlineOf(el, ctx), { loose: true }) })
    }
    return
  }
  if (tag === "pre") {
    const pctx = { ...ctx, pre: true }
    const sub: RawLeaf[] = []
    walkInline(el.childNodes, pctx, { inline: (l) => sub.push(l) }, flow)
    trimPreNewlines(sub)
    for (const l of sub) flow.inline(l)
    return
  }
  if (tag === "blockquote") {
    const inner = new Flow()
    walkChildren(el.childNodes, ctx, inner)
    const kids = inner.finish()
    flow.push({ type: "blockquote", children: kids.length ? kids : [{ type: "p", children: [{ text: "" }] }] })
    return
  }
  if (tag === "ul" || tag === "ol") {
    flow.push(buildList(el, tag, ctx))
    return
  }
  if (tag === "li") {
    // A list item outside a list: a paragraph.
    flow.push({ type: "p", children: finishInline(inlineOf(el, ctx)) })
    return
  }
  if (tag === "table") {
    const t = buildTable(el, ctx)
    if (t.caption) flow.push(t.caption)
    if (t.table) flow.push(t.table)
    for (const b of t.loose) flow.push(b)
    return
  }
  // section, article, header, footer, main, span, a, figure, small, kbd, label and the rest: their
  // content flows on, as in the editor. Without a block inside, a div in them is inline too.
  if (hasBlockDescendant(el)) walkChildren(el.childNodes, ctx, flow)
  else walkInline(el.childNodes, ctx, flow, flow)
}

function buildLi(el: P5Element | null, extra: RawLeaf[] | null, ctx: Ctx): Block {
  const inner = new Flow()
  if (el) walkChildren(el.childNodes, ctx, inner)
  const blocks = inner.finish()
  const raw: RawLeaf[] = extra ? [...extra] : []
  const nested: Block[] = []
  for (const b of blocks) {
    if (b.type === "ul" || b.type === "ol") {
      const last = nested[nested.length - 1]
      if (last && last.type === b.type) last.children.push(...b.children)
      else nested.push(b)
      continue
    }
    if (raw.length && hasContent(raw)) raw.push({ text: "", br: true })
    if (b.type === "hr") continue
    raw.push(...flattenToRaw(b))
  }
  // An item that is only a nested list: the editor lifts the nested list's first item into it.
  if (!hasContent(raw) && nested.length === 1 && nested[0]!.children.length > 0) {
    const [first, ...rest] = nested[0]!.children as Block[]
    const tail = rest.length ? [{ ...nested[0]!, children: rest }] : []
    return { type: "li", children: [...first!.children, ...tail] }
  }
  return { type: "li", children: [{ type: "lic", children: finishInline(raw) }, ...nested] }
}

function buildList(el: P5Element, tag: "ul" | "ol", ctx: Ctx): Block {
  const items: Block[] = []
  let loose: RawLeaf[] = []
  const flushLoose = () => {
    if (hasContent(loose)) items.push(buildLi(null, loose, ctx))
    loose = []
  }
  for (const c of el.childNodes) {
    if (c.nodeName === "#text") {
      loose.push({ text: (c as P5Text).value, ...ctx.marks })
      continue
    }
    if (!("tagName" in c)) continue
    const e = c as P5Element
    if (DROP.has(e.tagName)) continue
    if (e.tagName === "li") {
      flushLoose()
      items.push(buildLi(e, null, ctx))
    } else if (e.tagName === "ul" || e.tagName === "ol") {
      flushLoose()
      const sub = buildList(e, e.tagName, ctx)
      const last = items[items.length - 1]
      if (last) {
        const prev = last.children[last.children.length - 1] as Block
        if (prev.type === sub.type) prev.children.push(...sub.children)
        else last.children.push(sub)
      } else items.push({ type: "li", children: [{ type: "lic", children: [{ text: "" }] }, sub] })
    } else {
      walkInline([e], ctx, { inline: (l) => loose.push(l) }, new Flow())
    }
  }
  flushLoose()
  return { type: tag, children: items }
}

const SPAN = (v: string | undefined, max: number): number | undefined => {
  const n = Number(v)
  return Number.isInteger(n) && n > 1 && n <= max ? n : undefined
}

function buildCell(el: P5Element, ctx: Ctx): Block {
  const inner = new Flow()
  walkChildren(el.childNodes, ctx, inner)
  const blocks: Block[] = []
  // A table inside a cell: its cells' content joins the outer cell, as in the editor.
  const add = (b: Block) => {
    if (b.type !== "table") {
      blocks.push(b)
      return
    }
    for (const row of b.children as Block[]) for (const cell of row.children as Block[]) for (const x of cell.children as Block[]) add(x)
  }
  for (const b of inner.finish()) add(b)
  const cell: Block = { type: el.tagName as "td" | "th", children: blocks.length ? blocks : [{ type: "p", children: [{ text: "" }] }] }
  const cs = SPAN(attr(el, "colspan"), 50)
  const rs = SPAN(attr(el, "rowspan"), 500)
  if (cs) cell.colSpan = cs
  if (rs) cell.rowSpan = rs
  return cell
}

function buildTable(el: P5Element, ctx: Ctx): { caption: Block | null; table: Block | null; loose: Block[] } {
  const rows: Block[] = []
  let caption: Block | null = null
  const looseFlow = new Flow()
  const takeRow = (tr: P5Element) => {
    const cells: Block[] = []
    for (const c of tr.childNodes) if ("tagName" in c && (c.tagName === "td" || c.tagName === "th")) cells.push(buildCell(c, ctx))
    if (cells.length) rows.push({ type: "tr", children: cells })
  }
  for (const c of el.childNodes) {
    if (c.nodeName === "#text") {
      looseFlow.inline({ text: (c as P5Text).value, ...ctx.marks })
      continue
    }
    if (!("tagName" in c)) continue
    const e = c as P5Element
    if (e.tagName === "tr") takeRow(e)
    else if (e.tagName === "thead" || e.tagName === "tbody" || e.tagName === "tfoot") {
      for (const r of e.childNodes) if ("tagName" in r && r.tagName === "tr") takeRow(r)
    } else if (e.tagName === "caption") {
      caption = { type: "p", children: finishInline(inlineOf(e, ctx)) }
    } else if (!DROP.has(e.tagName)) walk(e, ctx, looseFlow)
  }
  return { caption, table: rows.length ? { type: "table", children: rows } : null, loose: looseFlow.finish() }
}

function findBody(n: P5Node): P5Element | null {
  if ("tagName" in n && n.tagName === "body") return n as P5Element
  if ("childNodes" in n) {
    for (const c of n.childNodes) {
      const b = findBody(c)
      if (b) return b
    }
  }
  return null
}

/** Parse HTML (a full page or a fragment) into document blocks. Never empty: at least p(""). */
export function htmlToBlocks(html: string): Block[] {
  // scriptingEnabled false: <noscript> content is parsed as markup, as in the browser's DOMParser.
  const doc = parse(html, { scriptingEnabled: false })
  const body = findBody(doc)
  const flow = new Flow()
  if (body) walkChildren(body.childNodes, { marks: {}, pre: false }, flow)
  const blocks = flow.finish()
  return blocks.length ? blocks : [{ type: "p", children: [{ text: "" }] }]
}

/** All the text, for "is anything left" checks. */
export function plainText(blocks: readonly DocNode[]): string {
  const walk = (n: DocNode): string => (isText(n) ? n.text : n.children.map(walk).join(" "))
  return blocks.map(walk).join("\n").trim()
}

/** Drive's documentTitle: the first top-level heading's text, else null. */
export function documentTitle(blocks: readonly Block[]): string | null {
  const flat = (n: DocNode): string => (isText(n) ? n.text : n.children.map(flat).join(""))
  for (const b of blocks) {
    if (/^h[1-6]$/.test(b.type)) {
      const t = flat(b).replace(/\s+/g, " ").trim()
      if (t) return t
    }
  }
  return null
}

/** Drive's pdfFileName: no path or control characters, at most 80 characters, then ".pdf". */
export function pdfFileName(title: string | null, fallback = "Untitled document"): string {
  const base = (title ?? "")
    .replace(/\.pdf$/i, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim()
  return `${base || fallback}.pdf`
}
