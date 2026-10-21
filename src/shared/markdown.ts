/**
 * A small, safe Markdown reader for the vault's notes (the parts of Obsidian's flavour the ARH IT
 * notes use). It returns a tree, never HTML: the renderer draws it with text nodes only, so a
 * note can never inject markup or script into the dashboard.
 *
 * Covered: frontmatter, headings, paragraphs (single newlines are line breaks, as in Obsidian),
 * fenced and indented code, block quotes and callouts (> [!danger]- Title), ordered/unordered/
 * nested lists with task boxes, tables, rules, **bold** *italic* ~~strike~~ ==highlight==
 * `code`, [links](), bare https:// links, [[wikilinks|alias]] [[Note#Heading]] ![[embeds]],
 * #tags. Hidden like in Obsidian's reading view: <!-- comments --> (including the dashboard's
 * markers), %% comments %% and ^block-ids. Every block keeps its 1-based source line so the
 * viewer can jump to a line.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong' | 'em' | 'del' | 'mark'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'wiki'; target: string; heading?: string; alias?: string; embed: boolean }
  | { t: 'tag'; v: string }
  | { t: 'br' }

export interface ListItem {
  line: number
  /** Task status character (' ' open, 'x' done, '/' and others as written); absent for plain items. */
  task?: string
  c: Block[]
}

export type Block =
  | { t: 'heading'; line: number; level: number; c: Inline[]; text: string }
  | { t: 'para'; line: number; c: Inline[] }
  | { t: 'code'; line: number; lang: string; v: string }
  | { t: 'quote'; line: number; c: Block[] }
  | {
      t: 'callout'
      line: number
      kind: string
      fold: '' | '+' | '-'
      title: Inline[]
      c: Block[]
    }
  | { t: 'list'; line: number; ordered: boolean; start: number; items: ListItem[] }
  | {
      t: 'table'
      line: number
      align: Array<'left' | 'center' | 'right' | null>
      head: Inline[][]
      rows: Inline[][][]
      /** Source line of each row. */
      rowLines: number[]
    }
  | { t: 'hr'; line: number }

export interface ParsedNote {
  frontmatter: Array<[string, string]>
  blocks: Block[]
  /** Every wikilink target in the note (without #heading or |alias), in order, once each. */
  links: string[]
  /** Each wikilink with its source line, properties included (for backlinks). */
  linkLines: Array<{ target: string; line: number }>
}

interface Line {
  n: number
  s: string
  /** A list item's line that it holds only lazily (unindented, after its text). */
  lazy?: true
}

/* ---------- frontmatter and comments ---------- */

/** A YAML scalar without its quotes: "11:31" and 'it''s' show as written in Obsidian. */
function unquote(v: string): string {
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"'))
    return v.slice(1, -1).replace(/\\(["\\])/g, '$1')
  return v
}

/** The text of a YAML block scalar: `|` keeps its line breaks, `>` folds lines into one. */
function blockScalar(lines: string[], fold: boolean): string {
  const indent = Math.min(...lines.filter((l) => l.trim()).map(indentOf))
  const text = lines
    .map((l) => l.slice(indent).trimEnd())
    .join('\n')
    .trim()
  return fold ? text.replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/\n\n+/g, '\n') : text
}

function frontmatter(lines: string[]): { data: Array<[string, string]>; end: number } {
  if ((lines[0] ?? '').trim() !== '---') return { data: [], end: 0 }
  const data: Array<[string, string]> = []
  // the indented lines of a "key: |" or "key: >" block being read
  let scalar: { fold: boolean; lines: string[] } | null = null
  for (let i = 1; i < lines.length && i < 400; i++) {
    const line = lines[i] ?? ''
    const last = data[data.length - 1]
    if (scalar && last) {
      if (!line.trim() || /^\s/.test(line)) {
        scalar.lines.push(line)
        continue
      }
      last[1] = blockScalar(scalar.lines, scalar.fold)
      scalar = null
    }
    if (line.trim() === '---' || line.trim() === '...') return { data, end: i + 1 }
    const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(line)
    if (kv?.[1]) {
      const v = (kv[2] ?? '').trim()
      const block = /^([|>])[+-]?[1-9]?$/.exec(v)
      if (block) scalar = { fold: block[1] === '>', lines: [] }
      data.push([kv[1].trim(), block ? '' : unquote(v)])
    } else if (last) {
      // "- item" under a key: a YAML list, shown as "a, b"; "  child: x" under a key: "child: x"
      const item = /^\s*-\s+(.*)$/.exec(line)
      const child = /^\s+([^\s:#][^:]*):\s*(.*)$/.exec(line)
      const v = item?.[1]
        ? unquote(item[1].trim())
        : child?.[1]
          ? `${child[1].trim()}: ${unquote((child[2] ?? '').trim())}`.trim()
          : ''
      if (v) last[1] = last[1] ? `${last[1]}, ${v}` : v
    }
  }
  return { data: [], end: 0 } // no closing line: not frontmatter
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)/

/**
 * What parseBlocks has open at one level of a note: the note itself, a quote's or callout's
 * body, or a list item's body. `fresh`: the level has no line yet or its last line was blank
 * (parseBlocks' afterBlank). A quote's `title`: its one line so far is a callout's title.
 */
interface Level {
  depth: number
  fresh: boolean
  open:
    | { t: 'none' | 'para' | 'table' | 'indented' }
    | { t: 'fence'; mark: string }
    | { t: 'quote'; inner: Level; title?: true }
    | { t: 'item'; base: number; ordered: boolean; content: number; blank: boolean; inner: Level }
}

/**
 * How one line reads: the level after it, whether it is code, whether it goes on a paragraph,
 * and its text as the innermost level sees it (past its quote and list markers).
 */
interface Read {
  l: Level
  code: boolean
  joins: boolean
  text: string
}

/**
 * The lines after the one being read: `at(j)` is the j-th (from 1) as one level sees it, null
 * once the level has ended before it; `raw(j)` is the same line as written.
 */
interface Ahead {
  at: (j: number) => string | null
  raw: (j: number) => string | null
}

const newLevel = (depth: number): Level => ({ depth, fresh: true, open: { t: 'none' } })

/**
 * The j-th line ahead where a table start reads it, which is only to see whether it is a
 * delimiter row. A level sees a line without some of its leading spaces and quote markers, so
 * it can be one only if the line as written is one without them; only then is the level's view
 * worked out (for a list item that can mean looking a line further, and so on down the levels).
 */
const delimAt = (ahead: Ahead, j: number) => (): string =>
  TABLE_SEP.test((ahead.raw(j) ?? '').replace(/^[\s>]+/, '')) ? (ahead.at(j) ?? '') : ''

/**
 * The lines ahead as a level inside another sees them, each worked out once and only when asked
 * for: `view` gets a line as the outer level sees it and returns it as the inner one does, or
 * null where the inner level ends (it stays ended).
 */
function within(ahead: Ahead, view: (s: string, j: number) => string | null): Ahead {
  const seen: Array<string | null> = []
  const at = (j: number): string | null => {
    while (seen.length < j) {
      const prev = seen.length ? seen[seen.length - 1] : ''
      const s = prev === null ? null : ahead.at(seen.length + 1)
      seen.push(s === null ? null : view(s, seen.length + 1))
    }
    return seen[j - 1] ?? null
  }
  return { at, raw: ahead.raw }
}

/** A quote's lines ahead: its body, up to the first line that is not quoted. */
const inQuote = (ahead: Ahead): Ahead =>
  within(ahead, (s) => {
    const m = QUOTE.exec(s)
    return m ? (m[1] ?? '') : null
  })

/** A list item's lines ahead, as inItem collects them; `blank`: the line being read is blank. */
function inItemAhead(ahead: Ahead, base: number, content: number, blank: boolean): Ahead {
  let lastBlank = blank
  return within(ahead, (s, j) => {
    const own = inItem(base, content, lastBlank, s, indentOf(s), delimAt(ahead, j + 1))
    lastBlank = !s.trim()
    return own
  })
}

/**
 * A line as a list item's body holds it, as parseBlocks collects the body: blank, indented past
 * the item's marker, or a lazy line right after text (not past `base`); null when the item ends
 * before it. `ind` is the line's indent. `next` gives the line after `s`, read only when a table
 * start could end the item there.
 */
function inItem(
  base: number,
  content: number,
  lastBlank: boolean,
  s: string,
  ind: number,
  next: () => string
): string | null {
  if (!s.trim()) return ''
  if (ind > base) return expandTabs(s).slice(Math.min(ind, content))
  return !lastBlank && !blockStart(s, next) ? s.trim() : null
}

/**
 * Reads one line at a level the way parseBlocks does, rule for rule and in its order: whether
 * the line is code there, and whether it goes on the paragraph of the line before (so that
 * parseInline reads the two as one text). `s` and the lines `ahead` are as the level sees them.
 * Returns a new level; `l` stays as it was.
 */
function step(l: Level, s: string, ahead: Ahead): Read {
  const blank = !s.trim()
  // past MAX_NEST, parseBlocks reads all of a body's lines as one paragraph
  if (l.depth > MAX_NEST)
    return { l: { ...l, fresh: l.fresh && blank }, code: false, joins: !l.fresh && !blank, text: s }
  const next = delimAt(ahead, 1)
  const to = (open: Level['open'], code: boolean, joins = false, text = s): Read => ({
    l: { depth: l.depth, fresh: blank, open },
    code,
    joins,
    text
  })
  const o = l.open
  // the open block goes on
  if (o.t === 'fence') {
    const t = s.trim()
    const close = t.startsWith(o.mark[0]!.repeat(o.mark.length)) && /^[`~]+$/.test(t)
    return to(close ? { t: 'none' } : o, true)
  }
  if (o.t === 'indented' && (blank || indentOf(s) >= 4)) return to(o, true)
  if (o.t === 'para' && !blank && !blockStart(s, next, true)) return to(o, false, true)
  if (o.t === 'table' && !blank && s.includes('|') && !otherStart(s, false)) return to(o, false)
  const quote = QUOTE.exec(s)
  if (o.t === 'quote' && quote) {
    const r = step(o.inner, quote[1] ?? '', inQuote(ahead))
    return to({ t: 'quote', inner: r.l }, r.code, r.joins, r.text)
  }
  const ind = indentOf(s)
  if (o.t === 'item') {
    // the item goes on with the line, unless its fence is open and the line is lazy: a fence
    // takes no lazy line, so the item ends there (CommonMark)
    const fenced = !blank && ind <= o.base && o.inner.open.t === 'fence'
    const own = fenced ? null : inItem(o.base, o.content, o.blank, s, ind, next)
    if (own !== null) {
      const r = step(o.inner, own, inItemAhead(ahead, o.base, o.content, blank))
      return to({ ...o, blank, inner: r.l }, r.code, r.joins, r.text)
    }
  }
  // matched only now: a list d deep reads each of its lines at every level, most going on an item
  const item = ITEM.exec(s)
  const startItem = (m: RegExpExecArray): Read => {
    const { content, first } = itemText(s, m)
    const r = step(newLevel(l.depth + 1), first, inItemAhead(ahead, ind, content, false))
    const open = { t: 'item' as const, base: ind, ordered: !!m[3], content, blank: false }
    return to({ ...open, inner: r.l }, r.code, r.joins, r.text)
  }
  // or the list goes on with its next item, whatever else the line could start
  if (o.t === 'item' && item?.[4] !== undefined && ind === o.base && !!item[3] === o.ordered)
    return startItem(item)
  if (blank) return to({ t: 'none' }, false)
  // a new block
  const fence = FENCE.exec(s)
  if (fence?.[2]) return to({ t: 'fence', mark: fence[2] }, true)
  if (l.fresh && ind >= 4 && item?.[4] === undefined) return to({ t: 'indented' }, true)
  if (HEADING.test(s) || HR.test(s)) return to({ t: 'none' }, false)
  if (tableStart(s, next, o.t === 'para')) return to({ t: 'table' }, false)
  if (quote) {
    const inner = newLevel(l.depth + 1)
    // a callout's title line is not part of its body
    if (CALLOUT.test(quote[1] ?? ''))
      return to({ t: 'quote', inner, title: true }, false, false, quote[1])
    const r = step(inner, quote[1] ?? '', inQuote(ahead))
    return to({ t: 'quote', inner: r.l }, r.code, r.joins, r.text)
  }
  if (item?.[4] !== undefined) return startItem(item)
  return to({ t: 'para' }, false)
}

/**
 * Whether `b` is `a` except that, at its innermost level, its line is blank: how a line whose
 * text there held only a comment reads (`> %% note %%` is an empty quoted line).
 */
function blankInner(a: Level, b: Level): boolean {
  if (b.fresh) return !a.fresh
  if (a.fresh) return false
  const x = a.open
  const y = b.open
  // (a callout's title line leaves its body as fresh as a blank line would)
  if (x.t === 'quote' && y.t === 'quote')
    return !x.title && !y.title && blankInner(x.inner, y.inner)
  if (x.t === 'item' && y.t === 'item')
    return (
      x.base === y.base &&
      x.ordered === y.ordered &&
      x.content === y.content &&
      x.blank === y.blank &&
      blankInner(x.inner, y.inner)
    )
  return false
}

/** Whether two levels are alike, so that the lines after them read alike. */
function sameLevel(a: Level, b: Level): boolean {
  if (a === b) return true
  const x = a.open
  const y = b.open
  if (a.depth !== b.depth || a.fresh !== b.fresh || x.t !== y.t) return false
  if (x.t === 'fence' && y.t === 'fence') return x.mark === y.mark
  if (x.t === 'quote' && y.t === 'quote') return x.title === y.title && sameLevel(x.inner, y.inner)
  if (x.t === 'item' && y.t === 'item')
    return (
      x.base === y.base &&
      x.ordered === y.ordered &&
      x.content === y.content &&
      x.blank === y.blank &&
      sameLevel(x.inner, y.inner)
    )
  return true
}

/**
 * Stands in a line of text where a comment was hidden. parseBlocks reads the line's shape with
 * it in place, as if the comment were still there, so hiding `%% note %%` never makes the rest
 * of a line a fence, indented code, a heading or a table's delimiter row; it is not shown.
 */
const HIDDEN = '\uFDD0'
/**
 * Goes before each %% and <!-- that stripComments keeps because it reads it in a code span. A
 * code span drops it; anywhere else parseMarkdown finds it and reads those lines again with
 * every comment hidden. Like HIDDEN, it changes nothing in how a line reads.
 */
const KEPT = '\uFDD1'
/** `s` without HIDDEN. */
const shown = (s: string): string => (s.includes(HIDDEN) ? s.split(HIDDEN).join('') : s)
/** Code as written: without HIDDEN or KEPT. */
const codeText = (s: string): string =>
  s.includes(KEPT) ? shown(s).split(KEPT).join('') : shown(s)
const isGap = (c: string): boolean => c === HIDDEN || /\s/.test(c)
/** `s` trimmed of spaces and HIDDEN at both ends (by index: a regex here is quadratic). */
function trimShown(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && isGap(s[a]!)) a++
  while (b > a && isGap(s[b - 1]!)) b--
  return s.slice(a, b)
}

/** The comment a line ends in, so the next line starts in it. */
type Open = '%%' | '-->' | null

/** One line with its comments hidden: `bare` without them, `marked` with HIDDEN for each. */
interface Hidden {
  bare: string
  marked: string
  open: Open
  /** The run of backticks the line leaves open, which a later line of its paragraph may close. */
  tick: string | null
}

/** A line's comments, or its code spans, as [start, end) of the line in order. */
type Ranges = Array<[number, number]>

/**
 * Adds to `cut` the comments of `raw` from `i` on: one opens at %% or <!-- outside the code
 * `spans` and runs to its end, or past the end of the line, and then that is returned.
 */
function findComments(raw: string, i: number, spans: Ranges, cut: Ranges): Open {
  // where the next opener of each kind is from i, found again only once i has passed it
  let pct = -2
  let html = -2
  let k = 0
  while (i < raw.length) {
    if (pct !== -1 && pct < i) pct = raw.indexOf('%%', i)
    if (html !== -1 && html < i) html = raw.indexOf('<!--', i)
    const at = pct === -1 ? html : html === -1 ? pct : Math.min(pct, html)
    if (at === -1) break
    while (k < spans.length && spans[k]![1] <= at) k++
    const span = spans[k]
    // a span that starts before the opener holds it (one that starts in a comment is none)
    if (span && span[0] >= i && span[0] < at) {
      i = span[1]
      continue
    }
    const close = at === pct ? '%%' : '-->'
    const end = raw.indexOf(close, at + (at === pct ? 2 : 4))
    if (end === -1) {
      cut.push([at, raw.length])
      return close
    }
    cut.push([at, end + close.length])
    i = end + close.length
  }
  return null
}

/** The code spans parseInline reads in `raw` from `at` on, with the comments in `cut` hidden. */
function readSpans(raw: string, cut: Ranges, at: number): Probe {
  // each hidden character is a HIDDEN, so the spans are where they are in raw
  let text = ''
  let i = 0
  for (const [a, b] of cut) {
    text += raw.slice(i, a) + HIDDEN.repeat(b - a)
    i = b
  }
  text = (text + raw.slice(i)).slice(at)
  // the text as parseBlocks gives it to parseInline: trimmed of spaces and hidden comments
  let lead = 0
  while (lead < text.length && isGap(text[lead]!)) lead++
  const probe: Probe = { spans: [], open: null }
  readInline(trimShown(text), 0, probe, at + lead)
  return probe
}

/** `raw` with the comments in `cut` hidden, and KEPT before each %% and <!-- it keeps. */
function written(raw: string, cut: Ranges, open: Open, tick: string | null): Hidden {
  const keep = (s: string): string =>
    s.includes('%%') || s.includes('<!--') ? s.replace(/%%|<!--/g, `${KEPT}$&`) : s
  let bare = ''
  let marked = ''
  let i = 0
  for (const [a, b] of cut) {
    const t = keep(raw.slice(i, a))
    bare += t
    marked += t + HIDDEN
    i = b
  }
  const t = keep(raw.slice(i))
  return { bare: bare + t, marked: marked + t, open, tick }
}

/** How many times hideComments reads a line's code spans before it hides all its comments. */
const MAX_READS = 4

/** Whether a line has a comment marker in it. */
const hasMarker = (s: string): boolean => s.includes('%%') || s.includes('<!--')

/** The run of backticks a reading leaves open, unless it is in a comment (then it is none). */
function leftOpen(read: Probe, cut: Ranges): string | null {
  const run = read.open
  return run && !cut.some(([a, b]) => a <= run.at && run.at < b) ? run.run : null
}

/**
 * Whether hiding the comments in `cut` from its k-th on leaves the code spans parseInline reads
 * in `raw` from `i`, and the run of backticks it leaves open, as they are: none of them holds a
 * backtick, an emphasis delimiter or a \, nor comes right before a # (hidden where the text
 * starts, it would make that # a tag, which can take a _), and the text has no link, wikilink or
 * URL one could be part of. The rest of what parseInline reads takes no backtick, and a comment,
 * like HIDDEN, starts and ends with neither a space nor a letter.
 */
function spansKept(raw: string, i: number, cut: Ranges, k: number): boolean {
  if (raw.includes('[', i) || raw.includes('://', i)) return false
  for (; k < cut.length; k++) {
    const [a, b] = cut[k]!
    if (/[`*_~=\\]/.test(raw.slice(a, b)) || raw[b] === '#') return false
  }
  return true
}

/**
 * One line with its comments hidden. A comment opens at %% or <!-- wherever parseInline reads
 * the line as text, so not in a code span, and the code spans are the ones parseInline reads in
 * the line once its comments are hidden: a backtick that a link's label, a wikilink or a URL
 * takes is theirs, \` is a backtick, and so on. So the line is read by parseInline itself, first
 * with no comment hidden, then with the ones found hidden, until two readings agree (or hiding
 * them cannot change the first); after MAX_READS every comment in it is hidden.
 * `from`: where the line's text starts, past its markers (copied as they are). `open`: the
 * comment the line starts in. `tick`: the run of backticks a line before left open, which closes
 * the span at its next run here; until it does, every comment is hidden. `plain`: every comment
 * is hidden, in code spans too. `later`: a later line may use the run this line leaves open (if
 * not, it is not worked out).
 */
function hideComments(
  raw: string,
  from: number,
  open: Open,
  tick: string | null,
  plain: boolean,
  later: boolean
): Hidden {
  const cut: Ranges = []
  let i = 0
  if (open) {
    const end = raw.indexOf(open)
    if (end === -1) return written(raw, [[0, raw.length]], open, tick)
    i = end + open.length
    cut.push([0, i])
  }
  i = Math.max(i, from)
  if (tick && !plain) {
    const end = raw.indexOf(tick, i)
    if (end === -1) return written(raw, cut, findComments(raw, i, [], cut), tick)
    i = end + tick.length
  }
  if (plain || !raw.includes('`', i)) return written(raw, cut, findComments(raw, i, [], cut), null)
  const pct = raw.indexOf('%%', i)
  const html = raw.indexOf('<!--', i)
  const first = pct === -1 ? html : html === -1 ? pct : Math.min(pct, html)
  if (first === -1 || first > raw.lastIndexOf('`')) {
    // no comment can be in a code span, however the line reads: its spans give only the run it
    // leaves open, read with its comments hidden as the readings below would end up doing
    const o = findComments(raw, i, [], cut)
    return written(raw, cut, o, later ? leftOpen(readSpans(raw, cut, i), cut) : null)
  }
  const before = cut.length
  let read = readSpans(raw, cut, i)
  // the comments `read` was read with: read with the same ones, the line reads the same
  let readWith = cut.join(';')
  let last = ''
  for (let k = 0; k < MAX_READS; k++) {
    cut.length = before
    const o = findComments(raw, i, read.spans, cut)
    const left = leftOpen(read, cut)
    // the next reading would find what this one did (with each line read twice, 1.8 MB of table
    // rows with comments took 40% longer)
    if (k === 0 && spansKept(raw, i, cut, before)) return written(raw, cut, o, left)
    const found = cut.join(';')
    const key = `${found} ${left}`
    if (key === last) return written(raw, cut, o, left)
    last = key
    if (found !== readWith) read = readSpans(raw, cut, i)
    readWith = found
  }
  cut.length = before
  return written(raw, cut, findComments(raw, i, [], cut), null)
}

/** Where in `raw` the text of it that a level sees (`view`, past the line's markers) starts. */
function textStart(raw: string, view: string): number {
  const t = view.trim()
  const s = raw.trimEnd()
  return t && s.endsWith(t) ? s.length - t.length : 0
}

/** A reading again of what `prev` read, where lines `first` to `last` have changed since. */
interface Again<T> {
  prev: T
  first: number
  last: number
}

/**
 * How many lines apart stripComments and the top level of parseBlocks note where they are, so
 * that a reading again can start there and see where it is back where the one before was (with
 * one noted per line, all kept alive, a note read again in full took 15% longer).
 */
const MARK_EVERY = 32

/** Where stripComments is before a line: the levels open there, and the comment and run it is in. */
interface Before {
  at: Level
  open: Open
  tick: string | null
}

/** stripComments' lines, and where it was before line m * MARK_EVERY for each m. */
interface Stripped {
  out: string[]
  marks: Before[]
}

/**
 * Hides <!-- --> and %% %% comments outside code, keeping every line where it was. Code is what
 * parseBlocks reads as code, followed line by line with step(), and the code spans parseInline
 * reads (hideComments); comment markers in it are text. Hiding a comment leaves the line's shape
 * as written (HIDDEN stands in for it), except that a line, or a quote's or list item's line,
 * that held only a comment is blank there, as in reading view. A line that starts in a comment
 * is not read for code: the comment goes on over it. On a line `plain` names, every comment is
 * hidden, in code spans too. `again`: the reading before, when lines `first` to `last` have become
 * plain since; the lines before those read as they did, and so does the rest once a line after
 * them is read from where it was before.
 */
function stripComments(
  lines: string[],
  plain: (k: number) => boolean,
  again?: Again<Stripped>
): Stripped {
  // read again from the last line noted before the first that changed
  const m0 = Math.floor((again?.first ?? 0) / MARK_EVERY)
  const out = again ? again.prev.out.slice(0, m0 * MARK_EVERY) : []
  const marks = again ? again.prev.marks.slice(0, m0) : []
  // whether a line after line k, before the next blank one, has a comment marker: only such a
  // line can use the run of backticks line k leaves open (a blank line ends it)
  const later = new Array<boolean>(lines.length).fill(false)
  for (let k = lines.length - 1, seen = false; k >= 0; k--) {
    later[k] = seen
    seen = !!lines[k]!.trim() && (seen || hasMarker(lines[k]!))
  }
  const start = again?.prev.marks[m0]
  let open: Open = start?.open ?? null
  let tick: string | null = start?.tick ?? null
  let at = start?.at ?? newLevel(0)
  for (let k = m0 * MARK_EVERY; k < lines.length; k++) {
    if (k % MARK_EVERY === 0) {
      const m = k / MARK_EVERY
      const was = again && k > again.last ? again.prev.marks[m] : undefined
      if (again && was && was.open === open && was.tick === tick && sameLevel(was.at, at)) {
        // from where it was before, the rest reads as it did
        for (let j = k; j < lines.length; j++) out.push(again.prev.out[j]!)
        for (let j = m; j < again.prev.marks.length; j++) marks.push(again.prev.marks[j]!)
        break
      }
      marks.push({ at, open, tick })
    }
    const raw = lines[k]!
    const rawAt = (j: number): string | null => lines[k + j] ?? null
    const read = open ? null : step(at, raw, { at: rawAt, raw: rawAt })
    // code, or a line with no comment marker whose open run no later line can use, is as written
    if (read && (read.code || (!later[k] && !hasMarker(raw)))) {
      out.push(raw)
      at = read.l
      tick = null
      continue
    }
    const from = read ? textStart(raw, read.text) : 0
    const hide = (wait: string | null): { s: string; r: Read; open: Open; tick: string | null } => {
      const h = hideComments(raw, from, open, wait, plain(k), later[k]!)
      // the lines ahead as they will be written: one that starts in this line's comment shows
      // only what follows its end
      const shownAt = (j: number): string | null => {
        const o = h.open
        for (let m = 1; o && m <= j; m++) {
          const x = lines[k + m]
          if (x === undefined) return null
          const end = x.indexOf(o)
          if (m === j) return end === -1 ? '' : HIDDEN + x.slice(end + o.length)
          if (end !== -1) break // the lines after the one it ends on are taken as written
        }
        return lines[k + j] ?? null
      }
      const after: Ahead = { at: shownAt, raw: rawAt }
      const rest = { open: h.open, tick: h.tick }
      if (!h.bare.trim()) {
        // a line that held only a comment disappears (blank)
        const s = raw.trim() ? '' : raw
        return { s, r: s === raw && read ? read : step(at, s, after), ...rest }
      }
      // HIDDEN keeps the line's shape, unless a comment held its only pipes (a table row) or
      // the next line starts in its comment
      const same = read && !h.open && raw.includes('|') === h.marked.includes('|')
      const marked = same ? read : step(at, h.marked, after)
      if (h.bare === h.marked) return { s: h.marked, r: marked, ...rest }
      // a quote's or item's line that held only a comment is blank there; its bare line ends
      // in a marker then ("> ", "- [ ] ")
      if (!/[>*+\-.)\]]\s*$/.test(h.bare)) return { s: h.marked, r: marked, ...rest }
      const bare = step(at, h.bare, after)
      return blankInner(marked.l, bare.l)
        ? { s: h.bare, r: bare, ...rest }
        : { s: h.marked, r: marked, ...rest }
    }
    let line = hide(tick)
    // a run waited for on the line before is text when this line starts a new paragraph
    if (tick && !line.r.joins) line = hide(null)
    out.push(line.s)
    at = line.r.l
    open = line.open
    tick = line.tick
  }
  return { out, marks }
}

/* ---------- inline ---------- */

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

function pushText(out: Inline[], text: string): void {
  const v = shown(text)
  if (!v) return
  const last = out[out.length - 1]
  if (last && last.t === 'text') last.v += v
  else out.push({ t: 'text', v })
}

export function safeHref(url: string): string | null {
  const u = url.trim()
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null
}

function wiki(text: string, embed: boolean): Inline {
  const [beforeAlias, ...aliasParts] = shown(text).split('|')
  const alias = aliasParts.join('|').trim() || undefined
  // [[Note\|alias]] copied out of a table keeps its escape: the \ is not part of the name
  const [target, ...headingParts] = (beforeAlias ?? '').replace(/\\$/, '').split('#')
  const heading = headingParts.join('#').replace(/^\^/, '').trim() || undefined
  return { t: 'wiki', target: (target ?? '').trim(), heading, alias, embed }
}

/** Finds the closing delimiter for an emphasis run: not escaped, not preceded by a space. */
function findClose(s: string, from: number, delim: string): number {
  const c = delim[0]!
  for (let i = from; i <= s.length - delim.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === '`') {
      const run = /^`+/.exec(s.slice(i))?.[0] ?? '`'
      const end = s.indexOf(run, i + run.length)
      if (end !== -1) i = end + run.length - 1
      continue
    }
    if ((c === '*' || c === '_') && s[i] === c) {
      // a run of * or _ is read whole: it closes a delimiter as long as itself, or with its last
      // one or two characters a * or ** inside *** (the rest closes the inner text)
      const start = i
      while (s[i + 1] === c) i++
      const len = i - start + 1
      const at = len === delim.length ? start : len === 3 ? i + 1 - delim.length : -1
      if (at === -1 || start <= from || /\s/.test(s[start - 1] ?? ' ')) continue
      if (c === '_' && /[A-Za-z0-9]/.test(s[i + 1] ?? '')) continue // intraword underscore
      return at
    }
    if (s.startsWith(delim, i) && i > from && !/\s/.test(s[i - 1] ?? ' ')) return i
  }
  return -1
}

const EMPHASIS: Array<[string, Inline['t']]> = [
  ['***', 'strong'],
  ['**', 'strong'],
  ['__', 'strong'],
  ['~~', 'del'],
  ['==', 'mark'],
  ['*', 'em'],
  ['_', 'em']
]

/**
 * Links and emphasis nested deeper than this are read as text, so no line can exhaust the stack
 * (each level reads its text again: 10000 nested links took 30 s before overflowing it).
 */
const MAX_INLINE_NEST = 32

/**
 * What readInline found while it read a text, for stripComments: each code span as [start, end)
 * of the text, and the first run of backticks at the top level with no run to close it there
 * (in a paragraph, a later line may close it).
 */
interface Probe {
  spans: Array<[number, number]>
  open: { at: number; run: string } | null
}

export function parseInline(s: string): Inline[] {
  return readInline(s, 0, null, 0)
}

/** parseInline at a depth; `base` is where `s` starts in the text the probe is given. */
function readInline(s: string, depth: number, probe: Probe | null, base: number): Inline[] {
  const out: Inline[] = []
  // the text of a link or of emphasis, read one level down; past MAX_INLINE_NEST it is text
  const nested = (from: number, to: number): Inline[] => {
    if (depth < MAX_INLINE_NEST) return readInline(s.slice(from, to), depth + 1, probe, base + from)
    const text: Inline[] = []
    pushText(text, s.slice(from, to))
    return text
  }
  // What one scan already showed, so a long paragraph full of unmatched openers (* _ [[ [ `)
  // costs one scan per kind instead of one per opener: delimiters with no closer, the shortest
  // backtick run with no closer, the next ]] and line break, and where each [ and ( closes.
  const noClose = new Set<string>()
  let noTick = Infinity
  let wikiEnd = -2
  let lineEnd = -2
  let brackets: Map<number, number> | null = null
  let parens: Map<number, number> | null = null
  let i = 0
  let last = -1
  while (i < s.length) {
    // every branch below moves on; should one ever fail to, the character is taken as text
    if (i === last) {
      pushText(out, s[i] ?? '')
      i++
      continue
    }
    last = i
    const ch = s[i] ?? ''
    const rest = s.slice(i)

    if (ch === '\\' && PUNCT.test(s[i + 1] ?? '')) {
      pushText(out, s[i + 1] ?? '')
      i += 2
      continue
    }
    if (ch === '\n') {
      out.push({ t: 'br' })
      i++
      continue
    }
    if (ch === '<' && /^<br\s*\/?>/i.test(rest)) {
      out.push({ t: 'br' })
      i += /^<br\s*\/?>/i.exec(rest)?.[0].length ?? 4
      continue
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`'
      // no run of n backticks after here means none of n or more either
      const end = run.length < noTick ? s.indexOf(run, i + run.length) : -1
      if (end !== -1) {
        let v = s.slice(i + run.length, end)
        if (/^ .* $/.test(v)) v = v.slice(1, -1)
        out.push({ t: 'code', v: codeText(v) })
        probe?.spans.push([base + i, base + end + run.length])
        i = end + run.length
        continue
      }
      if (probe && depth === 0) probe.open ??= { at: base + i, run }
      noTick = Math.min(noTick, run.length)
      pushText(out, run)
      i += run.length
      continue
    }
    if (rest.startsWith('![[') || rest.startsWith('[[')) {
      const embed = ch === '!'
      const open = i + (embed ? 3 : 2)
      if (wikiEnd !== -1 && wikiEnd < open) wikiEnd = s.indexOf(']]', open)
      if (lineEnd !== -1 && lineEnd < open) lineEnd = s.indexOf('\n', open)
      if (wikiEnd !== -1 && (lineEnd === -1 || wikiEnd < lineEnd)) {
        out.push(wiki(s.slice(open, wikiEnd), embed))
        i = wikiEnd + 2
        continue
      }
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const image = ch === '!'
      const textStart = i + (image ? 2 : 1)
      brackets ??= pairs(s, '[', ']')
      const close = brackets.get(textStart - 1) ?? -1
      if (close !== -1 && s[close + 1] === '(') {
        // the destination ends at the ) that balances its ( (Docs links end in "(v=ws.11)")
        parens ??= pairs(s, '(', ')')
        const urlEnd = parens.get(close + 1) ?? -1
        if (urlEnd !== -1) {
          const rawUrl = shown(s.slice(close + 2, urlEnd))
            .trim()
            .replace(/\s+"[^"]*"$/, '')
            .replace(/^<(.*)>$/, '$1')
          const label = s.slice(textStart, close)
          const href = safeHref(rawUrl)
          if (image) {
            // remote images are not fetched: the viewer never loads anything from the internet
            const alt = shown(label)
            pushText(out, alt ? `[image: ${alt}]` : '[image]')
          } else if (href) {
            out.push({ t: 'link', href, c: nested(textStart, close) })
          } else if (/\.md$/i.test(decodeSafe(rawUrl)) || !/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) {
            // a relative link to another note behaves like a wikilink
            const target = decodeSafe(rawUrl).replace(/\.md(#.*)?$/i, '$1')
            const w = wiki(target, false)
            if (w.t === 'wiki') out.push({ ...w, alias: shown(label) || undefined })
          } else {
            // javascript:, file: and the like: text only (pushed one by one, as a spread of a
            // label with 100000 parts overflows the stack)
            for (const x of nested(textStart, close)) out.push(x)
          }
          i = urlEnd + 1
          continue
        }
      }
    }
    if (
      (ch === 'h' || ch === 'H') &&
      /^https?:\/\/[^\s<>]/i.test(rest) &&
      (i === 0 || /[\s(]/.test(s[i - 1] ?? ''))
    ) {
      const match = trimUrl(/^https?:\/\/[^\s<>]+/i.exec(rest)?.[0] ?? '')
      const url = shown(match)
      // "https://" alone (or "https://." at the end of a sentence) is text, not a link
      if (/^https?:\/\/./i.test(url)) {
        out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] })
        // past the URL as written: the one shown is shorter by each hidden comment in it
        i += match.length
        continue
      }
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1] ?? ''))) {
      const tag = /^#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/.exec(rest)
      if (tag?.[1]) {
        out.push({ t: 'tag', v: tag[1] })
        i += tag[0].length
        continue
      }
    }
    const emph = '*_~='.includes(ch) ? EMPHASIS.find((e) => rest.startsWith(e[0])) : undefined
    if (emph && !/\s/.test(s[i + emph[0].length] ?? ' ')) {
      const d = emph[0]
      const kind = emph[1]
      const intraword = (d === '_' || d === '__') && /[A-Za-z0-9]/.test(s[i - 1] ?? '')
      // a delimiter that found no closer from an earlier opener finds none from a later one
      const end = intraword || noClose.has(d) ? -1 : findClose(s, i + d.length, d)
      if (end === -1 && !intraword) noClose.add(d)
      if (end !== -1) {
        const inner = nested(i + d.length, end)
        if (d === '***') out.push({ t: 'strong', c: [{ t: 'em', c: inner }] })
        else out.push({ t: kind as 'strong' | 'em' | 'del' | 'mark', c: inner })
        i = end + d.length
        continue
      }
    }
    // plain text up to the next character that could start something
    const next = rest.slice(1).search(/[\\\n<`![*_~=#h]/)
    const take = next === -1 ? rest.length : next + 1
    pushText(out, rest.slice(0, take))
    i += take
  }
  return out
}

function decodeSafe(u: string): string {
  try {
    return decodeURIComponent(u)
  } catch {
    return u
  }
}

/** Where each `open` closes on its line (by position), nesting counted, \-escapes skipped. */
function pairs(s: string, open: string, close: string): Map<number, number> {
  const out = new Map<number, number>()
  const stack: number[] = []
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') i++
    else if (ch === open) stack.push(i)
    else if (ch === close) {
      const o = stack.pop()
      if (o !== undefined) out.set(o, i)
    } else if (ch === '\n') stack.length = 0
  }
  return out
}

/**
 * A bare URL without the punctuation after it, nor a hidden comment right after it; a ) stays
 * when it closes a ( in the URL.
 */
function trimUrl(url: string): string {
  let unbalanced = (url.match(/\)/g) ?? []).length - (url.match(/\(/g) ?? []).length
  let end = url.length
  while (end > 0) {
    const c = url[end - 1] ?? ''
    if (c === ')' && unbalanced > 0) unbalanced--
    else if (!/[.,;:!?\]]/.test(c) && c !== HIDDEN) break
    end--
  }
  return url.slice(0, end)
}

/** Plain text of inline content (headings, search, aria labels). */
export function inlineText(c: Inline[]): string {
  return c
    .map((x) => {
      switch (x.t) {
        case 'text':
        case 'code':
          return x.v
        case 'tag':
          return `#${x.v}`
        case 'br':
          return ' '
        case 'wiki':
          return x.alias ?? (x.heading ? `${x.target} > ${x.heading}` : x.target)
        default:
          return inlineText(x.c)
      }
    })
    .join('')
}

/* ---------- blocks ---------- */

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const HR = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const CALLOUT = /^\[!([A-Za-z0-9_-]+)\]([+-]?)\s*(.*)$/
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])(\s+(.*))?$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const expandTabs = (s: string): string =>
  s[0] === '\t' ? s.replace(/^\t+/, (t) => '    '.repeat(t.length)) : s

/** The columns before a line's text: 4 for each tab it starts with, 1 for each space after them. */
function indentOf(s: string): number {
  // by index: a list nested d deep reads each of its lines d times
  let i = 0
  while (s[i] === '\t') i++
  let n = i * 4
  while (s[i++] === ' ') n++
  return n
}

/** A list item line (`m` is its ITEM match): where its text starts, its task box, its text. */
function itemText(
  s: string,
  m: RegExpExecArray
): { content: number; task?: string; first: string } {
  const base = indentOf(s)
  const marker =
    expandTabs(s)
      .slice(base)
      .match(/^([-*+]|\d{1,9}[.)])\s+/)?.[0] ?? '- '
  const text = m[5] ?? ''
  const tm = /^\[(.)\](?:\s+|$)(.*)$/.exec(text)
  return { content: base + marker.length, task: tm?.[1], first: tm ? (tm[2] ?? '') : text }
}

/**
 * Whether a line starts a block other than a table. Inside a paragraph (`para`) only a numbered
 * item that starts at 1 begins a list, as in CommonMark: "bought in\n2024. It was…" stays one
 * paragraph.
 */
function otherStart(s: string, para: boolean): boolean {
  const item = ITEM.exec(s)
  return (
    HEADING.test(s) ||
    FENCE.test(s) ||
    QUOTE.test(s) ||
    HR.test(s) ||
    (!!item?.[4] && (!para || !item[3] || Number(item[3]) === 1))
  )
}

/**
 * Whether a line heads a table: it has a pipe, would be a paragraph's line there (as in GFM, a
 * quote or a list item heads no table, and ends one), and `next()`, the line after it, is a
 * delimiter row. `para`: the line comes right after a paragraph's line.
 */
function tableStart(s: string, next: () => string, para = false): boolean {
  return s.includes('|') && !otherStart(s, para) && delimiterRow(next())
}

/** Whether a line is a table's delimiter row, and starts no other block ("- |---|" is an item). */
const delimiterRow = (b: string): boolean =>
  b.includes('|') && b.includes('-') && TABLE_SEP.test(b) && !otherStart(b, true)

/**
 * Whether a line starts a new block (`next()` gives the line after it, read only for a table),
 * `para` as for otherStart.
 */
function blockStart(s: string, next: () => string, para = false): boolean {
  return otherStart(s, para) || (s.includes('|') && delimiterRow(next()))
}

/** The line after line i, for tableStart and blockStart. */
const lineAfter = (lines: Line[], i: number) => (): string => lines[i + 1]?.s ?? ''

function splitCells(row: string): string[] {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      // \| is a pipe in the cell, also in [[Note\|alias]] and `code` (GFM)
      cur += '|'
      i++
    } else if (ch === '`') {
      // a `code span` keeps its pipes; a lone backtick is text
      const run = /^`+/.exec(s.slice(i))?.[0] ?? '`'
      const end = s.indexOf(run, i + run.length)
      const stop = end === -1 ? i + run.length : end + run.length
      cur += s.slice(i, stop).replace(/\\\|/g, '|')
      i = stop - 1
    } else if (ch === '|') {
      cells.push(trimShown(cur))
      cur = ''
    } else cur += ch
  }
  cells.push(trimShown(cur))
  return cells
}

/** Quotes and lists nested deeper than this are read as text, so no note can exhaust the stack. */
const MAX_NEST = 64

/**
 * Where a note's top level starts to read a block or passes a blank line: the line, how many
 * blocks come before it, and whether a paragraph ended there (so that the line can head a table).
 */
interface Start {
  i: number
  blocks: number
  para: boolean
}

/** A note's top level as read: its blocks, and a start at most every MARK_EVERY lines. */
interface TopLevel {
  blocks: Block[]
  starts: Start[]
}

/**
 * `end`, for a list item's body: a fence there takes none of the item's lazy lines, so the item
 * ends at the first one it would take; `end.at` is set to its index, and the body read so far
 * is returned. `top`, for a note's top level: `starts` is filled in. With `again`, the blocks
 * that looked only at lines before the first changed one are as they were (a block looks at the
 * line before it and at most at the line after the one that ends it), and from the first start
 * past the last changed line that is one of the reading before, so are the rest.
 */
function parseBlocks(
  lines: Line[],
  depth = 0,
  end?: { at: number },
  top?: { starts: Start[]; again?: Again<TopLevel> }
): Block[] {
  if (depth > MAX_NEST) {
    const text = lines
      .map((l) => trimShown(l.s))
      .filter(Boolean)
      .join(' ')
    return text ? [{ t: 'para', line: lines[0]?.n ?? 0, c: parseInline(text) }] : []
  }
  const out: Block[] = []
  let i = 0
  // the line a paragraph ended at, which can head a table as the paragraph's line it would be
  let paraEnd = -1
  const again = top?.again
  // where the reading before started its blocks, and the first one not passed yet
  const was = again?.prev.starts ?? []
  let w = 0
  if (top && again && was.length) {
    while (w + 1 < was.length && was[w + 1]!.i + 1 < again.first) w++
    const start = was[w]!
    for (let j = 0; j < start.blocks; j++) out.push(again.prev.blocks[j]!)
    for (let j = 0; j < w; j++) top.starts.push(was[j]!)
    i = start.i
    paraEnd = start.para ? i : -1
  }
  while (i < lines.length) {
    if (top) {
      const para = paraEnd === i
      if (again && i > again.last + 1) {
        while (w < was.length && was[w]!.i < i) w++
        const start = was[w]
        if (start?.i === i && start.para === para) {
          // from where it was before, the rest reads as it did
          const shift = out.length - start.blocks
          for (let j = start.blocks; j < again.prev.blocks.length; j++)
            out.push(again.prev.blocks[j]!)
          for (; w < was.length; w++)
            top.starts.push({ ...was[w]!, blocks: was[w]!.blocks + shift })
          break
        }
      }
      const noted = top.starts[top.starts.length - 1]
      if (!noted || i >= noted.i + MARK_EVERY) top.starts.push({ i, blocks: out.length, para })
    }
    const line = lines[i]!
    const s = line.s
    if (!s.trim()) {
      i++
      continue
    }

    const fence = FENCE.exec(s)
    if (fence?.[2]) {
      const mark = fence[2]
      const pad = fence[1]?.length ?? 0
      const body: string[] = []
      i++
      let lazy = -1
      while (i < lines.length) {
        const t = lines[i]!.s
        if (t.trim().startsWith(mark[0]!.repeat(mark.length)) && /^[`~]+$/.test(t.trim())) {
          i++
          break
        }
        if (end && lines[i]!.lazy) {
          lazy = i
          break
        }
        // the fence's own indent comes off, as written: a tab is one character here, not four
        body.push(t.slice(Math.min(pad, /^\s*/.exec(t)?.[0].length ?? 0)))
        i++
      }
      const lang = codeText(fence[3] ?? '')
      out.push({ t: 'code', line: line.n, lang, v: codeText(body.join('\n')) })
      // a list item's fence takes none of its lazy lines: the item ends at the first
      if (lazy !== -1 && end) {
        end.at = lazy
        return out
      }
      continue
    }

    // indented code: 4+ columns after a blank line (it never continues a paragraph); an
    // indented list item stays a list, as nested lists in Obsidian often skip a level
    const afterBlank = i === 0 || !lines[i - 1]!.s.trim()
    if (afterBlank && indentOf(s) >= 4 && ITEM.exec(s)?.[4] === undefined) {
      const body: string[] = []
      while (i < lines.length && (!lines[i]!.s.trim() || indentOf(lines[i]!.s) >= 4)) {
        body.push(expandTabs(lines[i]!.s).slice(4))
        i++
      }
      while (body.length && !body[body.length - 1]!.trim()) body.pop()
      out.push({ t: 'code', line: line.n, lang: '', v: codeText(body.join('\n')) })
      continue
    }

    const h = HEADING.exec(s)
    if (h?.[1]) {
      const c = parseInline(stripBlockId(trimShown(h[2] ?? '')))
      out.push({ t: 'heading', line: line.n, level: h[1].length, c, text: inlineText(c).trim() })
      i++
      continue
    }

    if (HR.test(s)) {
      out.push({ t: 'hr', line: line.n })
      i++
      continue
    }

    if (tableStart(s, lineAfter(lines, i), paraEnd === i)) {
      const head = splitCells(trimShown(s))
      const align = splitCells(lines[i + 1]!.s).map((c) => {
        const l = c.startsWith(':')
        const r = c.endsWith(':')
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null
      })
      const rows: Inline[][][] = []
      const rowLines: number[] = []
      i += 2
      // a row has a pipe; a line that starts another block ends the table (GFM)
      while (
        i < lines.length &&
        lines[i]!.s.includes('|') &&
        lines[i]!.s.trim() &&
        !otherStart(lines[i]!.s, false)
      ) {
        const cells = splitCells(trimShown(lines[i]!.s))
        rows.push(head.map((_, j) => parseInline(cells[j] ?? '')))
        rowLines.push(lines[i]!.n)
        i++
      }
      const headCells = head.map((c) => parseInline(c))
      out.push({ t: 'table', line: line.n, align, head: headCells, rows, rowLines })
      continue
    }

    if (QUOTE.test(s)) {
      const inner: Line[] = []
      while (i < lines.length && QUOTE.test(lines[i]!.s)) {
        inner.push({ n: lines[i]!.n, s: QUOTE.exec(lines[i]!.s)?.[1] ?? '' })
        i++
      }
      const head = CALLOUT.exec(inner[0]?.s ?? '')
      if (head?.[1]) {
        const kind = head[1].toLowerCase()
        const titleText = trimShown(head[3] ?? '') || kind.charAt(0).toUpperCase() + kind.slice(1)
        out.push({
          t: 'callout',
          line: line.n,
          kind,
          fold: (head[2] ?? '') as '' | '+' | '-',
          title: parseInline(stripBlockId(titleText)),
          c: parseBlocks(inner.slice(1), depth + 1)
        })
      } else out.push({ t: 'quote', line: line.n, c: parseBlocks(inner, depth + 1) })
      continue
    }

    const item = ITEM.exec(s)
    if (item && item[4] !== undefined) {
      const base = indentOf(s)
      const ordered = !!item[3]
      const list: Extract<Block, { t: 'list' }> = {
        t: 'list',
        line: line.n,
        ordered,
        start: ordered ? Number(item[3]) : 1,
        items: []
      }
      while (i < lines.length) {
        const cur = lines[i]!
        const m = ITEM.exec(cur.s)
        if (!m || m[4] === undefined || indentOf(cur.s) !== base || !!m[3] !== ordered) break
        const { content: contentOffset, task, first } = itemText(cur.s, m)
        const body: Line[] = [{ n: cur.n, s: first }]
        const from = i
        i++
        let lastBlank = false
        while (i < lines.length) {
          const t = lines[i]!
          const ind = indentOf(t.s)
          const own = inItem(base, contentOffset, lastBlank, t.s, ind, lineAfter(lines, i))
          if (own === null) break
          // held lazily: not blank (that is held as '') and not indented past the marker
          body.push(own && ind <= base ? { n: t.n, s: own, lazy: true } : { n: t.n, s: own })
          lastBlank = !own
          i++
        }
        // trailing blank lines belong to the gap, not the item
        while (body.length > 1 && !body[body.length - 1]!.s.trim()) {
          body.pop()
          i--
        }
        while (i < lines.length && !lines[i]!.s.trim()) i++
        const end = { at: -1 }
        list.items.push({ line: cur.n, task, c: parseBlocks(body, depth + 1, end) })
        // it ends where its fence met a lazy line, which is read after it
        if (end.at !== -1) i = from + end.at
        const next = lines[i]
        if (!next) break
        const nm = ITEM.exec(next.s)
        if (!nm || nm[4] === undefined || indentOf(next.s) !== base) break
      }
      out.push(list)
      continue
    }

    // paragraph
    const para: string[] = [trimShown(s)]
    const start = line.n
    i++
    while (
      i < lines.length &&
      lines[i]!.s.trim() &&
      !blockStart(lines[i]!.s, lineAfter(lines, i), true)
    ) {
      para.push(trimShown(lines[i]!.s))
      i++
    }
    paraEnd = i
    // a line whose only text was a comment shows nothing, not even a line break
    const text = stripBlockId(para.filter(Boolean).join('\n'))
    // a ^block-id on its own line (after a table or callout) is hidden too
    if (text && !BLOCK_ID_ONLY.test(text))
      out.push({ t: 'para', line: start, c: parseInline(text) })
  }
  return out
}

const BLOCK_ID_ONLY = /^\^[A-Za-z0-9-]+$/

/** A ^block-id at the end of a paragraph, item or heading is hidden, like in reading view. */
function stripBlockId(s: string): string {
  return s.replace(/\s\^[A-Za-z0-9-]+\s*$/, '')
}

/** Wikilinks in order with their line: a paragraph's line breaks move it down one line each. */
function collectLinks(blocks: Block[], out: Array<{ target: string; line: number }>): void {
  const inl = (c: Inline[], line: number): number => {
    for (const x of c) {
      if (x.t === 'wiki' && x.target) out.push({ target: x.target, line })
      else if (x.t === 'br') line++
      else if (
        x.t === 'strong' ||
        x.t === 'em' ||
        x.t === 'del' ||
        x.t === 'mark' ||
        x.t === 'link'
      )
        line = inl(x.c, line)
    }
    return line
  }
  for (const b of blocks) {
    if (b.t === 'heading' || b.t === 'para') inl(b.c, b.line)
    else if (b.t === 'quote') collectLinks(b.c, out)
    else if (b.t === 'callout') {
      inl(b.title, b.line)
      collectLinks(b.c, out)
    } else if (b.t === 'list') for (const it of b.items) collectLinks(it.c, out)
    else if (b.t === 'table') {
      b.head.forEach((c) => inl(c, b.line))
      b.rows.forEach((r, k) => r.forEach((c) => inl(c, b.rowLines[k] ?? b.line)))
    }
  }
}

/**
 * The lines of each block whose text shows a KEPT anywhere but in a code span: from its line to
 * the line before the next block's (`last` is the note's last line).
 */
function keptShown(blocks: Block[], last: number): Ranges {
  const inline = (c: Inline[]): boolean =>
    c.some((x) => {
      if (x.t === 'text') return x.v.includes(KEPT)
      if (x.t === 'wiki') return `${x.target}${x.heading ?? ''}${x.alias ?? ''}`.includes(KEPT)
      if (x.t === 'link') return x.href.includes(KEPT) || inline(x.c)
      return 'c' in x && inline(x.c)
    })
  // every block in the order of the note (each starts on or after the line of the one before)
  const flat: Array<[number, boolean]> = []
  const walk = (bs: Block[]): void => {
    for (const b of bs) {
      const shows =
        b.t === 'para' || b.t === 'heading'
          ? inline(b.c)
          : b.t === 'callout'
            ? inline(b.title)
            : b.t === 'table' && [b.head, ...b.rows].some((row) => row.some(inline))
      flat.push([b.line, shows])
      if (b.t === 'quote' || b.t === 'callout') walk(b.c)
      else if (b.t === 'list') for (const it of b.items) walk(it.c)
    }
  }
  walk(blocks)
  const out: Ranges = []
  let next = last + 1
  for (let j = flat.length - 1; j >= 0; j--) {
    const [line, shows] = flat[j]!
    const later = flat[j + 1]
    if (later && later[0] > line) next = later[0]
    if (shows) out.push([line, next - 1])
  }
  return out
}

/** How many times parseMarkdown reads a note again before it hides every comment in it. */
const MAX_REREADS = 3

export function parseMarkdown(text: string): ParsedNote {
  // HIDDEN and KEPT are the parser's own: a note's own are not taken for them
  const raw = text
    .replace(/^﻿/, '')
    .replace(/[\uFDD0\uFDD1]/g, '\uFFFD')
    .split(/\r?\n/)
  const fm = frontmatter(raw)
  const src = raw.slice(fm.end)
  const lineAt = (s: string, k: number): Line => ({ n: fm.end + k + 1, s })
  const readTop = (lines: string[], again?: Again<TopLevel>): TopLevel => {
    const starts: Start[] = []
    return { blocks: parseBlocks(lines.map(lineAt), 0, undefined, { starts, again }), starts }
  }
  let blocks: Block[]
  // a note with no comment marker is read as it is (stripComments would give it back unchanged)
  if (!src.some(hasMarker)) blocks = parseBlocks(src.map(lineAt))
  else {
    // stripComments reads a paragraph's code spans a line at a time, so a span parseInline reads
    // in the whole paragraph (an emphasis from the line before, a table's cells) can differ: a
    // comment it kept as code must not show as anything else. Where one does, those lines are
    // read again with every comment on them hidden, until none does: each time from the first
    // of them, and only as far as the note reads differently.
    const plain = new Set<number>()
    let stripped = stripComments(src, () => false)
    let top = readTop(stripped.out)
    for (let n = 0; ; n++) {
      const shows = keptShown(top.blocks, raw.length)
      if (!shows.length) break
      if (n === MAX_REREADS) {
        top = readTop(stripComments(src, () => true).out)
        break
      }
      let first = src.length
      let last = -1
      for (const [a, b] of shows) {
        for (let k = a - fm.end - 1; k <= b - fm.end - 1; k++) {
          if (plain.has(k)) continue
          plain.add(k)
          first = Math.min(first, k)
          last = Math.max(last, k)
        }
      }
      if (last === -1) continue
      const next = stripComments(src, (k) => plain.has(k), { prev: stripped, first, last })
      // the lines it writes differently
      let from = 0
      while (from < src.length && next.out[from] === stripped.out[from]) from++
      let to = src.length - 1
      while (to >= from && next.out[to] === stripped.out[to]) to--
      if (from <= to) top = readTop(next.out, { prev: top, first: from, last: to })
      stripped = next
    }
    blocks = top.blocks
  }
  // links in properties ("related: [[Note]]") are links too, as in Obsidian's backlinks
  const props = raw
    .slice(1, Math.max(1, fm.end - 1))
    .map((s, k): Block => ({ t: 'para', line: k + 2, c: parseInline(s) }))
  const linkLines: ParsedNote['linkLines'] = []
  collectLinks(props, linkLines)
  const inProps = linkLines.length
  collectLinks(blocks, linkLines)
  const links = new Set(linkLines.slice(inProps).map((l) => l.target))
  return { frontmatter: fm.data, blocks, links: [...links], linkLines }
}

/**
 * A heading the way [[Note#Heading]] links name it: read as Markdown, then letters and digits
 * only, case ignored. Obsidian links "## Step 1: Setup" as #Step 1 Setup.
 */
export function headingKey(text: string): string {
  return inlineText(parseInline(text))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase()
}
