import { createHash } from 'node:crypto'
import type { ActionDef, ActionRecord } from '../../../shared/actions.ts'
import { changedItems, STATUS_LABEL, belongsInChangeLog } from '../../../shared/actions.ts'
import type { ScanRun, HealthFinding, HealthScore } from '../../../shared/types.ts'
import { purposeLabel } from '../../../shared/types.ts'
import type { EnrolledDevice } from '../link/devices.ts'
import { parseTasks } from './reader.ts'

/**
 * Builds the bodies of the managed blocks, following the conventions found in the ARH IT vault
 * inspection of 2026-10-15 (docs/VAULT-SCHEMA.md):
 *   - times are Mountain Time and labelled "MT", as in the Work Log and Change Log
 *   - open loops are "- [ ] 🔴 **title.** detail" lines with no due dates (the vault has none)
 *   - logs are newest first, as in the Work Log
 *   - the device table uses the column set of Asset Inventory's "## Computers" table
 *
 * Blocks (marker keys):
 *   DEVICES        Asset Inventory: one row per computer; the technician's columns are kept
 *   DEVICE-HEALTH  hub (optional): one row per computer with its latest health
 *   HEALTH-LOOPS   Open Loops: one task per finding; lines are never edited once written
 *   SCAN-LOG       Work Log: one entry per scan, action or custom command, newest first, append-only
 *   CHANGES        Change Log: one row per change made on a device, oldest first, append-only
 *
 * Each block starts with its own "##" heading so it reads as its own section wherever the
 * marker pair sits (at the end of the note by default, or wherever the technician moves it).
 */

export const BLOCK_KEYS = {
  devices: 'DEVICES',
  health: 'DEVICE-HEALTH',
  loops: 'HEALTH-LOOPS',
  log: 'SCAN-LOG',
  changes: 'CHANGES'
} as const

export type DueStyle = 'tasks-emoji' | 'dataview' | 'plain' | 'none'

export interface ContentOptions {
  dueStyle: DueStyle
  timeZone: string
  tzLabel: string
  assetNoteName: string
  openLoopsNoteName: string
  workLogNoteName: string
  changeLogNoteName: string
  dueDaysWarning: number
  dueDaysCritical: number
  maxFindingsPerLogEntry: number
}

export const DEFAULT_CONTENT_OPTIONS: ContentOptions = {
  dueStyle: 'none',
  timeZone: 'America/Denver',
  tzLabel: 'MT',
  assetNoteName: 'Asset Inventory',
  openLoopsNoteName: 'ARH Open Loops',
  workLogNoteName: 'ARH Work Log',
  changeLogNoteName: 'ARH Change Log',
  dueDaysWarning: 7,
  dueDaysCritical: 1,
  maxFindingsPerLogEntry: 5
}

export const HEADINGS = {
  devices: '## 🖥️ Computers — from ARH IT Dashboard scans',
  health: '## 🖥️ Device health — ARH IT Dashboard',
  loops: '## 🩺 Device health findings — ARH IT Dashboard',
  log: '## 🖥️ Device scans and actions — ARH IT Dashboard',
  changes: '## 🔧 Device changes — ARH IT Dashboard'
} as const

/** Headings earlier versions wrote; still recognised so they are replaced, not kept as text. */
const OLD_HEADINGS: Record<string, string[]> = {
  [HEADINGS.log]: ['## 🖥️ Device scans — ARH IT Dashboard']
}

/** Date and time in the vault's time zone (Mountain Time by default). */
export function zoned(d: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d)
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? '00'
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`
  }
}

/** Written for a time no date reads: a device's, kept unchecked by an older build. */
const NO_TIME = 'time unknown'
const isTime = (d: Date): boolean => Number.isFinite(d.getTime())

export function stamp(iso: string, opts: ContentOptions): string {
  const d = new Date(iso)
  if (!isTime(d)) return NO_TIME
  const z = zoned(d, opts.timeZone)
  return `${z.date} ${z.time} ${opts.tzLabel}`
}

/**
 * Makes text that came from a device, a script or a finding safe to put in a note: every kind of
 * line break and control character becomes a space (so nothing can start a new line, close a
 * block or forge a marker), and the characters Markdown, HTML, Obsidian and its plugins give a
 * meaning to are escaped (code spans, tags, links and embeds, comments, math, block ids, table
 * cells). Length is capped before escaping so an escape is never cut in half.
 */
export function vaultText(text: string, max = 240): string {
  let t = String(text ?? '')
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u00a0\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...t]
  if (chars.length > max)
    t = `${chars
      .slice(0, max - 1)
      .join('')
      .trimEnd()}…`
  return t.replace(/[\\`<>[\]|$#^]/g, (c) => `\\${c}`).replace(/%%/g, '\\%\\%')
}

function cell(text: string): string {
  return vaultText(text, 400)
}

function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

export function dueSuffix(style: DueStyle, date: string): string {
  switch (style) {
    case 'tasks-emoji':
      return ` 📅 ${date}`
    case 'dataview':
      return ` [due:: ${date}]`
    case 'plain':
      return ` (due: ${date})`
    case 'none':
      return ''
  }
}

export function severityMark(s: HealthFinding['severity']): string {
  return s === 'critical' ? '🔴' : s === 'warning' ? '🟠' : '🟡'
}

export function healthMark(score: HealthScore | undefined): string {
  if (score === 'critical') return '🔴 critical'
  if (score === 'attention') return '🟠 attention'
  if (score === 'healthy') return '🟢 healthy'
  return ''
}

const runTime = (r: ScanRun): string => r.finishedAt ?? r.startedAt
const newestFirst = (a: ScanRun, b: ScanRun): number => runTime(b).localeCompare(runTime(a))

export function deviceKey(serial: string, hostname: string): string {
  return (serial.trim() || hostname.trim()).toLowerCase()
}

/* ---------- facts the agent can supply for the inventory ---------- */

export interface DeviceFacts {
  model?: string
  os?: string
  mac?: string
  ip?: string
  lastScan?: string
  health?: string
}

interface AdapterJson {
  status?: unknown
  mac?: unknown
  ipv4?: unknown
  gateways?: unknown
}

/** LAN MAC and IPv4 from the Windows net-adapters check: the adapter that is up and has a gateway. */
export function lanAddress(stdout: string): { mac?: string; ip?: string } {
  let list: unknown
  try {
    list = JSON.parse(stdout)
  } catch {
    return {}
  }
  const adapters = (Array.isArray(list) ? list : [list]).filter(
    (a): a is AdapterJson => !!a && typeof a === 'object'
  )
  const arr = (v: unknown): string[] =>
    (Array.isArray(v) ? v : v == null ? [] : [v]).map(String).filter(Boolean)
  const usable = adapters
    .map((a) => ({
      up: String(a.status ?? '').toLowerCase() === 'up',
      mac: typeof a.mac === 'string' ? a.mac : undefined,
      ips: arr(a.ipv4)
        .map((ip) => ip.split('/')[0] ?? '')
        .filter((ip) => ip && !ip.startsWith('169.254.') && !ip.startsWith('127.')),
      gateways: arr(a.gateways).filter((g) => g && g !== '0.0.0.0')
    }))
    .filter((a) => a.up && a.ips.length)
  const best = usable.find((a) => a.gateways.length) ?? usable[0]
  return best ? { mac: best.mac, ip: best.ips[0] } : {}
}

/** Newest known value of each fact for one device, taken from its scans (newest first). */
export function deviceFacts(runs: ScanRun[], opts: ContentOptions): DeviceFacts {
  const facts: DeviceFacts = {}
  const sorted = [...runs].sort(newestFirst)
  const latest = sorted.find((r) => r.status !== 'running')
  if (latest)
    facts.lastScan = `${stamp(runTime(latest), opts)} · ${purposeLabel(latest.purpose)} · ${latest.status}`
  // worst of the latest run of each profile: a newer Slow Performance scan does not hide a
  // critical finding that the latest Security Check still reports
  const order: HealthScore[] = ['critical', 'attention', 'healthy']
  const scores = latestPerProfile(runs).map((r) => r.health?.score)
  const worst = order.find((s) => scores.includes(s))
  if (worst) facts.health = healthMark(worst)
  for (const r of sorted) {
    const m = r.health?.metrics ?? {}
    if (!facts.model && m['Model']?.trim()) facts.model = m['Model'].trim()
    if (!facts.os && m['OS']?.trim()) facts.os = m['OS'].trim().replace(/^Microsoft\s+/, '')
    if (!facts.mac || !facts.ip) {
      const net = r.checks.find((c) => c.id === 'net-adapters' && c.format === 'json')
      if (net?.stdout) {
        const lan = lanAddress(net.stdout)
        if (!facts.mac && lan.mac) facts.mac = lan.mac
        if (!facts.ip && lan.ip) facts.ip = lan.ip
      }
    }
  }
  return facts
}

/* ---------- DEVICES: the Asset Inventory computers table ---------- */

/** Same columns as the vault's "## Computers" table, plus two the dashboard maintains. */
export const COMPUTER_COLUMNS = [
  'Name',
  'Location',
  'Room / role',
  'Model',
  'Serial',
  'MAC',
  'IP',
  'OS',
  'Age',
  'Warranty',
  'PHI?',
  'Notes',
  'Last scan',
  'Health'
] as const

/** Columns the dashboard fills from scans. Every other column belongs to the technician. */
export const AGENT_COLUMNS: ReadonlySet<string> = new Set([
  'Name',
  'Model',
  'Serial',
  'MAC',
  'IP',
  'OS',
  'Last scan',
  'Health'
])

export function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '\\|'
      i++
    } else if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) cells.push(cur.trim())
  return cells
}

const isSeparator = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))

/** First markdown table in a block body, as header plus rows keyed by header name. */
export function readTable(body: string | null): {
  header: string[]
  rows: Array<Record<string, string>>
} {
  const lines = (body ?? '').split(/\r?\n/).filter((l) => l.trim().startsWith('|'))
  if (lines.length < 2) return { header: [], rows: [] }
  const header = splitRow(lines[0] ?? '')
  const rows: Array<Record<string, string>> = []
  for (const line of lines.slice(1)) {
    const cells = splitRow(line)
    if (isSeparator(cells)) continue
    const row: Record<string, string> = {}
    header.forEach((h, i) => (row[h] = cells[i] ?? ''))
    rows.push(row)
  }
  return { header, rows }
}

export interface DeviceRow {
  device: EnrolledDevice
  facts: DeviceFacts
}

const PLACEHOLDER_ROW = '_no enrolled computers yet_'

/**
 * Merges enrolled devices into the existing table. Rows are matched by serial, then by name.
 * The dashboard's columns are refreshed when a scan supplied a value and kept otherwise; the
 * technician's columns, rows the dashboard does not know and extra columns are kept as typed.
 */
export function devicesBlock(
  existingBody: string | null,
  rows: DeviceRow[],
  opts: ContentOptions
): string {
  const existing = readTable(existingBody)
  const extra = existing.header.filter(
    (h) => h && !(COMPUTER_COLUMNS as readonly string[]).includes(h)
  )
  const columns = [...COMPUTER_COLUMNS, ...extra]
  const kept = existing.rows.filter((r) => (r['Name'] ?? '') !== PLACEHOLDER_ROW)
  const used = new Set<Record<string, string>>()
  const out: Array<Record<string, string>> = []
  const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase()

  for (const { device, facts } of [...rows].sort((a, b) =>
    a.device.hostname.localeCompare(b.device.hostname)
  )) {
    const prior =
      kept.find(
        (r) => !used.has(r) && device.serial && norm(r['Serial']) === norm(device.serial)
      ) ?? kept.find((r) => !used.has(r) && norm(r['Name']) === norm(device.hostname))
    if (prior) used.add(prior)
    const row: Record<string, string> = { ...(prior ?? {}) }
    const set = (col: string, value: string | undefined): void => {
      if (value && value.trim()) row[col] = cell(value)
    }
    set('Name', device.hostname)
    set('Serial', device.serial)
    set('Model', facts.model)
    set('MAC', facts.mac)
    set('IP', facts.ip)
    set('OS', facts.os ?? (device.os === 'unknown' ? undefined : device.os))
    set('Last scan', facts.lastScan)
    set('Health', facts.health)
    // the enrollment label is a starting point for the room; the technician's text wins
    if (!row['Room / role'] && device.displayName && device.displayName !== device.hostname)
      row['Room / role'] = cell(device.displayName)
    out.push(row)
  }
  for (const r of kept) if (!used.has(r)) out.push(r)

  const lines = [
    HEADINGS.devices,
    '',
    `_Name, Model, Serial, MAC, IP, OS, Last scan and Health are filled from scans (times ${opts.tzLabel}). Location, Room / role, Age, Warranty, PHI? and Notes are yours: the dashboard keeps whatever you type there._`,
    '',
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`
  ]
  for (const r of out) lines.push(`| ${columns.map((c) => r[c] ?? '').join(' | ')} |`)
  if (!out.length)
    lines.push(`| ${[PLACEHOLDER_ROW, ...columns.slice(1).map(() => '')].join(' | ')} |`)
  return lines.join('\n')
}

/* ---------- HEALTH-LOOPS: Open Loops findings ---------- */

const LOOP_ID_RE = /\^loop-([0-9a-f]{8})(?:-(\d+))?\s*$/
const runRef = (runId: string): string => `run ${runId}`
const mentionsRun = (line: string, runId: string): boolean =>
  new RegExp(`\\brun ${runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(line)

/** Stable identity of a finding: device plus the message with its numbers blanked out. */
/** A finding with its numbers blanked out: the same problem on every scan that reports it. */
export function findingShape(f: Pick<HealthFinding, 'category' | 'message'>): string {
  return `${f.category}|${f.message}`.toLowerCase().replace(/\d+(?:[.,]\d+)?/g, '#')
}

export function loopKey(serial: string, hostname: string, f: HealthFinding): string {
  const shape = findingShape(f)
  return createHash('sha256')
    .update(`${deviceKey(serial, hostname)}|${shape}`)
    .digest('hex')
    .slice(0, 8)
}

export function loopLine(
  run: ScanRun,
  f: HealthFinding,
  opts: ContentOptions,
  occurrence: number,
  today: Date
): string {
  const key = loopKey(run.serial, run.hostname, f)
  const id = occurrence > 1 ? `${key}-${occurrence}` : key
  const due = new Date(
    today.getTime() +
      (f.severity === 'critical' ? opts.dueDaysCritical : opts.dueDaysWarning) * 86_400_000
  )
  const again = occurrence > 1 ? ` Back after being ticked (occurrence ${occurrence}).` : ''
  return `- [ ] ${severityMark(f.severity)} **${cell(run.hostname)} — ${cell(sentence(f.message))}** ${cell(f.category)} · ${purposeLabel(run.purpose)} scan ${stamp(runTime(run), opts)} · ${runRef(run.runId)}.${again}${dueSuffix(opts.dueStyle, zoned(due, opts.timeZone).date)} ^loop-${id}`
}

type DeviceRef = Pick<EnrolledDevice, 'id' | 'serial' | 'hostname'>

/**
 * Which machine a run belongs to. Its serial when it has one. Otherwise the enrolled device it
 * came from: by device id (stable when a serial-less PC is renamed), else the serial-less device
 * now enrolled under its hostname (an agent reinstall gets a new id; old runs keep the old one).
 * Only runs matching no enrolled device fall back to their own device id or hostname.
 */
export function runIdentity(r: ScanRun, devices: DeviceRef[] = []): string {
  const sn = (s: string): string => `sn:${s.trim().toLowerCase()}`
  if (r.serial.trim()) return sn(r.serial)
  const byId = devices.find((d) => d.id === r.deviceId)
  if (byId) return byId.serial.trim() ? sn(byId.serial) : `dev:${byId.id}`
  const host = r.hostname.trim().toLowerCase()
  const byName = devices.find((d) => !d.serial.trim() && d.hostname.trim().toLowerCase() === host)
  if (byName) return `dev:${byName.id}`
  if (r.deviceId) return `dev:${r.deviceId}`
  return `host:${host}`
}

function latestBy(runs: ScanRun[], key: (r: ScanRun) => string): ScanRun[] {
  const latest = new Map<string, ScanRun>()
  for (const r of [...runs].filter((x) => x.status !== 'running' && x.health).sort(newestFirst)) {
    const k = key(r)
    if (!latest.has(k)) latest.set(k, r)
  }
  return [...latest.values()].sort((a, b) => runTime(a).localeCompare(runTime(b)))
}

/** The latest finished run of each profile on each machine: the current state of what it checks. */
export function currentRuns(runs: ScanRun[], devices: DeviceRef[] = []): ScanRun[] {
  return latestBy(runs, (r) => `${runIdentity(r, devices)}|${r.profile}`)
}

/** For runs already known to be one machine's: the latest of each profile, whatever its name was. */
export function latestPerProfile(runs: ScanRun[]): ScanRun[] {
  return latestBy(runs, (r) => r.profile)
}

function bodyLines(existingBody: string | null, heading: string): string[] {
  const headings = new Set([heading, ...(OLD_HEADINGS[heading] ?? [])])
  return (existingBody ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !headings.has(l.trim()) && !/^_.*_$/.test(l.trim()))
}

/**
 * Adds a task for each finding in the current runs that has no open line yet. Existing lines are
 * kept exactly as they are, ticked or not. A finding whose lines are all ticked gets a new line
 * only when a scan other than the one that produced them reports it again.
 */
export function mergeLoops(
  existingBody: string | null,
  runs: ScanRun[],
  opts: ContentOptions,
  today: Date = new Date(),
  devices: DeviceRef[] = []
): { body: string; added: number } {
  const lines = bodyLines(existingBody, HEADINGS.loops)
  let added = 0
  for (const run of currentRuns(runs, devices)) {
    for (const f of run.health?.findings ?? []) {
      if (!f.loop || f.severity === 'info') continue
      const key = loopKey(run.serial, run.hostname, f)
      const mine = lines.filter((l) => LOOP_ID_RE.exec(l)?.[1] === key)
      const open = mine.some((l) => /^\s*[-*+]\s+\[ \]/.test(l))
      if (open) continue
      if (mine.some((l) => mentionsRun(l, run.runId))) continue
      lines.push(loopLine(run, f, opts, mine.length + 1, today))
      added++
    }
  }
  const intro = `_Written by the ARH IT Dashboard when a scan crosses a health threshold. Tick a line when it is fixed. The dashboard never edits a line once written; if a ticked problem shows up on a later scan it adds a new line. Device details: [[${opts.assetNoteName}]]._`
  return {
    body: [
      HEADINGS.loops,
      '',
      intro,
      '',
      ...(lines.length ? lines : ['_No open device findings._'])
    ].join('\n'),
    added
  }
}

/** Open loop lines in the block per hostname (for the hub table). */
export function openLoopsByHost(body: string | null): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of parseTasks(body ?? '', 'block')) {
    if (t.done) continue
    const m = /\*\*(.+?) — /.exec(t.raw)
    if (m?.[1]) counts.set(m[1].toLowerCase(), (counts.get(m[1].toLowerCase()) ?? 0) + 1)
  }
  return counts
}

/** Counts open loop tasks in a block body (for the dashboard's Open Loops panel). */
export function countOpenLoops(body: string | null): { open: number; done: number } {
  const tasks = parseTasks(body ?? '', 'block')
  return { open: tasks.filter((t) => !t.done).length, done: tasks.filter((t) => t.done).length }
}

/* ---------- DEVICE-HEALTH: compact hub table ---------- */

export function healthBlock(
  rows: DeviceRow[],
  loopsBody: string | null,
  opts: ContentOptions
): string {
  const open = openLoopsByHost(loopsBody)
  const lines = [
    HEADINGS.health,
    '',
    '| Computer | Health | Last scan | Open findings |',
    '| --- | --- | --- | --- |'
  ]
  for (const { device, facts } of [...rows].sort((a, b) =>
    a.device.hostname.localeCompare(b.device.hostname)
  ))
    lines.push(
      `| ${cell(device.hostname)} | ${facts.health ?? ''} | ${cell(facts.lastScan ?? 'never')} | ${open.get(device.hostname.toLowerCase()) ?? 0} |`
    )
  if (!rows.length) lines.push(`| ${PLACEHOLDER_ROW} | | | |`)
  lines.push(
    '',
    `Inventory: [[${opts.assetNoteName}]] · findings: [[${opts.openLoopsNoteName}]] · scan record: [[${opts.workLogNoteName}]]`
  )
  return lines.join('\n')
}

/* ---------- SCAN-LOG: Work Log entries ---------- */

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

export function logEntry(run: ScanRun, opts: ContentOptions): string[] {
  const findings = run.health?.findings ?? []
  const status = run.error ? `${run.status}: ${cell(run.error)}` : run.status
  const head = `- ${stamp(runTime(run), opts)} · **${cell(run.hostname)}** · serial ${cell(run.serial || 'n/a')} · ${purposeLabel(run.purpose)} · ${run.profile} v${run.version} · ${status} · ${formatDuration(run.durationMs)} · ${findings.length} finding${findings.length === 1 ? '' : 's'} · ${cell(run.technician || 'n/a')} · ${runRef(run.runId)}`
  const notable = findings.filter((f) => f.severity !== 'info')
  const shown = notable.slice(0, opts.maxFindingsPerLogEntry)
  const sub = shown.map((f) => `    - ${severityMark(f.severity)} ${cell(f.message)}`)
  if (notable.length > shown.length)
    sub.push(`    - +${notable.length - shown.length} more in the dashboard`)
  return [head, ...sub]
}

/* ---------- actions and custom commands (Phase 3) ---------- */

export interface ActionEntry {
  record: ActionRecord
  def?: ActionDef
  undoDef?: ActionDef
}

const actionTime = (r: ActionRecord): string => r.appliedAt ?? r.startedAt ?? r.requestedAt
const resultRef = (runId: string): string => `result ${runId}`
const pendingMark = 'result pending'
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/*
 * Which line is a run's own. Only the dashboard writes the end of a row or an entry's first line
 * (the By cell, the last segment), and device text, reasons and names never reach it, so a run's
 * lines are found there and nowhere else: "· run <id>", "· run <id> · result pending" while the
 * outcome is unknown, and "· result <id>" for the row added when the device reports. A scan's
 * Work Log entry ends "· run <id>" too, so a device value naming a scan cannot hide its entry.
 */
type Own = 'run' | 'pending' | 'result'
function ownLine(line: string, runId: string, table: boolean): Own | null {
  const t = line.trimEnd()
  if (table ? !t.trimStart().startsWith('|') : !t.startsWith('- ')) return null
  const id = escapeRe(runId)
  const end = table ? '\\s*\\|$' : '$'
  if (new RegExp(`· run ${id} · ${pendingMark}${end}`).test(t)) return 'pending'
  if (new RegExp(`· run ${id}${end}`).test(t)) return 'run'
  if (new RegExp(`· result ${id}${end}`).test(t)) return 'result'
  return null
}

/** Real runs the vault should show: finished, or applied with the outcome still unknown. */
function shown(e: ActionEntry): boolean {
  const r = e.record
  if (r.mode !== 'apply' || r.status === 'refused' || r.status === 'running') return false
  if (r.status === 'unknown') return !!r.appliedAt
  return !!r.endedAt
}

function machine(r: ActionRecord): string {
  const names = [r.displayName, r.hostname].filter(
    (n, i, all) => n && all.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i
  )
  return [...names, r.serial ? `serial ${r.serial}` : ''].filter(Boolean).join(' · ')
}

/** Exit code of a custom command, only when the device sent a whole number. */
function exitOf(r: ActionRecord): number | undefined {
  const x = r.result?.exitCode
  return typeof x === 'number' && Number.isInteger(x) ? x : undefined
}

/** Why a run that was applied could not be confirmed, in the device's terms. */
function notVerifiedWhy(r: ActionRecord): string {
  const after = r.result?.after
  if (r.error) return r.error
  if (!r.result?.apply) return 'the device did not report the change'
  if (!after) return 'nothing was measured afterwards'
  if (after.timedOut) return 'measuring afterwards timed out'
  if (after.exitCode !== 0) return `measuring afterwards failed (exit ${after.exitCode})`
  if (after.blockers?.length) return `measuring afterwards was blocked: ${after.blockers[0]}`
  return 'an item measured before was not measured afterwards'
}

/** "Firewall Public: off → on" for each item measured both times that moved, then evidence. */
function movedParts(r: ActionRecord): string[] {
  const after = new Set((r.result?.after?.items ?? []).map((i) => i.item))
  const before = new Set((r.result?.before?.items ?? []).map((i) => i.item))
  const moved = changedItems(r.result?.before, r.result?.after)
    .filter((c) => before.has(c.item) && after.has(c.item))
    .map((c) => `${c.item}: ${c.before} → ${c.after}`)
  return [...moved, ...(r.result?.apply?.changes ?? [])]
}

export function whatChanged(e: ActionEntry): string {
  const r = e.record
  if (r.kind === 'exec') {
    const exit = exitOf(r)
    const head =
      r.status === 'unknown'
        ? 'OUTCOME UNKNOWN: custom command started; the result has not come back yet'
        : 'Custom command (effect not measured)'
    return `${head}: sha256 ${(r.scriptSha256 ?? '').slice(0, 12)}, ${r.scriptLines ?? '?'} line(s)${exit === undefined ? '' : `, exit ${exit}`}`
  }
  if (r.status === 'unknown')
    return `OUTCOME UNKNOWN: ${r.title} started; the result has not come back yet. Check the device.`
  const parts = movedParts(r)
  if (r.status === 'not-verified')
    return `NOT VERIFIED: ${r.title} was applied, but ${notVerifiedWhy(r)}. Check the device.${parts.length ? ` Measured: ${parts.join('; ')}` : ''}`
  const text = parts.length ? parts.join('; ') : r.title
  if (r.status === 'partly-applied')
    return `Partly applied: ${text}. Still to do: ${r.result?.after?.plan ?? 'see the dashboard'}`
  return text
}

/** The second row's text, for whatever the run ended as. */
function resultText(e: ActionEntry): string {
  const r = e.record
  const s = r.status
  if (r.kind === 'exec' || s === 'changed' || s === 'partly-applied' || s === 'not-verified')
    return whatChanged(e)
  const label = STATUS_LABEL[s]
  const parts = movedParts(r)
  return `${label[0]!.toUpperCase()}${label.slice(1)}${parts.length ? `: ${parts.join('; ')}` : ''}${r.error && (s === 'failed' || s === 'aborted') ? `. ${r.error}` : ''}`
}

function reversible(e: ActionEntry): string {
  if (e.record.kind === 'exec') return 'Unknown'
  if (e.def?.undo) return 'Yes (Undo in the dashboard)'
  if (e.def?.manualUndo) return 'Yes, by hand'
  return 'No'
}

function rollback(e: ActionEntry): string {
  if (e.record.kind === 'exec') return 'Unknown (custom command)'
  const def = e.def
  if (def?.undo) {
    const restore = Object.entries(e.record.result?.before?.restore ?? {})
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')
    return `Undo in the dashboard: ${e.undoDef?.title ?? def.undo}${restore ? ` (back to ${restore})` : ''}`
  }
  return def?.manualUndo ? `Manual: ${def.manualUndo}` : ''
}

/** "2026-10-20 14:05"; in the repeated hour when daylight saving time ends, "01:30 MDT". */
export function changeStamp(iso: string, opts: ContentOptions): string {
  const d = new Date(iso)
  if (!isTime(d)) return NO_TIME
  const z = zoned(d, opts.timeZone)
  const near = [-3_600_000, 3_600_000]
    .map((ms) => new Date(d.getTime() + ms))
    .filter(isTime) // the last time a date can hold has no hour after it
    .map((n) => zoned(n, opts.timeZone))
  const twice = near.some((n) => n.date === z.date && n.time === z.time)
  if (!twice) return `${z.date} ${z.time}`
  const abbr =
    new Intl.DateTimeFormat('en-US', { timeZone: opts.timeZone, timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? opts.tzLabel
  return `${z.date} ${z.time} ${abbr}`
}

/** The reason as the technician wrote it, up to the 500 the agent accepts. */
const why = (r: ActionRecord): string => vaultText(r.reason || 'n/a', 500)

function changeRow(e: ActionEntry, opts: ContentOptions, late: boolean): string {
  const r = e.record
  const when = late ? (r.endedAt ?? actionTime(r)) : actionTime(r)
  const what = late ? `Result of run ${r.runId}: ${resultText(e)}` : whatChanged(e)
  const ref = late
    ? resultRef(r.runId)
    : `${runRef(r.runId)}${r.status === 'unknown' ? ` · ${pendingMark}` : ''}`
  return `| ${[
    changeStamp(when, opts),
    cell(machine(r)),
    vaultText(what, 600),
    why(r),
    cell(reversible(e)),
    cell(rollback(e)),
    `${cell(r.technician || 'n/a')} · ${ref}`
  ].join(' | ')} |`
}

const CHANGE_NAMES = [
  'Timestamp (MT)',
  'System / machine',
  'What changed',
  'Why',
  'Reversible?',
  'Rollback',
  'By'
]
const CHANGE_COLUMNS = `| ${CHANGE_NAMES.join(' | ')} |`
/** The header row, also when a table plugin or the technician padded or realigned it. */
const isChangeHeader = (line: string): boolean => {
  const cells = splitRow(line)
  return cells.length === CHANGE_NAMES.length && cells.every((c, i) => c === CHANGE_NAMES[i])
}

/**
 * The Change Log block: one row per change, oldest first like the note's own table, appended by
 * run id and never edited. A row written while the outcome was unknown is followed by a second
 * row once the device reports, keyed "result <run id>".
 */
export function mergeChanges(
  existingBody: string | null,
  entries: ActionEntry[],
  opts: ContentOptions
): { body: string; added: number } {
  const rows = bodyLines(existingBody, HEADINGS.changes).filter(
    (l) => l.trim().startsWith('|') && !isChangeHeader(l) && !isSeparator(splitRow(l))
  )
  const fresh: Array<{ at: string; line: string }> = []
  for (const e of entries) {
    const r = e.record
    if (!shown(e)) continue
    const own = rows.map((l) => ownLine(l, r.runId, true)).filter(Boolean)
    if (own.length) {
      // written while the outcome was unknown: add what it ended as, whatever that is
      if (own.includes('pending') && !own.includes('result') && r.status !== 'unknown')
        fresh.push({ at: r.endedAt ?? actionTime(r), line: changeRow(e, opts, true) })
      continue
    }
    if (
      belongsInChangeLog({
        mode: r.mode,
        kind: r.kind,
        access: r.access,
        status: r.status,
        result: r.result
      })
    )
      fresh.push({ at: actionTime(r), line: changeRow(e, opts, false) })
  }
  fresh.sort((a, b) => a.at.localeCompare(b.at))
  const all = [...rows, ...fresh.map((f) => f.line)]
  const intro = `_One row per change the ARH IT Dashboard made on a computer, oldest first (times ${opts.tzLabel}, by the dashboard's clock). What changed is measured on the device before and after; custom commands are listed but not measured. Full record: the dashboard's action log. Scans and every action are also in [[${opts.workLogNoteName}]]._`
  return {
    body: [
      HEADINGS.changes,
      '',
      intro,
      '',
      CHANGE_COLUMNS,
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...all
    ].join('\n'),
    added: fresh.length
  }
}

export function actionLogEntry(e: ActionEntry, opts: ContentOptions, late = false): string[] {
  const r = e.record
  const when = late ? (r.endedAt ?? actionTime(r)) : actionTime(r)
  const what =
    r.kind === 'exec'
      ? `Custom command (sha256 ${(r.scriptSha256 ?? '').slice(0, 12)}, ${r.scriptLines ?? '?'} line(s))`
      : `Action: ${cell(r.title)} (${cell(r.action ?? '')} v${r.version})`
  const status =
    r.status === 'unknown'
      ? 'outcome unknown: the result has not come back yet; it is added when the device reports'
      : r.status === 'not-verified'
        ? `not verified: ${cell(notVerifiedWhy(r))}`
        : STATUS_LABEL[r.status]
  const moved = movedParts(r).join('; ')
  const code = exitOf(r)
  const exit = r.kind === 'exec' && code !== undefined ? `exit ${code}` : ''
  const ref = late
    ? resultRef(r.runId)
    : `${runRef(r.runId)}${r.status === 'unknown' ? ` · ${pendingMark}` : ''}`
  const head = [
    `- ${stamp(when, opts)}`,
    `**${cell(r.hostname)}**`,
    `serial ${cell(r.serial || 'n/a')}`,
    late ? `result of run ${r.runId}` : '',
    what,
    status,
    moved ? vaultText(moved, 400) : '',
    exit,
    `why: ${why(r)}`,
    cell(r.technician || 'n/a'),
    ref
  ]
    .filter(Boolean)
    .join(' · ')
  const sub = [
    ...(r.result?.apply?.changes ?? []),
    ...(r.result?.apply?.warnings ?? []),
    ...((r.status === 'failed' || r.status === 'aborted') && r.error ? [r.error] : [])
  ]
    .slice(0, opts.maxFindingsPerLogEntry)
    .map((t) => `    - ${cell(t)}`)
  return [head, ...sub]
}

/**
 * Append-only by run id; new entries go on top, newest first, like the Work Log itself. Scans,
 * actions and custom commands share the block. A run first written as "outcome unknown" gets a
 * second entry, keyed "result <run id>", when the device reports.
 */
export function mergeLog(
  existingBody: string | null,
  runs: ScanRun[],
  opts: ContentOptions = DEFAULT_CONTENT_OPTIONS,
  actions: ActionEntry[] = []
): { body: string; added: number } {
  const lines = bodyLines(existingBody, HEADINGS.log)
  const fresh: Array<{ at: string; lines: string[] }> = []
  for (const run of runs.filter((r) => r.status !== 'running')) {
    if (lines.some((l) => ownLine(l, run.runId, false) === 'run')) continue
    fresh.push({ at: runTime(run), lines: logEntry(run, opts) })
  }
  for (const e of actions) {
    if (!shown(e)) continue
    const r = e.record
    const own = lines.map((l) => ownLine(l, r.runId, false)).filter(Boolean)
    if (!own.length) {
      fresh.push({ at: actionTime(r), lines: actionLogEntry(e, opts) })
      continue
    }
    if (own.includes('pending') && !own.includes('result') && r.status !== 'unknown')
      fresh.push({ at: r.endedAt ?? actionTime(r), lines: actionLogEntry(e, opts, true) })
  }
  fresh.sort((a, b) => b.at.localeCompare(a.at))
  const all = [...fresh.flatMap((f) => f.lines), ...lines]
  const intro = `_One entry per scan, action or custom command, newest first (${opts.tzLabel}). Written by the ARH IT Dashboard; findings that need action go to [[${opts.openLoopsNoteName}]], changes to [[${opts.changeLogNoteName}]]._`
  return {
    body: [HEADINGS.log, '', intro, '', ...(all.length ? all : ['_No scans logged yet._'])].join(
      '\n'
    ),
    added: fresh.length
  }
}
