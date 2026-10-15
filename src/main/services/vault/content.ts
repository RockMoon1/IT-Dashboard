import type { Purpose, ScanRun, HealthFinding } from '../../../shared/types.ts'
import { purposeLabel } from '../../../shared/types.ts'
import type { EnrolledDevice } from '../link/devices.ts'
import { parseTasks } from './reader.ts'

/**
 * Builds the bodies of the managed blocks. PROVISIONAL: headings, task syntax and due-date
 * style follow the vault report once it is approved; until then this only feeds dry-run previews.
 *
 * Blocks (marker keys):
 *   DEVICES       hub note: one table row per enrolled device
 *   DEVICE-SCANS  hub note: the most recent scans as foldable callouts
 *   HEALTH-LOOPS  open-loops note: one task per finding; existing lines are kept, new ones appended
 *   SCAN-LOG      work-log note: one dated line per scan, append-only
 */

export const BLOCK_KEYS = {
  devices: 'DEVICES',
  scans: 'DEVICE-SCANS',
  loops: 'HEALTH-LOOPS',
  log: 'SCAN-LOG'
} as const

export type DueStyle = 'tasks-emoji' | 'dataview' | 'plain' | 'none'

export interface ContentOptions {
  dueStyle: DueStyle
  maxScans: number
  hubNoteName: string
  workLogNoteName: string
  dueDaysWarning: number
  dueDaysCritical: number
}

export const DEFAULT_CONTENT_OPTIONS: ContentOptions = {
  dueStyle: 'tasks-emoji',
  maxScans: 20,
  hubNoteName: 'ARH IT Hub',
  workLogNoteName: 'ARH Work Log',
  dueDaysWarning: 7,
  dueDaysCritical: 1
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const isoTime = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
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

export interface DeviceRow {
  device: EnrolledDevice
  connected: boolean
  lastScan?: { purpose: Purpose; at: string; status: string; score?: string }
}

export function devicesTable(rows: DeviceRow[]): string {
  const lines = [
    '| Device | Serial | OS | Agent | Last seen | Last scan | Health |',
    '| --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const r of rows.sort((a, b) => a.device.displayName.localeCompare(b.device.displayName))) {
    const last = r.lastScan
      ? `${r.lastScan.at.slice(0, 10)} · ${purposeLabel(r.lastScan.purpose)} · ${r.lastScan.status}`
      : 'never'
    lines.push(
      `| ${cell(r.device.displayName)}${r.connected ? ' 🟢' : ''} | ${cell(r.device.serial || 'n/a')} | ${r.device.os} | ${cell(r.device.agentVersion || '?')} | ${r.device.lastSeen.slice(0, 16).replace('T', ' ')} | ${cell(last)} | ${r.lastScan?.score ?? ''} |`
    )
  }
  if (rows.length === 0) lines.push('| _no enrolled devices yet_ | | | | | | |')
  return lines.join('\n')
}

export function scanCallout(run: ScanRun, opts: ContentOptions): string[] {
  const finished = new Date(run.finishedAt ?? run.startedAt)
  const title = `${isoDate(finished)} ${isoTime(finished)} · ${run.hostname} · ${purposeLabel(run.purpose)} · ${run.status.toUpperCase()}`
  const lines = [`> [!info]- ${cell(title)}`]
  lines.push(
    `> **Serial:** ${cell(run.serial || 'n/a')} · **Profile:** ${run.profile} v${run.version} · **Technician:** ${cell(run.technician)} · **Duration:** ${(run.durationMs / 1000).toFixed(0)} s · **Run:** ${run.runId}`
  )
  if (run.error) lines.push(`> **Error:** ${cell(run.error)}`)
  const findings = run.health?.findings ?? []
  if (findings.length) {
    lines.push(`> **Findings (${findings.length}):**`)
    for (const f of findings) lines.push(`> - ${severityMark(f.severity)} ${cell(f.message)}`)
  } else {
    lines.push('> **Findings:** none crossed the thresholds')
  }
  const metrics = Object.entries(run.health?.metrics ?? {})
  if (metrics.length) {
    lines.push('>', '> | Metric | Value |', '> | --- | --- |')
    for (const [k, v] of metrics) lines.push(`> | ${cell(k)} | ${cell(v)} |`)
  }
  lines.push('>', `> *Logged in [[${opts.workLogNoteName}]]*`)
  return lines
}

export function severityMark(s: HealthFinding['severity']): string {
  return s === 'critical' ? '🔴' : s === 'warning' ? '🟠' : 'ℹ️'
}

/** Newest first; keeps at most maxScans callouts. */
export function scansBlock(runs: ScanRun[], opts: ContentOptions): string {
  const sorted = [...runs]
    .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))
    .slice(0, opts.maxScans)
  if (!sorted.length) return '_No device scans recorded yet._'
  return sorted.map((r) => scanCallout(r, opts).join('\n')).join('\n\n')
}

/** Task line for one finding. The run id suffix keeps lines unique and traceable. */
export function loopLine(
  run: ScanRun,
  f: HealthFinding,
  opts: ContentOptions,
  today: Date
): string {
  const due = new Date(
    today.getTime() +
      (f.severity === 'critical' ? opts.dueDaysCritical : opts.dueDaysWarning) * 86_400_000
  )
  const priority = f.severity === 'critical' ? ' ⏫' : ''
  return `- [ ] ${run.hostname}: ${f.message} (${purposeLabel(run.purpose)} scan ${isoDate(new Date(run.finishedAt ?? run.startedAt))}, ${f.category})${opts.dueStyle === 'tasks-emoji' ? priority : ''}${dueSuffix(opts.dueStyle, isoDate(due))} ^loop-${shortId(f.id, run.hostname)}`
}

function shortId(findingId: string, hostname: string): string {
  let h = 0
  for (const ch of `${hostname}:${findingId}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h.toString(36)
}

/**
 * Merges new loop lines into the existing block body: lines already present (by their ^loop id)
 * are kept exactly as they are, ticked or not, so the technician's progress is never lost.
 */
export function mergeLoops(
  existingBody: string | null,
  runs: ScanRun[],
  opts: ContentOptions,
  today: Date = new Date()
): { body: string; added: number } {
  const existing = (existingBody ?? '').split(/\r?\n/).filter((l) => l.trim())
  const known = new Set(
    existing.map((l) => /\^loop-([a-z0-9]+)\s*$/.exec(l)?.[1]).filter((x): x is string => !!x)
  )
  const lines = [...existing]
  let added = 0
  for (const run of runs) {
    for (const f of run.health?.findings ?? []) {
      if (!f.loop) continue
      const line = loopLine(run, f, opts, today)
      const id = /\^loop-([a-z0-9]+)\s*$/.exec(line)?.[1]
      if (!id || known.has(id)) continue
      known.add(id)
      lines.push(line)
      added++
    }
  }
  if (!lines.length) return { body: '_No open health loops._', added: 0 }
  return { body: lines.filter((l) => l !== '_No open health loops._').join('\n'), added }
}

export function logLine(run: ScanRun): string {
  const finished = new Date(run.finishedAt ?? run.startedAt)
  const n = run.health?.findings.length ?? 0
  return `- ${isoDate(finished)} ${isoTime(finished)} · ${run.hostname} (${run.serial || 'no serial'}) · ${purposeLabel(run.purpose)} · ${run.profile} v${run.version} · ${run.status} · ${n} finding(s) · ${run.technician}`
}

/** Append-only: existing lines stay, new run lines are added (by run id). */
export function mergeLog(
  existingBody: string | null,
  runs: ScanRun[]
): { body: string; added: number } {
  const existing = (existingBody ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('_No scans'))
  const lines = [...existing]
  let added = 0
  for (const run of [...runs].sort((a, b) =>
    (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt)
  )) {
    if (existing.some((l) => l.includes(run.runId))) continue
    lines.push(`${logLine(run)} · ${run.runId}`)
    added++
  }
  if (!lines.length) return { body: '_No scans logged yet._', added: 0 }
  return { body: lines.join('\n'), added }
}

/** Counts open loop tasks in a block body (for the dashboard's Open Loops panel). */
export function countOpenLoops(body: string | null): { open: number; done: number } {
  const tasks = parseTasks(body ?? '', 'block')
  return { open: tasks.filter((t) => !t.done).length, done: tasks.filter((t) => t.done).length }
}
