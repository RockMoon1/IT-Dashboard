/**
 * A small, safe Markdown reader for the vault's notes (the parts of Obsidian's flavour the ARH IT
 * notes use). It returns a tree, never HTML: the renderer draws it with text nodes only, so a
 * note can never inject markup or script into the dashboard.
 *
 * Covered: frontmatter, headings, paragraphs (single newlines are line breaks, as in Obsidian),
 * fenced code, block quotes and callouts (> [!danger]- Title), ordered/unordered/nested lists
 * with task boxes, tables, rules, **bold** *italic* ~~strike~~ ==highlight== `code`, [links](),
 * bare https:// links, [[wikilinks|alias]] [[Note#Heading]] ![[embeds]], #tags. Hidden like in
 * Obsidian's reading view: <!-- comments --> (including the dashboard's markers), %% comments %%
 * and ^block-ids. Every block keeps its 1-based source line so the viewer can jump to a line.
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
    }
  | { t: 'hr'; line: number }

export interface ParsedNote {
  frontmatter: Array<[string, string]>
  blocks: Block[]
  /** Every wikilink target in the note (without #heading or |alias), in order, once each. */
  links: string[]
}

interface Line {
  n: number
  s: string
}

/* ---------- frontmatter and comments ---------- */

function frontmatter(lines: string[]): { data: Array<[string, string]>; end: number } {
  if ((lines[0] ?? '').trim() !== '---') return { data: [], end: 0 }
  const data: Array<[string, string]> = []
  for (let i = 1; i < lines.length && i < 400; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---' || line.trim() === '...') return { data, end: i + 1 }
    const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(line)
    if (kv?.[1]) data.push([kv[1].trim(), (kv[2] ?? '').trim()])
    else {
      // "- item" under a key: a YAML list, shown as "a, b"
      const item = /^\s*-\s+(.*)$/.exec(line)
      const last = data[data.length - 1]
      if (item?.[1] && last) last[1] = last[1] ? `${last[1]}, ${item[1].trim()}` : item[1].trim()
    }
  }
  return { data: [], end: 0 } // no closing line: not frontmatter
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)/

/** Blanks out <!-- --> and %% %% comments outside code, keeping every line where it was. */
function stripComments(lines: string[]): string[] {
  const out: string[] = []
  let fence: string | null = null
  let inHtml = false
  let inPct = false
  for (const raw of lines) {
    const f = FENCE.exec(raw)
    if (!inHtml && !inPct && f?.[2]) {
      if (!fence) fence = f[2]
      else if (f[2][0] === fence[0] && f[2].length >= fence.length && raw.trim() === f[2])
        fence = null
      out.push(raw)
      continue
    }
    if (fence) {
      out.push(raw)
      continue
    }
    let s = raw
    let result = ''
    while (s.length) {
      if (inHtml) {
        const end = s.indexOf('-->')
        if (end === -1) {
          s = ''
          break
        }
        s = s.slice(end + 3)
        inHtml = false
        continue
      }
      if (inPct) {
        const end = s.indexOf('%%')
        if (end === -1) {
          s = ''
          break
        }
        s = s.slice(end + 2)
        inPct = false
        continue
      }
      const html = s.indexOf('<!--')
      const pct = s.indexOf('%%')
      const next = [html, pct].filter((x) => x >= 0).sort((a, b) => a - b)[0]
      if (next === undefined) {
        result += s
        break
      }
      result += s.slice(0, next)
      if (next === html) {
        inHtml = true
        s = s.slice(next + 4)
      } else {
        inPct = true
        s = s.slice(next + 2)
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
  const [target, ...headingParts] = (beforeAlias ?? '').split('#')
  const heading = headingParts.join('#').replace(/^\^/, '').trim() || undefined
  return { t: 'wiki', target: (target ?? '').trim(), heading, alias, embed }
}

/** Finds the closing delimiter for an emphasis run: not escaped, not preceded by a space. */
function findClose(s: string, from: number, delim: string): number {
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
    if (s.startsWith(delim, i) && i > from && !/\s/.test(s[i - 1] ?? ' ')) {
      if (delim === '_' || delim === '__') {
        const after = s[i + delim.length] ?? ''
        if (/[A-Za-z0-9]/.test(after)) continue // intraword underscore
      }
      // ** must not be read as the end of * (and the reverse)
      if (delim === '*' && s[i + 1] === '*' && s[i + 2] !== '*') {
        i++
        continue
      }
      return i
    }
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

export function parseInline(src: string): Inline[] {
  const s = src.replace(/\s\^[A-Za-z0-9-]+\s*$/, '') // ^block-id at the end: hidden
  const out: Inline[] = []
  let i = 0
  while (i < s.length) {
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
    if (/^<br\s*\/?>/i.test(rest)) {
      out.push({ t: 'br' })
      i += /^<br\s*\/?>/i.exec(rest)?.[0].length ?? 4
      continue
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`'
      const end = s.indexOf(run, i + run.length)
      if (end !== -1) {
        let v = s.slice(i + run.length, end)
        if (/^ .* $/.test(v)) v = v.slice(1, -1)
        out.push({ t: 'code', v })
        i = end + run.length
        continue
      }
      pushText(out, run)
      i += run.length
      continue
    }
    if (rest.startsWith('![[') || rest.startsWith('[[')) {
      const embed = ch === '!'
      const open = i + (embed ? 3 : 2)
      const end = s.indexOf(']]', open)
      if (end !== -1 && !s.slice(open, end).includes('\n')) {
        out.push(wiki(s.slice(open, end), embed))
        i = end + 2
        continue
      }
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const image = ch === '!'
      const textStart = i + (image ? 2 : 1)
      const close = findBracket(s, textStart)
      if (close !== -1 && s[close + 1] === '(') {
        const urlEnd = s.indexOf(')', close + 2)
        if (urlEnd !== -1) {
          const rawUrl = s
            .slice(close + 2, urlEnd)
            .trim()
            .replace(/\s+"[^"]*"$/, '')
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
    if (/^https?:\/\//i.test(rest) && (i === 0 || /[\s(]/.test(s[i - 1] ?? ''))) {
      let url = /^https?:\/\/[^\s<>]+/i.exec(rest)?.[0] ?? ''
      url = url.replace(/[.,;:!?)\]]+$/, '')
      out.push({ t: 'link', href: url, c: [{ t: 'text', v: url }] })
      i += url.length
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1] ?? ''))) {
      const tag = /^#([A-Za-z0-9_/-]*[A-Za-z_/-][A-Za-z0-9_/-]*)/.exec(rest)
      if (tag?.[1]) {
        out.push({ t: 'tag', v: tag[1] })
        i += tag[0].length
        continue
      }
    }
    const emph = EMPHASIS.find(([d]) => rest.startsWith(d))
    if (emph && !/\s/.test(s[i + emph[0].length] ?? ' ')) {
      const [d, kind] = emph
      const intraword = (d === '_' || d === '__') && /[A-Za-z0-9]/.test(s[i - 1] ?? '')
      const end = intraword ? -1 : findClose(s, i + d.length, d)
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

function findBracket(s: string, from: number): number {
  let depth = 0
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === '[') depth++
    else if (s[i] === ']') {
      if (depth === 0) return i
      depth--
    } else if (s[i] === '\n') return -1
  }
  return -1
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

function isBlockStart(lines: Line[], i: number): boolean {
  const s = lines[i]?.s ?? ''
  return (
    HEADING.test(s) ||
    FENCE.test(s) ||
    QUOTE.test(s) ||
    HR.test(s) ||
    (ITEM.test(s) && !!ITEM.exec(s)?.[4]) ||
    isTableStart(lines, i)
  )
}

function splitCells(row: string): string[] {
  let s = row.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  let inCode = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '\\|'
      i++
    } else if (ch === '`') {
      inCode = !inCode
      cur += ch
    } else if (ch === '|' && !inCode) {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function parseBlocks(lines: Line[]): Block[] {
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

    const h = HEADING.exec(s)
    if (h?.[1]) {
      const c = parseInline(h[2] ?? '')
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
      i += 2
      while (i < lines.length && lines[i]!.s.includes('|') && lines[i]!.s.trim()) {
        const cells = splitCells(lines[i]!.s)
        rows.push(head.map((_, j) => parseInline(cells[j] ?? '')))
        i++
      }
      out.push({ t: 'table', line: line.n, align, head: head.map((c) => parseInline(c)), rows })
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
          title: parseInline(titleText),
          c: parseBlocks(inner.slice(1))
        })
      } else out.push({ t: 'quote', line: line.n, c: parseBlocks(inner) })
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
        list.items.push({ line: cur.n, task, c: parseBlocks(body) })
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
    while (i < lines.length && lines[i]!.s.trim() && !isBlockStart(lines, i)) {
      para.push(lines[i]!.s.trim())
      i++
    }
    out.push({ t: 'para', line: start, c: parseInline(para.join('\n')) })
  }
  return out
}

function collectLinks(blocks: Block[], out: Set<string>): void {
  const inl = (c: Inline[]): void => {
    for (const x of c) {
      if (x.t === 'wiki' && x.target) out.add(x.target)
      else if (
        x.t === 'strong' ||
        x.t === 'em' ||
        x.t === 'del' ||
        x.t === 'mark' ||
        x.t === 'link'
      )
        inl(x.c)
    }
  }
  for (const b of blocks) {
    if (b.t === 'heading' || b.t === 'para') inl(b.c)
    else if (b.t === 'quote') collectLinks(b.c, out)
    else if (b.t === 'callout') {
      inl(b.title)
      collectLinks(b.c, out)
    } else if (b.t === 'list') for (const it of b.items) collectLinks(it.c, out)
    else if (b.t === 'table') {
      b.head.forEach(inl)
      b.rows.forEach((r) => r.forEach(inl))
    }
  }
}

export function parseMarkdown(text: string): ParsedNote {
  const raw = text.replace(/^﻿/, '').split(/\r?\n/)
  const fm = frontmatter(raw)
  const body = stripComments(raw.slice(fm.end))
  const lines = body.map((s, k) => ({ n: fm.end + k + 1, s }))
  const blocks = parseBlocks(lines)
  const links = new Set<string>()
  collectLinks(blocks, links)
  return { frontmatter: fm.data, blocks, links: [...links] }
}
