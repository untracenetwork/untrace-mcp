/**
 * Document blocks to a PDF, for untrace_save_document.
 *
 * The layout follows Drive's Generate print view (lib/generate/print-css.ts), so a saved PDF
 * looks like the one Drive makes from the same HTML:
 *   - paper: A4, US Letter or Legal (lib/generate/paper.ts), margins 20 mm top, 18 mm sides,
 *     22 mm bottom, "page / pages" centred in the bottom margin;
 *   - Geist 10.5 pt, line height 1.5, text #1a1a1a; headings in Geist SemiBold at Drive's sizes
 *     and spacing; code in Geist Mono 9 pt; highlight #fff1a8;
 *   - lists indented 16 pt with discs or numbers; quotes with a 2 pt bar; dividers 0.75 pt;
 *   - tables full width, 9 pt, 0.75 pt borders, header cells shaded and repeated on every page a
 *     table runs onto, rows never split, numbers right-aligned;
 *   - headings stay with what follows; a paragraph leaves at least 2 lines on each page.
 *
 * One difference: Drive draws each page as an image, so its text cannot be selected. Here the
 * text is real PDF text (the fonts are embedded, subset to the characters used).
 *
 * The fonts are Geist and Geist Mono (SIL Open Font License 1.1, fonts/OFL.txt), shipped in the
 * package. Nothing is fetched: rendering makes no request.
 */
import fontkit from "@pdf-lib/fontkit"
import { PDFDocument, clip, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib"

import { isText, type Block, type DocNode, type TextLeaf } from "./doc-blocks"

// ---------------------------------------------------------------- paper

export const PAPER_IDS = ["a4", "letter", "legal"] as const
export type PaperId = (typeof PAPER_IDS)[number]

/** Drive's lib/generate/paper.ts, in millimetres. */
export const PAPERS: Record<PaperId, { label: string; widthMm: number; heightMm: number }> = {
  a4: { label: "A4", widthMm: 210, heightMm: 297 },
  letter: { label: "US Letter", widthMm: 215.9, heightMm: 279.4 },
  legal: { label: "Legal", widthMm: 215.9, heightMm: 355.6 },
}

const MM = 72 / 25.4
export const mmToPt = (mm: number) => mm * MM

const MARGIN = { top: 20 * MM, right: 18 * MM, bottom: 22 * MM, left: 18 * MM }

// ---------------------------------------------------------------- style (print-css.ts)

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255)
const TEXT = hex("#1a1a1a")
const QUOTE_TEXT = hex("#3a3a3a")
const RULE = hex("#c9c9c9")
const TH_BG = hex("#f2f2f2")
const MARK_BG = hex("#fff1a8")
const FOOTER = hex("#6b6b6b")

const BODY_SIZE = 10.5
const BODY_LH = 1.5
const TABLE_SIZE = 9
const CODE_SIZE = 9
const FOOTER_SIZE = 8

interface BlockStyle {
  size: number | null // null: inherit (body 10.5, 9 in a table)
  lh: number
  top: number
  bottom: number
  weight: 400 | 600
  keep?: boolean
}
const STYLE: Record<string, BlockStyle> = {
  p: { size: null, lh: BODY_LH, top: 0, bottom: 7, weight: 400 },
  h1: { size: 22, lh: 1.2, top: 0, bottom: 10, weight: 600, keep: true },
  h2: { size: 15, lh: 1.25, top: 16, bottom: 6, weight: 600, keep: true },
  h3: { size: 12, lh: 1.3, top: 12, bottom: 4, weight: 600, keep: true },
  h4: { size: 10.5, lh: BODY_LH, top: 10, bottom: 4, weight: 600, keep: true },
  h5: { size: 10.5, lh: BODY_LH, top: 10, bottom: 4, weight: 600, keep: true },
  h6: { size: 10.5, lh: BODY_LH, top: 10, bottom: 4, weight: 600, keep: true },
}
const LIST_INDENT = 16
const LIST_BOTTOM = 7
const LI_BOTTOM = 3
const QUOTE = { bottom: 8, padY: 2, bar: 2, padLeft: 10 }
const HR = { margin: 10, width: 0.75 }
const TABLE = { top: 4, bottom: 10, padX: 5, padY: 3, border: 0.75 }

// ---------------------------------------------------------------- fonts

export type FontFile = "Geist-Regular" | "Geist-Italic" | "Geist-SemiBold" | "Geist-SemiBoldItalic" | "Geist-Bold" | "Geist-BoldItalic" | "GeistMono-Regular" | "GeistMono-Bold"
export const FONT_FILES: readonly FontFile[] = ["Geist-Regular", "Geist-Italic", "Geist-SemiBold", "Geist-SemiBoldItalic", "Geist-Bold", "Geist-BoldItalic", "GeistMono-Regular", "GeistMono-Bold"]

interface FontKey {
  file: FontFile
  tnum: boolean
}

function fontFile(mono: boolean, weight: number, italic: boolean): FontFile {
  if (mono) return weight >= 600 ? "GeistMono-Bold" : "GeistMono-Regular"
  const w = weight >= 700 ? "Bold" : weight >= 600 ? "SemiBold" : ""
  if (!w) return italic ? "Geist-Italic" : "Geist-Regular"
  return `Geist-${w}${italic ? "Italic" : ""}` as FontFile
}

type FkFont = ReturnType<typeof fontkit.create>

/** Fontkit fonts for measuring (sync), PDF fonts embedded on first use when drawing. */
class Fonts {
  private fk = new Map<FontFile, FkFont>()
  private widths = new Map<string, number>()
  constructor(private readonly load: (f: FontFile) => Uint8Array) {}

  font(f: FontFile): FkFont {
    let x = this.fk.get(f)
    if (!x) {
      x = fontkit.create(this.load(f) as Buffer)
      this.fk.set(f, x)
    }
    return x
  }

  /** Advance width in points, as pdf-lib draws it (glyph advances, no kerning). */
  width(key: FontKey, text: string, size: number): number {
    const k = `${key.file}${key.tnum ? "+t" : ""}\u0000${text}`
    let units = this.widths.get(k)
    if (units === undefined) {
      const f = this.font(key.file)
      const run = f.layout(text, key.tnum ? { tnum: true } : undefined)
      units = 0
      for (const g of run.glyphs) units += g.advanceWidth
      units /= f.unitsPerEm
      this.widths.set(k, units)
    }
    return units * size
  }

  has(file: FontFile, cp: number): boolean {
    return this.font(file).hasGlyphForCodePoint(cp)
  }
}

// Geist metrics (all faces): ascent 1005, descent 295 per 1000; underline 100 below, strikeout
// 318 above the baseline, both 50 thick.
const ASC = 1.005
const DESC = 0.295
const UNDER_POS = 0.1
const STRIKE_POS = 0.318
const DECO_T = 0.05

// ---------------------------------------------------------------- drawing ops

type Op =
  | { k: "text"; x: number; y: number; text: string; font: FontKey; size: number; color: RGB }
  | { k: "fill"; x: number; y: number; w: number; h: number; color: RGB }
  | { k: "stroke"; x: number; y: number; w: number; h: number; t: number; color: RGB }
  | { k: "dot"; x: number; y: number; r: number; color: RGB }

const shift = (ops: readonly Op[], dx: number, dy: number): Op[] => ops.map((o) => ({ ...o, x: o.x + dx, y: o.y + dy }))

/** A quote bar: drawn down the whole height of every item inside the quote. */
interface Deco {
  x: number
  w: number
}

interface TableInfo {
  header: Unit | null
}

interface Unit {
  k: "unit"
  h: number
  ops: Op[]
  deco: Deco[]
  /** Keep on the same page as the next unit. */
  keep?: boolean
  breakBefore?: boolean
  table?: TableInfo
  /** Where an oversize unit may be cut, from its top. */
  cuts?: number[]
}

interface Margin {
  k: "margin"
  size: number
  deco: Deco[]
  breakBefore?: boolean
}

type Item = Unit | Margin

// ---------------------------------------------------------------- inline layout

interface InlineBase {
  size: number
  lh: number
  weight: 400 | 600
  color: RGB
}

interface Piece {
  kind: "word" | "space" | "nl"
  text: string
  font: FontKey
  size: number
  rise: number
  leaf: TextLeaf
  w: number
}

interface LineBox {
  h: number
  ops: Op[]
}

/** Characters the fonts cannot draw are replaced; the caller reports how many. */
export interface RenderNotes {
  missingGlyphs: number
  missingSample: string[]
}

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad]/g

function cleanText(fonts: Fonts, text: string, file: FontFile, notes: RenderNotes): string {
  let out = ""
  for (const ch of text.replace(ZERO_WIDTH, "").replace(/[\t\r\f\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")) {
    const cp = ch.codePointAt(0)!
    if (ch === " " || ch === "\n" || fonts.has(file, cp)) out += ch
    else {
      notes.missingGlyphs++
      if (notes.missingSample.length < 5 && !notes.missingSample.includes(ch)) notes.missingSample.push(ch)
      out += "?"
    }
  }
  return out
}

function piecesOf(fonts: Fonts, leaves: readonly TextLeaf[], base: InlineBase, notes: RenderNotes, tnum: boolean): Piece[] {
  const out: Piece[] = []
  for (const leaf of leaves) {
    const mono = Boolean(leaf.code)
    const weight = leaf.bold ? 700 : base.weight
    const file = fontFile(mono, weight, Boolean(leaf.italic) && !mono)
    const font: FontKey = { file, tnum }
    let size = mono ? CODE_SIZE : base.size
    let rise = 0
    if (leaf.superscript || leaf.subscript) {
      // Browser defaults: smaller, raised by a third or lowered by a fifth of the parent size.
      rise = leaf.superscript ? size / 3 : -size / 5
      size *= 0.83
    }
    const text = cleanText(fonts, leaf.text, file, notes)
    for (const m of text.matchAll(/(\n)|( +)|([^ \n]+)/g)) {
      if (m[1]) out.push({ kind: "nl", text: "\n", font, size, rise, leaf, w: 0 })
      else if (m[2]) out.push({ kind: "space", text: " ", font, size, rise, leaf, w: fonts.width(font, " ", size) })
      else {
        // A break is allowed after a hyphen, as in the browser.
        for (const part of m[3]!.split(/(?<=[-\u2010\u2013])(?=.)/)) out.push({ kind: "word", text: part, font, size, rise, leaf, w: fonts.width(font, part, size) })
      }
    }
  }
  return out
}

/** Split a word wider than the line into parts that fit (CSS would let it overflow the page). */
function splitWord(fonts: Fonts, p: Piece, max: number): Piece[] {
  const parts: Piece[] = []
  let cur = ""
  for (const ch of p.text) {
    const next = cur + ch
    if (cur && fonts.width(p.font, next, p.size) > max) {
      parts.push({ ...p, text: cur, w: fonts.width(p.font, cur, p.size) })
      cur = ch
    } else cur = next
  }
  if (cur) parts.push({ ...p, text: cur, w: fonts.width(p.font, cur, p.size) })
  return parts
}

function layoutInline(fonts: Fonts, leaves: readonly TextLeaf[], base: InlineBase, width: number, align: "left" | "right", notes: RenderNotes, tnum = false): LineBox[] {
  const pieces = piecesOf(fonts, leaves, base, notes, tnum)
  const lines: Piece[][] = []
  let line: Piece[] = []
  let x = 0
  const endLine = () => {
    while (line.length && line[line.length - 1]!.kind === "space") line.pop()
    lines.push(line)
    line = []
    x = 0
  }
  for (const p of pieces) {
    if (p.kind === "nl") {
      endLine()
      continue
    }
    if (p.kind === "space") {
      // Collapsed like white-space: normal: never at a line start, never two in a row.
      if (line.length === 0 || line[line.length - 1]!.kind === "space") continue
      line.push(p)
      x += p.w
      continue
    }
    if (x + p.w > width + 0.01 && line.some((q) => q.kind === "word")) {
      endLine()
    }
    if (p.w > width + 0.01 && line.length === 0) {
      const parts = splitWord(fonts, p, width)
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) endLine()
        line.push(parts[i]!)
        x = parts[i]!.w
      }
      continue
    }
    line.push(p)
    x += p.w
  }
  endLine()
  // A trailing line break adds no empty line, as in the browser (except on its own).
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0 && pieces.length && pieces[pieces.length - 1]!.kind === "nl") lines.pop()

  const h = base.size * base.lh
  const halfLeading = (h - (ASC + DESC) * base.size) / 2
  const baseline = halfLeading + ASC * base.size
  return lines.map((ps) => {
    const ops: Op[] = []
    const lineW = ps.reduce((s, p) => s + p.w, 0)
    let cx = align === "right" ? Math.max(0, width - lineW) : 0
    // Merge neighbours of the same look into one text op.
    let i = 0
    while (i < ps.length) {
      const first = ps[i]!
      let j = i
      let text = ""
      let w = 0
      while (j < ps.length && sameLook(ps[j]!, first)) {
        text += ps[j]!.text
        w += ps[j]!.w
        j++
      }
      const by = baseline - first.rise
      const l = first.leaf
      if (l.highlight) ops.push({ k: "fill", x: cx, y: by - ASC * first.size, w, h: (ASC + DESC) * first.size, color: MARK_BG })
      ops.push({ k: "text", x: cx, y: by, text, font: first.font, size: first.size, color: base.color })
      const t = Math.max(0.5, DECO_T * first.size)
      if (l.underline) ops.push({ k: "fill", x: cx, y: by + UNDER_POS * first.size, w, h: t, color: base.color })
      if (l.strikethrough) ops.push({ k: "fill", x: cx, y: by - STRIKE_POS * first.size - t / 2, w, h: t, color: base.color })
      cx += w
      i = j
    }
    // Highlights first, so text and lines sit on top.
    ops.sort((a, b) => (a.k === "fill" && a.color === MARK_BG ? 0 : 1) - (b.k === "fill" && b.color === MARK_BG ? 0 : 1))
    return { h, ops }
  })
}

function sameLook(a: Piece, b: Piece): boolean {
  if (a.font.file !== b.font.file || a.font.tnum !== b.font.tnum || a.size !== b.size || a.rise !== b.rise) return false
  const keys = ["underline", "strikethrough", "highlight"] as const
  return keys.every((k) => Boolean(a.leaf[k]) === Boolean(b.leaf[k]))
}

/** Narrowest (longest word) and widest (no wrapping) width of inline content. */
function inlineExtent(fonts: Fonts, leaves: readonly TextLeaf[], base: InlineBase, notes: RenderNotes): { min: number; max: number } {
  const quiet: RenderNotes = { missingGlyphs: 0, missingSample: [] }
  void notes
  let min = 0
  let max = 0
  let line = 0
  let lastSpace = true
  for (const p of piecesOf(fonts, leaves, base, quiet, false)) {
    if (p.kind === "nl") {
      max = Math.max(max, line)
      line = 0
      lastSpace = true
    } else if (p.kind === "space") {
      if (!lastSpace) line += p.w
      lastSpace = true
    } else {
      min = Math.max(min, p.w)
      line += p.w
      lastSpace = false
    }
  }
  return { min, max: Math.max(max, line) }
}

// ---------------------------------------------------------------- block layout

interface Box {
  x: number
  w: number
  deco: Deco[]
  color: RGB
  /** Inherited font size: 10.5, or 9 inside a table. */
  size: number
}

interface Ctx {
  fonts: Fonts
  notes: RenderNotes
}

const leavesOf = (b: Block): TextLeaf[] => b.children.filter(isText)

function flatText(n: DocNode): string {
  return isText(n) ? n.text : n.children.map(flatText).join(" ")
}

function linesToUnits(lines: LineBox[], box: Box, keepAll: boolean): Unit[] {
  const n = lines.length
  return lines.map((l, i) => {
    const u: Unit = { k: "unit", h: l.h, ops: shift(l.ops, box.x, 0), deco: box.deco }
    // Orphans and widows 2: the first line stays with the second, the last with the one before.
    if (keepAll || (n >= 2 && (i === 0 || i === n - 2))) u.keep = true
    return u
  })
}

function layoutBlocks(ctx: Ctx, blocks: readonly DocNode[], box: Box, out: Item[], align: "left" | "right" = "left", tnum = false) {
  for (const b of blocks) {
    if (isText(b)) continue
    const start = out.length
    layoutBlock(ctx, b, box, out, align, tnum)
    if (b.breakBefore && out.length > start) out[start]!.breakBefore = true
  }
}

function layoutBlock(ctx: Ctx, b: Block, box: Box, out: Item[], align: "left" | "right", tnum: boolean) {
  const t = b.type
  if (t === "p" || t === "lic" || /^h[1-6]$/.test(t) || t === "td" || t === "th" || t === "tr" || t === "li") {
    if (t === "li" || t === "td" || t === "th" || t === "tr") {
      // Only inside their parents normally; on their own they read as paragraphs.
      layoutBlocks(ctx, b.children, box, out, align, tnum)
      if (b.children.every(isText)) layoutParagraph(ctx, { ...b, type: "p" }, box, out, align, tnum)
      return
    }
    layoutParagraph(ctx, b, box, out, align, tnum)
    return
  }
  if (t === "hr") {
    out.push({ k: "margin", size: HR.margin, deco: box.deco })
    out.push({ k: "unit", h: HR.width, ops: [{ k: "fill", x: box.x, y: 0, w: box.w, h: HR.width, color: RULE }], deco: box.deco })
    out.push({ k: "margin", size: HR.margin, deco: box.deco })
    return
  }
  if (t === "blockquote") {
    const deco = [...box.deco, { x: box.x, w: QUOTE.bar }]
    const inner: Box = { ...box, x: box.x + QUOTE.bar + QUOTE.padLeft, w: Math.max(20, box.w - QUOTE.bar - QUOTE.padLeft), deco, color: QUOTE_TEXT }
    out.push({ k: "margin", size: 0, deco: box.deco })
    out.push({ k: "unit", h: QUOTE.padY, ops: [], deco, keep: true })
    layoutBlocks(ctx, b.children, inner, out)
    out.push({ k: "unit", h: QUOTE.padY, ops: [], deco })
    out.push({ k: "margin", size: QUOTE.bottom, deco: box.deco })
    return
  }
  if (t === "ul" || t === "ol") {
    layoutList(ctx, b, box, out)
    return
  }
  if (t === "table") {
    layoutTable(ctx, b, box, out)
    return
  }
}

function layoutParagraph(ctx: Ctx, b: Block, box: Box, out: Item[], align: "left" | "right", tnum: boolean) {
  const st = STYLE[b.type] ?? STYLE.p!
  const size = st.size ?? box.size
  const lines = layoutInline(ctx.fonts, leavesOf(b), { size, lh: st.lh, weight: st.weight, color: box.color }, box.w, align, ctx.notes, tnum)
  if (b.type !== "lic") out.push({ k: "margin", size: st.top, deco: box.deco })
  out.push(...linesToUnits(lines, box, Boolean(st.keep)))
  if (b.type !== "lic") out.push({ k: "margin", size: st.bottom, deco: box.deco })
}

function layoutList(ctx: Ctx, list: Block, box: Box, out: Item[]) {
  const inner: Box = { ...box, x: box.x + LIST_INDENT, w: Math.max(20, box.w - LIST_INDENT) }
  out.push({ k: "margin", size: 0, deco: box.deco })
  let n = 0
  for (const li of list.children) {
    if (isText(li) || li.type !== "li") continue
    n++
    const start = out.length
    for (const c of li.children) {
      if (isText(c)) continue
      if (c.type === "lic") layoutParagraph(ctx, c, inner, out, "left", false)
      else layoutBlock(ctx, c, inner, out, "left", false)
    }
    // The marker sits on the item's first line.
    const first = out.slice(start).find((x): x is Unit => x.k === "unit")
    if (first) {
      const size = box.size
      const baseline = (first.h - (ASC + DESC) * size) / 2 + ASC * size
      const space = ctx.fonts.width({ file: "Geist-Regular", tnum: false }, " ", size)
      if (list.type === "ul") {
        const r = size * 0.17
        first.ops.push({ k: "dot", x: inner.x - space - r - size * 0.12, y: baseline - size * 0.3, r, color: box.color })
      } else {
        const label = `${n}.`
        const font: FontKey = { file: "Geist-Regular", tnum: false }
        const w = ctx.fonts.width(font, label, size)
        first.ops.push({ k: "text", x: inner.x - space - w, y: baseline, text: label, font, size, color: box.color })
      }
    } else {
      // An empty item still shows its marker on one line.
      out.push({ k: "unit", h: box.size * BODY_LH, ops: [], deco: box.deco })
    }
    out.push({ k: "margin", size: LI_BOTTOM, deco: box.deco })
  }
  out.push({ k: "margin", size: LIST_BOTTOM, deco: box.deco })
}

/** Drive's lib/generate/table-cells.ts isNumericCell: the cell's text is one number. */
const SYMBOL = "[$€£¥₹₩₺₽₪₦₱฿]"
const CODE = "[A-Z]{3}"
const DIGITS = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d*)?|\\.\\d+"
const AMOUNT = `(?:${SYMBOL}\\s?|${CODE}\\s)?[+-]?(?:${SYMBOL}\\s?)?(?:${DIGITS})%?(?:\\s?${SYMBOL}|\\s${CODE})?`
const NUMERIC = new RegExp(`^(?:${AMOUNT}|\\((?:${AMOUNT})\\))$`)
export function isNumericCell(text: string): boolean {
  const t = text.replace(/[\u00a0\u202f]/g, " ").replace(/[\u200b\ufeff]/g, "").trim()
  if (t === "" || !/\d/.test(t)) return false
  return NUMERIC.test(t)
}

/** Stack items at their y offsets, merging adjacent margins; returns ops and the height. */
function stack(items: readonly Item[]): { ops: Op[]; h: number; cuts: number[] } {
  const ops: Op[] = []
  const cuts: number[] = []
  let y = 0
  let pending: Margin | null = null
  const bars = (deco: readonly Deco[], top: number, h: number) => {
    for (const d of deco) if (h > 0) ops.push({ k: "fill", x: d.x, y: top, w: d.w, h, color: RULE })
  }
  for (const it of items) {
    if (it.k === "margin") {
      pending = mergeMargin(pending as Margin | null, it)
      continue
    }
    // Inside a cell the first margin stays: a table cell keeps its children's margins.
    if (pending) {
      bars(pending.deco, y, pending.size)
      y += pending.size
      pending = null
    }
    bars(it.deco, y, it.h)
    ops.push(...shift(it.ops, 0, y))
    y += it.h
    cuts.push(y)
  }
  if (pending) bars(pending.deco, y, pending.size)
  return { ops, h: y + (pending?.size ?? 0), cuts }
}

/** Two margins in a row collapse to the larger; the quote bars are those both sit in. */
function mergeMargin(a: Margin | null, b: Margin): Margin {
  if (!a) return b
  return { ...a, size: Math.max(a.size, b.size), deco: b.deco.length < a.deco.length ? b.deco : a.deco }
}

interface PlacedCell {
  cell: Block
  r: number
  c: number
  cs: number
  rs: number
}

function blocksExtent(ctx: Ctx, blocks: readonly DocNode[], size: number): { min: number; max: number } {
  let min = 0
  let max = 0
  for (const b of blocks) {
    if (isText(b)) continue
    let e: { min: number; max: number }
    if (b.type === "ul" || b.type === "ol") {
      const kids = b.children.flatMap((li) => (isText(li) ? [] : li.children))
      const inner = blocksExtent(ctx, kids, size)
      e = { min: inner.min + LIST_INDENT, max: inner.max + LIST_INDENT }
    } else if (b.type === "blockquote") {
      const inner = blocksExtent(ctx, b.children, size)
      e = { min: inner.min + QUOTE.bar + QUOTE.padLeft, max: inner.max + QUOTE.bar + QUOTE.padLeft }
    } else if (b.type === "hr") e = { min: 0, max: 0 }
    else {
      const st = STYLE[b.type] ?? STYLE.p!
      e = inlineExtent(ctx.fonts, leavesOf(b), { size: st.size ?? size, lh: st.lh, weight: b.type === "th" ? 600 : st.weight, color: TEXT }, ctx.notes)
    }
    min = Math.max(min, e.min)
    max = Math.max(max, e.max)
  }
  return { min, max }
}

function layoutTable(ctx: Ctx, table: Block, box: Box, out: Item[]) {
  const rows = table.children.filter((r): r is Block => !isText(r) && r.type === "tr")
  if (!rows.length) return
  // Place cells on the grid, as the browser does with colspan and rowspan.
  const taken = new Set<string>()
  const cells: PlacedCell[] = []
  let ncols = 0
  rows.forEach((row, r) => {
    let c = 0
    for (const cell of row.children) {
      if (isText(cell)) continue
      while (taken.has(`${r},${c}`)) c++
      const cs = cell.colSpan ?? 1
      const rs = Math.min(cell.rowSpan ?? 1, rows.length - r)
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) taken.add(`${r + i},${c + j}`)
      cells.push({ cell, r, c, cs, rs })
      c += cs
      ncols = Math.max(ncols, c)
    }
  })
  if (!ncols) return

  // Column widths: the automatic table layout, simplified (min and max content widths).
  const padX = 2 * TABLE.padX
  const ext = cells.map((pc) => {
    const e = blocksExtent(ctx, pc.cell.children, TABLE_SIZE)
    return { min: e.min + padX, max: e.max + padX }
  })
  const colMin = new Array<number>(ncols).fill(padX)
  const colMax = new Array<number>(ncols).fill(padX)
  cells.forEach((pc, i) => {
    if (pc.cs !== 1) return
    colMin[pc.c] = Math.max(colMin[pc.c]!, ext[i]!.min)
    colMax[pc.c] = Math.max(colMax[pc.c]!, ext[i]!.max)
  })
  cells.forEach((pc, i) => {
    if (pc.cs === 1) return
    for (const [arr, need] of [[colMin, ext[i]!.min], [colMax, ext[i]!.max]] as const) {
      const have = arr.slice(pc.c, pc.c + pc.cs).reduce((s, v) => s + v, 0)
      if (have < need) for (let j = pc.c; j < pc.c + pc.cs; j++) arr[j]! += (need - have) / pc.cs
    }
  })
  const avail = box.w
  const sumMin = colMin.reduce((s, v) => s + v, 0)
  const sumMax = colMax.reduce((s, v) => s + v, 0)
  let widths: number[]
  if (sumMax <= avail) widths = colMax.map((v) => (sumMax > 0 ? (v * avail) / sumMax : avail / ncols))
  else if (sumMin <= avail) widths = colMin.map((v, i) => v + ((colMax[i]! - v) * (avail - sumMin)) / (sumMax - sumMin || 1))
  else widths = colMin.map((v) => (v * avail) / sumMin)
  const colX: number[] = [0]
  for (const w of widths) colX.push(colX[colX.length - 1]! + w)

  // Lay out each cell's content.
  const laid = cells.map((pc) => {
    const w = colX[pc.c + pc.cs]! - colX[pc.c]!
    const innerW = Math.max(4, w - padX)
    const header = pc.cell.type === "th"
    const numeric = isNumericCell(flatText(pc.cell))
    const items: Item[] = []
    const cellBox: Box = { x: 0, w: innerW, deco: [], color: TEXT, size: TABLE_SIZE }
    for (const c of pc.cell.children) {
      if (isText(c)) continue
      if (header && (c.type === "p" || c.type === "lic")) {
        // th is SemiBold: lay it out as a p with weight 600.
        const lines = layoutInline(ctx.fonts, leavesOf(c), { size: TABLE_SIZE, lh: BODY_LH, weight: 600, color: TEXT }, innerW, numeric ? "right" : "left", ctx.notes, numeric)
        items.push(...linesToUnits(lines, cellBox, false), { k: "margin", size: STYLE.p!.bottom, deco: [] })
      } else layoutBlocks(ctx, [c], cellBox, items, numeric ? "right" : "left", numeric)
    }
    const s = stack(items)
    return { ...pc, w, h: s.h + 2 * TABLE.padY, ops: s.ops, cuts: s.cuts, header }
  })

  // Row heights; a rowspan cell grows its last row when it needs more room.
  const rowH = new Array<number>(rows.length).fill(0)
  for (const l of laid) if (l.rs === 1) rowH[l.r] = Math.max(rowH[l.r]!, l.h)
  for (const l of laid) {
    if (l.rs === 1) continue
    const have = rowH.slice(l.r, l.r + l.rs).reduce((s, v) => s + v, 0)
    if (have < l.h) rowH[l.r + l.rs - 1]! += l.h - have
  }
  for (let r = 0; r < rowH.length; r++) if (rowH[r] === 0) rowH[r] = TABLE_SIZE * BODY_LH + 2 * TABLE.padY
  const rowY: number[] = [0]
  for (const h of rowH) rowY.push(rowY[rowY.length - 1]! + h)

  // Rows joined by a rowspan never part; each group is one unit (tr { break-inside: avoid }).
  const groups: Array<[number, number]> = []
  let g0 = 0
  while (g0 < rows.length) {
    let end = g0
    for (let r = g0; r <= end; r++) for (const l of laid) if (l.r === r) end = Math.max(end, l.r + l.rs - 1)
    groups.push([g0, end])
    g0 = end + 1
  }

  const headed = rows[0]!.children.length > 0 && rows[0]!.children.every((c) => !isText(c) && c.type === "th")
  const info: TableInfo = { header: null }
  out.push({ k: "margin", size: TABLE.top, deco: box.deco })
  groups.forEach(([a, z], gi) => {
    const top = rowY[a]!
    const ops: Op[] = []
    const cuts: number[] = []
    for (const l of laid) {
      if (l.r < a || l.r > z) continue
      const x = box.x + colX[l.c]!
      const y = rowY[l.r]! - top
      const h = rowY[l.r + l.rs]! - rowY[l.r]!
      if (l.header) ops.push({ k: "fill", x, y, w: l.w, h, color: TH_BG })
      ops.push(...shift(l.ops, x + TABLE.padX, y + TABLE.padY))
      cuts.push(...l.cuts.map((c) => y + TABLE.padY + c))
    }
    for (const l of laid) {
      if (l.r < a || l.r > z) continue
      ops.push({ k: "stroke", x: box.x + colX[l.c]!, y: rowY[l.r]! - top, w: l.w, h: rowY[l.r + l.rs]! - rowY[l.r]!, t: TABLE.border, color: RULE })
    }
    for (let r = a; r <= z; r++) cuts.push(rowY[r + 1]! - top)
    const u: Unit = { k: "unit", h: rowY[z + 1]! - top, ops, deco: box.deco, table: info, cuts: [...new Set(cuts)].sort((p, q) => p - q) }
    if (gi === 0 && headed && z === 0 && groups.length > 1) {
      u.keep = true
      info.header = u
    }
    out.push(u)
  })
  out.push({ k: "margin", size: TABLE.bottom, deco: box.deco })
}

// ---------------------------------------------------------------- pagination

interface Placed {
  item: Item
  y: number
  /** For a slice of an oversize unit: its offset into the unit and the visible height. */
  offset?: number
  clipH?: number
}

function paginate(items: readonly Item[], cap: number): Placed[][] {
  const pages: Placed[][] = [[]]
  let cur = pages[0]!
  let y = 0
  let pending: Margin | null = null
  let firstOnPage = true

  const newPage = () => {
    cur = []
    pages.push(cur)
    y = 0
    pending = null
    firstOnPage = true
  }

  const put = (u: Unit, allowBacktrack: boolean): void => {
    // A continued table starts the page with its header row again.
    if (firstOnPage && pages.length > 1 && u.table?.header && u !== u.table.header) {
      const hdr = u.table.header
      cur.push({ item: hdr, y })
      y += hdr.h
      firstOnPage = false
    }
    const gap = pending && !firstOnPage ? pending.size : 0
    if (y + gap + u.h <= cap + 0.01 || firstOnPage) {
      if (u.h > cap + 0.01 && firstOnPage) {
        placeOversize(u)
        return
      }
      if (pending && gap) cur.push({ item: { ...pending, size: gap }, y })
      y += gap
      cur.push({ item: u, y })
      y += u.h
      pending = null
      firstOnPage = false
      return
    }
    // Does not fit. Take the units it must stay with along to the next page.
    const moved: Item[] = []
    if (allowBacktrack) {
      // Walk back over margins and units marked keep. i ends on the last unit that stays.
      let i = cur.length - 1
      while (i >= 0 && (cur[i]!.item.k === "margin" || ((cur[i]!.item as Unit).keep && cur[i]!.offset === undefined))) i--
      // Nothing stays (the whole page is one chain): move nothing, break here.
      if (i >= 0 && i < cur.length - 1) for (const q of cur.splice(i + 1)) moved.push(q.item)
    }
    newPage()
    for (const m of moved) {
      if (m.k === "margin") pending = mergeMargin(pending, m)
      else put(m, false)
    }
    put(u, false)
  }

  const placeOversize = (u: Unit) => {
    let offset = 0
    while (u.h - offset > cap + 0.01) {
      const cuts = (u.cuts ?? []).filter((c) => c > offset + 1 && c <= offset + cap + 0.01)
      const cut = cuts.length ? cuts[cuts.length - 1]! : offset + cap
      cur.push({ item: u, y, offset, clipH: cut - offset })
      newPage()
      offset = cut
    }
    cur.push({ item: u, y, offset, clipH: u.h - offset })
    y += u.h - offset
    firstOnPage = false
  }

  for (const it of items) {
    if (it.breakBefore && !firstOnPage) newPage()
    if (it.k === "margin") {
      if (firstOnPage && cur.length === 0) continue
      pending = mergeMargin(pending, it)
      continue
    }
    put(it, true)
  }
  return pages
}

// ---------------------------------------------------------------- drawing

class Painter {
  private embedded = new Map<string, Promise<PDFFont>>()
  constructor(
    private readonly pdf: PDFDocument,
    private readonly load: (f: FontFile) => Uint8Array
  ) {}

  font(key: FontKey): Promise<PDFFont> {
    const k = `${key.file}${key.tnum ? "+t" : ""}`
    let f = this.embedded.get(k)
    if (!f) {
      f = this.pdf.embedFont(this.load(key.file), { subset: true, ...(key.tnum ? { features: { tnum: true } } : {}) })
      this.embedded.set(k, f)
    }
    return f
  }

  async draw(page: PDFPage, ops: readonly Op[], top: number) {
    const H = page.getHeight()
    for (const o of ops) {
      if (o.k === "text") {
        page.drawText(o.text, { x: o.x, y: H - (top + o.y), size: o.size, font: await this.font(o.font), color: o.color })
      } else if (o.k === "fill") {
        page.drawRectangle({ x: o.x, y: H - (top + o.y + o.h), width: o.w, height: o.h, color: o.color })
      } else if (o.k === "stroke") {
        page.drawRectangle({ x: o.x, y: H - (top + o.y + o.h), width: o.w, height: o.h, borderColor: o.color, borderWidth: o.t })
      } else {
        page.drawCircle({ x: o.x, y: H - (top + o.y), size: o.r, color: o.color })
      }
    }
  }
}

export interface RenderOptions {
  paper?: PaperId
  /** PDF title metadata. */
  title?: string
  /** Read a bundled font file. */
  loadFont: (f: FontFile) => Uint8Array
  /** Stop and report once the document is longer than this (pages are still counted). */
  maxPages?: number
}

export interface RenderResult {
  /** Undefined when the page count is over maxPages: nothing was drawn. */
  bytes?: Uint8Array
  pages: number
  notes: RenderNotes
}

/** Lay out the blocks; returns the page count, and the PDF when within maxPages. */
export async function renderPdf(blocks: readonly Block[], opts: RenderOptions): Promise<RenderResult> {
  const paper = PAPERS[opts.paper ?? "a4"]
  const W = mmToPt(paper.widthMm)
  const H = mmToPt(paper.heightMm)
  const contentW = W - MARGIN.left - MARGIN.right
  const contentH = H - MARGIN.top - MARGIN.bottom
  const fonts = new Fonts(opts.loadFont)
  const notes: RenderNotes = { missingGlyphs: 0, missingSample: [] }
  const items: Item[] = []
  layoutBlocks({ fonts, notes }, blocks, { x: MARGIN.left, w: contentW, deco: [], color: TEXT, size: BODY_SIZE }, items)
  const pages = paginate(items, contentH)
  if (opts.maxPages !== undefined && pages.length > opts.maxPages) return { pages: pages.length, notes }

  const pdf = await PDFDocument.create({ updateMetadata: false })
  pdf.registerFontkit(fontkit)
  pdf.setTitle(opts.title || "Untitled document")
  pdf.setCreator("Untrace")
  pdf.setProducer("Untrace")
  const painter = new Painter(pdf, opts.loadFont)
  const footerFont: FontKey = { file: "Geist-Regular", tnum: false }
  for (let i = 0; i < pages.length; i++) {
    const page = pdf.addPage([W, H])
    for (const p of pages[i]!) {
      const top = MARGIN.top + p.y
      const h = p.item.k === "unit" ? (p.clipH ?? p.item.h) : p.item.size
      for (const d of p.item.deco) page.drawRectangle({ x: d.x, y: H - (top + h), width: d.w, height: h, color: RULE })
      if (p.item.k !== "unit") continue
      if (p.offset === undefined) {
        await painter.draw(page, p.item.ops, top)
        continue
      }
      // A slice of a unit taller than a page: draw it shifted up, clipped to the slice.
      page.pushOperators(pushGraphicsState(), rectangle(0, H - (top + h), W, h), clip(), endPath())
      await painter.draw(page, p.item.ops, top - p.offset)
      page.pushOperators(popGraphicsState())
    }
    const label = `${i + 1} / ${pages.length}`
    const lw = fonts.width(footerFont, label, FOOTER_SIZE)
    const baseY = MARGIN.bottom / 2 - (0.71 * FOOTER_SIZE) / 2
    page.drawText(label, { x: (W - lw) / 2, y: baseY, size: FOOTER_SIZE, font: await painter.font(footerFont), color: FOOTER })
  }
  const bytes = await pdf.save({ useObjectStreams: true })
  return { bytes, pages: pages.length, notes }
}
