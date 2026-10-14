import { access, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type {
  Protocol,
  SessionSummary,
  Settings,
  VaultCheckResult,
  VaultWriteResult
} from '../../../shared/types.ts'
import { purposeLabel } from '../../../shared/types.ts'

/**
 * Appends diagnostic results to the existing ARH IT vault notes.
 *
 * Rules (from the Phase 1 schema assessment):
 * - Never create files. Missing notes are an error the technician must resolve.
 * - Hub note: entries go under a "## Device Scans" section (created inside the note if absent),
 *   each as a foldable callout so the hub stays readable.
 * - Work log: one dated line per run, appended under the "## YYYY-MM-DD" heading for the day.
 * - Line endings of the existing note are preserved.
 */

export type VaultErrorCode = 'vault-missing' | 'note-missing' | 'write-failed'

export class VaultError extends Error {
  code: VaultErrorCode
  constructor(code: VaultErrorCode, message: string) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

export type Eol = '\r\n' | '\n'

export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/

export function parseHeading(line: string): { level: number; text: string } | null {
  const m = HEADING_RE.exec(line)
  if (!m) return null
  return { level: m[1]!.length, text: m[2] ?? '' }
}

export interface Section {
  /** Index of the heading line. */
  start: number
  /** Index of the first line after the section (exclusive). */
  end: number
}

function sectionEnd(lines: string[], start: number, level: number): number {
  let inFence = false
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    const h = parseHeading(line)
    if (h && h.level <= level) return i
  }
  return lines.length
}

/** Finds a heading of the given level whose text matches (case-insensitive, trimmed). */
export function findSection(lines: string[], headingText: string, level = 2): Section | null {
  const wanted = headingText.trim().toLowerCase()
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeading(lines[i] ?? '')
    if (h && h.level === level && h.text.trim().toLowerCase() === wanted) {
      return { start: i, end: sectionEnd(lines, i, level) }
    }
  }
  return null
}

/** Finds a heading of the given level whose text starts with the prefix (used for dated headings). */
export function findSectionByPrefix(lines: string[], prefix: string, level = 2): Section | null {
  const wanted = prefix.trim().toLowerCase()
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeading(lines[i] ?? '')
    if (h && h.level === level && h.text.trim().toLowerCase().startsWith(wanted)) {
      return { start: i, end: sectionEnd(lines, i, level) }
    }
  }
  return null
}

function trimTrailingBlank(lines: string[]): string[] {
  const out = [...lines]
  while (out.length && (out[out.length - 1] ?? '').trim() === '') out.pop()
  return out
}

const LIST_ITEM_RE = /^\s*([-*+]|\d+[.)])\s/

function isListItem(line: string | undefined): boolean {
  return line != null && LIST_ITEM_RE.test(line)
}

function insertIntoSection(lines: string[], section: Section, entryLines: string[]): string[] {
  const body = trimTrailingBlank(lines.slice(section.start + 1, section.end))
  const after = lines.slice(section.end)
  // Consecutive list items stay in one list; anything else is separated by a blank line.
  const separator =
    body.length && isListItem(body[body.length - 1]) && isListItem(entryLines[0]) ? [] : ['']
  const newBody = [...body, ...separator, ...entryLines, '']
  const result = [...lines.slice(0, section.start + 1), ...newBody, ...after]
  // When the section was the last thing in the file, keep exactly one trailing newline.
  if (after.length === 0) {
    while (
      result.length >= 2 &&
      result[result.length - 1] === '' &&
      result[result.length - 2] === ''
    )
      result.pop()
  }
  return result
}

function appendSectionAtEnd(lines: string[], heading: string, entryLines: string[]): string[] {
  const base = trimTrailingBlank(lines)
  return [...base, '', heading, '', ...entryLines, '']
}

/** Index at which a new top section should be inserted when newest-first ordering is wanted. */
export function topInsertIndex(lines: string[]): number {
  let i = 0
  if ((lines[0] ?? '').trim() === '---') {
    const close = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---')
    if (close > 0) i = close + 1
  }
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++
  const h = parseHeading(lines[i] ?? '')
  if (h && h.level === 1) {
    i++
    // keep an intro paragraph directly under the title together with it
    while (i < lines.length && (lines[i] ?? '').trim() !== '' && !parseHeading(lines[i] ?? '')) i++
  }
  return i
}

export interface AppendResult {
  text: string
  created: boolean
}

/** Appends entry lines at the end of the named section, creating the section at EOF if missing. */
export function appendToSection(
  markdown: string,
  headingText: string,
  entryLines: string[],
  opts: { level?: number; createIfMissing?: boolean } = {}
): AppendResult {
  const level = opts.level ?? 2
  const eol = detectEol(markdown)
  const lines = splitLines(markdown)
  const section = findSection(lines, headingText, level)
  if (section) {
    return { text: insertIntoSection(lines, section, entryLines).join(eol), created: false }
  }
  if (opts.createIfMissing === false) {
    throw new VaultError('note-missing', `Section "${headingText}" not found`)
  }
  const heading = `${'#'.repeat(level)} ${headingText.trim()}`
  return { text: appendSectionAtEnd(lines, heading, entryLines).join(eol), created: true }
}

/** Appends entry lines under the dated heading for `date`, creating the heading if needed. */
export function appendUnderDateHeading(
  markdown: string,
  date: string,
  entryLines: string[],
  opts: { newestFirst?: boolean; level?: number } = {}
): AppendResult {
  const level = opts.level ?? 2
  const eol = detectEol(markdown)
  const lines = splitLines(markdown)
  const section = findSectionByPrefix(lines, date, level)
  if (section) {
    return { text: insertIntoSection(lines, section, entryLines).join(eol), created: false }
  }
  const heading = `${'#'.repeat(level)} ${date}`
  if (opts.newestFirst) {
    const at = topInsertIndex(lines)
    const before = trimTrailingBlank(lines.slice(0, at))
    const after = lines.slice(at)
    while (after.length && (after[0] ?? '').trim() === '') after.shift()
    const block = [...(before.length ? [''] : []), heading, '', ...entryLines, '']
    return { text: [...before, ...block, ...after].join(eol), created: true }
  }
  return { text: appendSectionAtEnd(lines, heading, entryLines).join(eol), created: true }
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function noteName(file: string): string {
  const ext = extname(file)
  return ext.toLowerCase() === '.md' ? basename(file, ext) : basename(file)
}

export function ensureMd(file: string): string {
  return extname(file).toLowerCase() === '.md' ? file : `${file}.md`
}

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

export function protocolLabel(p: Protocol): string {
  return p === 'winrm' ? 'WinRM' : p === 'ssh' ? 'SSH' : 'local'
}

/** Foldable callout for the hub's Device Scans section. */
export function buildHubEntry(
  summary: SessionSummary,
  settings: Pick<Settings, 'workLogNote'>,
  finished: Date = new Date(summary.finishedAt)
): string[] {
  const title = `${formatDate(finished)} ${formatTime(finished)} · ${summary.deviceName} · ${purposeLabel(summary.purpose)}`
  const target = summary.host ? `${summary.host}` : summary.deviceName
  const lines = [
    `> [!info]- ${cell(title)}`,
    `> **Target:** ${cell(target)} via ${protocolLabel(summary.protocol)} (${summary.targetOs}) · **Result:** ${summary.ok ? 'OK' : 'FAILED'} · **Session:** ${summary.sessionId}`
  ]
  if (summary.error) lines.push(`> **Error:** ${cell(summary.error)}`)
  if (summary.findings.length) {
    lines.push(`> **Findings (${summary.findings.length}):**`)
    for (const f of summary.findings) lines.push(`> - ${cell(f)}`)
  } else {
    lines.push('> **Findings:** none flagged by the configured thresholds')
  }
  const metrics = Object.entries(summary.metrics)
  if (metrics.length) {
    lines.push('>', '> | Metric | Value |', '> | --- | --- |')
    for (const [k, v] of metrics) lines.push(`> | ${cell(k)} | ${cell(v)} |`)
  }
  if (summary.notes) lines.push('>', `> **Notes:** ${cell(summary.notes)}`)
  lines.push(
    '>',
    `> *Commands run: ${summary.results.length} · logged in [[${noteName(settings.workLogNote)}]]*`
  )
  return lines
}

/** One-line, append-only record for the work log. */
export function buildWorkLogEntry(
  summary: SessionSummary,
  settings: Pick<Settings, 'hubNote' | 'hubSection'>,
  finished: Date = new Date(summary.finishedAt)
): string[] {
  const where = summary.host ? ` (${summary.host})` : ''
  const outcome = summary.ok ? '' : 'FAILED · '
  const findings = summary.findings.length
    ? `${summary.findings.length} finding(s): ${summary.findings.slice(0, 3).map(cell).join('; ')}${summary.findings.length > 3 ? '; …' : ''}`
    : 'no findings flagged'
  const notes = summary.notes ? ` · ${cell(summary.notes)}` : ''
  return [
    `- ${formatTime(finished)} · Device scan · **${cell(summary.deviceName)}** · ${purposeLabel(summary.purpose)} via ${protocolLabel(summary.protocol)}${where} → ${outcome}${findings}${notes} · see [[${noteName(settings.hubNote)}#${settings.hubSection}]]`
  ]
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function notePaths(settings: Pick<Settings, 'vaultPath' | 'hubNote' | 'workLogNote'>): {
  hubPath: string
  workLogPath: string
} {
  return {
    hubPath: join(settings.vaultPath, ensureMd(settings.hubNote)),
    workLogPath: join(settings.vaultPath, ensureMd(settings.workLogNote))
  }
}

export async function checkVault(settings: Settings): Promise<VaultCheckResult> {
  const { hubPath, workLogPath } = notePaths(settings)
  const vaultExists = await exists(settings.vaultPath)
  const hubExists = vaultExists && (await exists(hubPath))
  const workLogExists = vaultExists && (await exists(workLogPath))
  let hubSectionExists: boolean | null = null
  const problems: string[] = []
  if (!vaultExists) problems.push(`Vault folder not found: ${settings.vaultPath}`)
  if (vaultExists && !hubExists)
    problems.push(`Hub note not found: ${hubPath} (the app never creates notes)`)
  if (vaultExists && !workLogExists)
    problems.push(`Work log note not found: ${workLogPath} (the app never creates notes)`)
  if (hubExists) {
    const text = await readFile(hubPath, 'utf8')
    hubSectionExists = findSection(splitLines(text), settings.hubSection) !== null
  }
  return {
    vaultPath: settings.vaultPath,
    vaultExists,
    hubPath,
    hubExists,
    hubSectionExists,
    workLogPath,
    workLogExists,
    problems
  }
}

export async function writeSessionToVault(
  settings: Settings,
  summary: SessionSummary,
  now: Date = new Date()
): Promise<VaultWriteResult> {
  if (!(await exists(settings.vaultPath))) {
    throw new VaultError('vault-missing', `Vault folder not found: ${settings.vaultPath}`)
  }
  const { hubPath, workLogPath } = notePaths(settings)
  for (const p of [hubPath, workLogPath]) {
    if (!(await exists(p)))
      throw new VaultError('note-missing', `Note not found (not created by design): ${p}`)
  }
  const finished = Number.isFinite(Date.parse(summary.finishedAt))
    ? new Date(summary.finishedAt)
    : now
  const hubLines = buildHubEntry(summary, settings, finished)
  const workLogLines = buildWorkLogEntry(summary, settings, finished)

  const hubText = await readFile(hubPath, 'utf8')
  const hub = appendToSection(hubText, settings.hubSection, hubLines, { createIfMissing: true })
  const workLogText = await readFile(workLogPath, 'utf8')
  const workLog = appendUnderDateHeading(workLogText, formatDate(finished), workLogLines, {
    newestFirst: settings.workLogNewestFirst
  })

  try {
    await writeFile(hubPath, hub.text, 'utf8')
    await writeFile(workLogPath, workLog.text, 'utf8')
  } catch (err) {
    throw new VaultError('write-failed', `Could not write to the vault: ${(err as Error).message}`)
  }
  return {
    hubPath,
    workLogPath,
    hubEntryLines: hubLines.length,
    workLogEntryLines: workLogLines.length
  }
}
