import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** Read-only parsing of vault notes: tasks with due dates, dated log entries, search. */

export interface VaultTask {
  file: string
  line: number
  text: string
  done: boolean
  status: string
  due?: string
  overdue: boolean
  dueSoon: boolean
  /** 🔴 🟠 🟡 ⚪ 🧊 from the line or its section heading, or a Tasks plugin priority emoji. */
  priority?: string
  /** Nearest heading above the task, without the leading #s. */
  section?: string
  raw: string
}

const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/
const DUE_PATTERNS: RegExp[] = [
  /📅\s*(\d{4}-\d{2}-\d{2})/,
  /\[due::\s*(\d{4}-\d{2}-\d{2})\s*\]/i,
  /\(due::\s*(\d{4}-\d{2}-\d{2})\s*\)/i,
  /\bdue:\s*(\d{4}-\d{2}-\d{2})/i,
  /@(\d{4}-\d{2}-\d{2})\b/,
  /\bby\s+(\d{4}-\d{2}-\d{2})\b/i
]
// The `u` flag matters: without it a class of astral emoji matches lone surrogate halves.
const TASKS_PRIORITY_RE = /(⏫|🔼|🔽|⏬|🔺)/u
const LEADING_LEVEL_RE = /^(?:[*_~\s]*)(🔴|🟠|🟡|⚪|🧊)/u

/** Priority as the vault writes it: a level emoji leading the task, else its section's, else Tasks. */
export function taskPriority(body: string, section: string | undefined): string | undefined {
  return (
    LEADING_LEVEL_RE.exec(body)?.[1] ??
    (section ? LEADING_LEVEL_RE.exec(section)?.[1] : undefined) ??
    TASKS_PRIORITY_RE.exec(body)?.[1]
  )
}

export function parseDue(text: string): string | undefined {
  for (const re of DUE_PATTERNS) {
    const m = re.exec(text)
    if (m?.[1]) return m[1]
  }
  return undefined
}

export function parseTasks(
  text: string,
  file: string,
  today: string = new Date().toISOString().slice(0, 10),
  soonDays = 3
): VaultTask[] {
  const out: VaultTask[] = []
  const lines = text.split(/\r?\n/)
  const soon = new Date(Date.parse(today) + soonDays * 86_400_000).toISOString().slice(0, 10)
  let inFence = false
  let section: string | undefined
  lines.forEach((raw, idx) => {
    if (/^\s*(```|~~~)/.test(raw)) inFence = !inFence
    if (inFence) return
    const h = /^#{1,6}\s+(.*)$/.exec(raw)
    if (h) {
      section = h[1]?.trim()
      return
    }
    const m = TASK_RE.exec(raw)
    if (!m) return
    const status = m[1] ?? ' '
    const body = m[2] ?? ''
    const done = status.toLowerCase() === 'x'
    const due = parseDue(body)
    out.push({
      file,
      line: idx + 1,
      text: body.replace(/\s*(📅|⏳|🛫|✅|➕)\s*\d{4}-\d{2}-\d{2}/g, '').trim(),
      done,
      status,
      due,
      overdue: !done && !!due && due < today,
      dueSoon: !done && !!due && due >= today && due <= soon,
      priority: taskPriority(body, section),
      section,
      raw
    })
  })
  return out
}

export interface LogEntry {
  file: string
  date: string
  heading: string
  lines: string[]
}

const DATE_IN_HEADING = /(\d{4}-\d{2}-\d{2})|(\d{1,2}\/\d{1,2}\/\d{2,4})/

/**
 * Splits a note into dated sections: any heading containing a date starts one, and deeper
 * headings under it (the Work Log's "### 08:14 MT — title") stay part of it. Entries come back
 * newest first by date; entries with the same date keep note order.
 */
export function parseDatedEntries(text: string, file: string): LogEntry[] {
  const out: LogEntry[] = []
  let current: LogEntry | null = null
  let level = 0
  for (const line of text.split(/\r?\n/)) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const depth = h[1]?.length ?? 1
      const d = DATE_IN_HEADING.exec(h[2] ?? '')
      if (d && (!current || depth <= level)) {
        current = { file, date: isoish(d[1] ?? d[2] ?? ''), heading: h[2] ?? '', lines: [] }
        level = depth
        out.push(current)
        continue
      }
      if (current && depth > level) {
        current.lines.push(line)
        continue
      }
      current = null
      continue
    }
    if (current && line.trim()) current.lines.push(line)
  }
  return out
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || a.i - b.i)
    .map((x) => x.e)
}

/** M/D/YYYY to YYYY-MM-DD so entries sort together; ISO dates pass through. */
function isoish(date: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(date)
  if (!m) return date
  const y = (m[3] ?? '').length === 2 ? `20${m[3]}` : (m[3] ?? '')
  return `${y}-${(m[1] ?? '').padStart(2, '0')}-${(m[2] ?? '').padStart(2, '0')}`
}

export interface SearchHit {
  file: string
  line: number
  text: string
  before: string[]
  after: string[]
}

async function* walkMarkdown(root: string, dir = root): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walkMarkdown(root, p)
    else if (e.name.toLowerCase().endsWith('.md')) yield p
  }
}

export async function searchVault(
  vaultPath: string,
  query: string,
  opts: { limit?: number; context?: number; regex?: boolean } = {}
): Promise<SearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const re = opts.regex
    ? new RegExp(q, 'i')
    : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const limit = opts.limit ?? 100
  const context = opts.context ?? 1
  const hits: SearchHit[] = []
  for await (const file of walkMarkdown(vaultPath)) {
    let text: string
    try {
      const s = await stat(file)
      if (s.size > 4 * 1024 * 1024) continue
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (re.test(lines[i] ?? '')) {
        hits.push({
          file: relative(vaultPath, file),
          line: i + 1,
          text: lines[i] ?? '',
          before: lines.slice(Math.max(0, i - context), i),
          after: lines.slice(i + 1, i + 1 + context)
        })
      }
    }
    if (hits.length >= limit) break
  }
  return hits
}

/** Lines that mention a device (serial or hostname), newest file first; used for purpose suggestions. */
export async function deviceMentions(
  vaultPath: string,
  terms: string[],
  limit = 20
): Promise<SearchHit[]> {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length >= 4)
  if (!cleaned.length) return []
  const pattern = cleaned.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return searchVault(vaultPath, pattern, { limit, context: 0, regex: true })
}

export async function readNote(vaultPath: string, noteName: string): Promise<string> {
  const file = noteName.toLowerCase().endsWith('.md') ? noteName : `${noteName}.md`
  return readFile(join(vaultPath, file), 'utf8')
}
