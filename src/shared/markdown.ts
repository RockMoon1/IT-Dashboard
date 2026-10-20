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
/** A fence line as stripComments sees it: also after quote markers and a list marker. */
const FENCE_IN = /^((?:\s*(?:>|(?:[-*+]|\d{1,9}[.)])\s))*\s*)(`{3,}|~{3,})(.*)$/
const quoteDepth = (s: string): number => (/^(?:\s*>)*/.exec(s)?.[0].match(/>/g) ?? []).length
/** A line with its first n quote markers taken off, as parseBlocks reads it inside the quotes. */
function quoteBody(s: string, n: number): string {
  let t = s
  for (let k = 0; k < n; k++) {
    const m = /^\s*>\s?(.*)$/.exec(t)
    if (!m) break
    t = m[1] ?? ''
  }
  return t
}

/**
 * Blanks out <!-- --> and %% %% comments outside code, keeping every line where it was. Code
 * is what parseBlocks reads as code: fences (also in a callout or list item), indented code
 * after a blank line outside lists, and `code spans`; comment markers in it are text.
 */
function stripComments(lines: string[]): string[] {
  const out: string[] = []
  let fence: { mark: string; depth: number } | null = null
  let inHtml = false
  let inPct = false
  let indented = -1 // quote depth of the indented code block being read; -1 when none
  let list = -1 // indent of the open list's outermost item; -1 when no list is open
  let prevBlank = true
  let prevQ = 0 // quote depth of the line before
  let prevInnerBlank = true // the line before was blank inside its quote ("> ")
  let prevHead = false // the line before was a callout's title line
  for (const raw of lines) {
    const blank = !raw.trim()
    const q = quoteDepth(raw)
    const body = q ? quoteBody(raw, q) : raw // the line as parseBlocks reads it inside the quote
    const innerBlank = !body.trim()
    // after a blank line as parseBlocks sees it: at the top, a blank line; in a quote, a blank
    // quoted line, the quote's first line, or a callout's title
    const afterBlank =
      q === 0 ? prevBlank : prevQ < q || (prevQ === q && (prevInnerBlank || prevHead))
    const note = (): void => {
      prevBlank = blank
      prevQ = q
      prevInnerBlank = innerBlank
      prevHead = /^\[![A-Za-z0-9_-]+\]/.test(body.trim())
    }
    if (!inHtml && !inPct) {
      // a fence ends with its closing line, or with the quote it was opened in
      if (fence && q < fence.depth) fence = null
      const f = FENCE_IN.exec(raw)
      if (fence) {
        // only a line at the fence's own quote depth holding nothing but the fence closes it
        const inner = q === fence.depth ? quoteBody(raw, fence.depth).trim() : ''
        if (
          /^[`~]+$/.test(inner) &&
          inner[0] === fence.mark[0] &&
          inner.length >= fence.mark.length
        )
          fence = null
        out.push(raw)
        note()
        continue
      }
      if (indented >= 0 && q === indented && (innerBlank || indentOf(body) >= 4)) {
        out.push(raw)
        note()
        continue
      }
      indented = -1
      if (!blank) {
        const ind = indentOf(raw)
        const item = ITEM.exec(raw)?.[4] !== undefined
        if (item && (list < 0 || ind < list)) list = ind
        else if (!item && ind <= list && (prevBlank || HEADING.test(raw) || f)) list = -1
        const innerItem = ITEM.exec(body)?.[4] !== undefined
        if (f?.[2]) {
          fence = { mark: f[2], depth: quoteDepth(f[1] ?? '') }
        } else if (!innerItem && afterBlank && indentOf(body) >= 4 && (q > 0 || list < 0)) {
          indented = q
        }
        if (fence || indented >= 0) {
          out.push(raw)
          note()
          continue
        }
      }
    }
    note()
    let result = ''
    let i = 0
    // next comment opener and backtick from i, found again only once i has passed them
    let html = -2
    let pct = -2
    let tick = -2
    while (i < raw.length) {
      if (inHtml || inPct) {
        const close = inHtml ? '-->' : '%%'
        const end = raw.indexOf(close, i)
        if (end === -1) break
        i = end + close.length
        inHtml = inPct = false
        continue
      }
      if (html !== -1 && html < i) html = raw.indexOf('<!--', i)
      if (pct !== -1 && pct < i) pct = raw.indexOf('%%', i)
      if (tick !== -1 && tick < i) tick = raw.indexOf('`', i)
      const next = Math.min(...[html, pct, tick].filter((x) => x >= 0))
      if (next === Infinity) {
        result += raw.slice(i)
        break
      }
      result += raw.slice(i, next)
      if (next === tick) {
        // a `code span` (closed on this line) is copied as it is; a lone backtick is text
        const run = /^`+/.exec(raw.slice(next))?.[0] ?? '`'
        const end = raw.indexOf(run, next + run.length)
        i = end === -1 ? next + run.length : end + run.length
        result += raw.slice(next, i)
      } else if (next === html) {
        inHtml = true
        i = next + 4
      } else {
        inPct = true
        i = next + 2
      }
    }
    // a line that held only a comment disappears (blank), like in reading view
    out.push(result.trim() === '' && raw.trim() !== '' ? '' : result)
  }
  return out
}

/* ---------- inline ---------- */

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

function pushText(out: Inline[], v: string): void {
  if (!v) return
  const last = out[out.length - 1]
  if (last && last.t === 'text') last.v += v
  else out.push({ t: 'text', v })
}

export function safeHref(url: string): string | null {
  const u = url.trim()
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : null
}

function wiki(content: string, embed: boolean): Inline {
  const [beforeAlias, ...aliasParts] = content.split('|')
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

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
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
        out.push({ t: 'code', v })
        i = end + run.length
        continue
      }
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
          const rawUrl = s
            .slice(close + 2, urlEnd)
            .trim()
            .replace(/\s+"[^"]*"$/, '')
            .replace(/^<(.*)>$/, '$1')
          const label = s.slice(textStart, close)
          const href = safeHref(rawUrl)
          if (image) {
            // remote images are not fetched: the viewer never loads anything from the internet
            pushText(out, label ? `[image: ${label}]` : '[image]')
          } else if (href) {
            out.push({ t: 'link', href, c: parseInline(label) })
          } else if (/\.md$/i.test(decodeSafe(rawUrl)) || !/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) {
            // a relative link to another note behaves like a wikilink
            const target = decodeSafe(rawUrl).replace(/\.md(#.*)?$/i, '$1')
            const w = wiki(target, false)
            if (w.t === 'wiki') out.push({ ...w, alias: label || undefined })
          } else {
            out.push(...parseInline(label)) // javascript:, file: and the like: text only
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
      const url = trimUrl(/^https?:\/\/[^\s<>]+/i.exec(rest)?.[0] ?? '')
      // "https://" alone (or "https://." at the end of a sentence) is text, not a link
      if (/^https?:\/\/./i.test(url)) {
        out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] })
        i += url.length
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
        const inner = parseInline(s.slice(i + d.length, end))
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

/** A bare URL without the punctuation after it; a ) stays when it closes a ( in the URL. */
function trimUrl(url: string): string {
  let unbalanced = (url.match(/\)/g) ?? []).length - (url.match(/\(/g) ?? []).length
  let end = url.length
  while (end > 0) {
    const c = url[end - 1] ?? ''
    if (c === ')' && unbalanced > 0) unbalanced--
    else if (!/[.,;:!?\]]/.test(c)) break
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
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])(\s+(.*))?$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const expandTabs = (s: string): string => s.replace(/^\t+/, (t) => '    '.repeat(t.length))
const indentOf = (s: string): number => /^ */.exec(expandTabs(s))?.[0].length ?? 0

function isTableStart(lines: Line[], i: number): boolean {
  const a = lines[i]?.s ?? ''
  const b = lines[i + 1]?.s ?? ''
  return a.includes('|') && b.includes('|') && TABLE_SEP.test(b) && b.includes('-')
}

/**
 * Whether line i starts a new block. Inside a paragraph (`para`) only a numbered item that
 * starts at 1 begins a list, as in CommonMark: "bought in\n2024. It was…" stays one paragraph.
 */
function isBlockStart(lines: Line[], i: number, para = false): boolean {
  const s = lines[i]?.s ?? ''
  const item = ITEM.exec(s)
  return (
    HEADING.test(s) ||
    FENCE.test(s) ||
    QUOTE.test(s) ||
    HR.test(s) ||
    (!!item?.[4] && (!para || !item[3] || Number(item[3]) === 1)) ||
    isTableStart(lines, i)
  )
}

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
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/** Quotes and lists nested deeper than this are read as text, so no note can exhaust the stack. */
const MAX_NEST = 64

function parseBlocks(lines: Line[], depth = 0): Block[] {
  if (depth > MAX_NEST) {
    const text = lines
      .map((l) => l.s.trim())
      .filter(Boolean)
      .join(' ')
    return text ? [{ t: 'para', line: lines[0]?.n ?? 0, c: parseInline(text) }] : []
  }
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
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
      while (i < lines.length) {
        const t = lines[i]!.s
        if (t.trim().startsWith(mark[0]!.repeat(mark.length)) && /^[`~]+$/.test(t.trim())) {
          i++
          break
        }
        body.push(t.slice(Math.min(pad, indentOf(t))))
        i++
      }
      out.push({ t: 'code', line: line.n, lang: fence[3] ?? '', v: body.join('\n') })
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
      out.push({ t: 'code', line: line.n, lang: '', v: body.join('\n') })
      continue
    }

    const h = HEADING.exec(s)
    if (h?.[1]) {
      const c = parseInline(stripBlockId(h[2] ?? ''))
      out.push({ t: 'heading', line: line.n, level: h[1].length, c, text: inlineText(c).trim() })
      i++
      continue
    }

    if (HR.test(s)) {
      out.push({ t: 'hr', line: line.n })
      i++
      continue
    }

    if (isTableStart(lines, i)) {
      const head = splitCells(s)
      const align = splitCells(lines[i + 1]!.s).map((c) => {
        const l = c.startsWith(':')
        const r = c.endsWith(':')
        return l && r ? 'center' : r ? 'right' : l ? 'left' : null
      })
      const rows: Inline[][][] = []
      const rowLines: number[] = []
      i += 2
      while (i < lines.length && lines[i]!.s.includes('|') && lines[i]!.s.trim()) {
        const cells = splitCells(lines[i]!.s)
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
      const head = /^\[!([A-Za-z0-9_-]+)\]([+-]?)\s*(.*)$/.exec(inner[0]?.s ?? '')
      if (head?.[1]) {
        const kind = head[1].toLowerCase()
        const titleText = head[3]?.trim() || kind.charAt(0).toUpperCase() + kind.slice(1)
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
        const marker =
          expandTabs(cur.s)
            .slice(base)
            .match(/^([-*+]|\d{1,9}[.)])\s+/)?.[0] ?? '- '
        const contentOffset = base + marker.length
        let first = m[5] ?? ''
        let task: string | undefined
        const tm = /^\[(.)\](?:\s+|$)(.*)$/.exec(first)
        if (tm) {
          task = tm[1]
          first = tm[2] ?? ''
        }
        const body: Line[] = [{ n: cur.n, s: first }]
        i++
        let lastBlank = false
        while (i < lines.length) {
          const t = lines[i]!
          if (!t.s.trim()) {
            body.push({ n: t.n, s: '' })
            lastBlank = true
            i++
            continue
          }
          const ind = indentOf(t.s)
          if (ind > base) {
            body.push({ n: t.n, s: expandTabs(t.s).slice(Math.min(ind, contentOffset)) })
            lastBlank = false
            i++
            continue
          }
          // a line right after the item text that starts nothing new continues the item
          if (!lastBlank && !isBlockStart(lines, i)) {
            body.push({ n: t.n, s: t.s.trim() })
            i++
            continue
          }
          break
        }
        // trailing blank lines belong to the gap, not the item
        while (body.length > 1 && !body[body.length - 1]!.s.trim()) {
          body.pop()
          i--
        }
        while (i < lines.length && !lines[i]!.s.trim()) i++
        list.items.push({ line: cur.n, task, c: parseBlocks(body, depth + 1) })
        const next = lines[i]
        if (!next) break
        const nm = ITEM.exec(next.s)
        if (!nm || nm[4] === undefined || indentOf(next.s) !== base) break
      }
      out.push(list)
      continue
    }

    // paragraph
    const para: string[] = [s.trim()]
    const start = line.n
    i++
    while (i < lines.length && lines[i]!.s.trim() && !isBlockStart(lines, i, true)) {
      para.push(lines[i]!.s.trim())
      i++
    }
    const text = stripBlockId(para.join('\n'))
    // a ^block-id on its own line (after a table or callout) is hidden too
    if (!BLOCK_ID_ONLY.test(text)) out.push({ t: 'para', line: start, c: parseInline(text) })
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

export function parseMarkdown(text: string): ParsedNote {
  const raw = text.replace(/^﻿/, '').split(/\r?\n/)
  const fm = frontmatter(raw)
  const body = stripComments(raw.slice(fm.end))
  const lines = body.map((s, k) => ({ n: fm.end + k + 1, s }))
  const blocks = parseBlocks(lines)
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
