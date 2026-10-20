import type {
  ComputerFact,
  ComputerProfile,
  ComputerSummary,
  HealthScore,
  LookupResult,
  LookupTarget,
  MetricSeries,
  ProfileFinding,
  ProfileLoop,
  ProfileScan,
  RecurringFinding,
  ScanRun,
  Settings,
  Severity,
  TimelineEvent,
  VaultMention,
  VaultRow,
  VaultTicket
} from '../../../shared/types.ts'
import { purposeLabel } from '../../../shared/types.ts'
import type { EnrolledDevice } from '../link/devices.ts'
import { THRESHOLDS } from '../scans/health.ts'
import {
  DEFAULT_CONTENT_OPTIONS,
  deviceFacts,
  latestPerProfile,
  findingShape,
  splitRow,
  zoned
} from '../vault/content.ts'
import { parseDatedEntries, parseTasks } from '../vault/reader.ts'
import type { IndexedNote } from './vaultindex.ts'

/**
 * Computer lookup: one record per computer, merged from enrollment, every stored scan and the
 * Asset Inventory tables, plus everything the vault says about it. Read-only and offline: the
 * computer does not need to be connected.
 */

/* ---------- matching ---------- */

const WORD = 'A-Za-z0-9_\\-'

/**
 * Whole-word pattern for a term. A purely alphabetic hostname such as COMPUTER is matched with
 * its exact case, so the word "computer" in a sentence is not taken for the machine.
 */
export function termRegex(term: string, exactCase = false): RegExp | null {
  const t = term.trim()
  if (t.length < 3) return null
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![${WORD}])${esc}(?![${WORD}])`, exactCase ? '' : 'i')
}

export interface Matcher {
  terms: string[]
  test(text: string): boolean
}

export function matcher(terms: Array<{ text: string; exactCase?: boolean }>): Matcher {
  const res = terms
    .map((t) => ({ text: t.text.trim(), re: termRegex(t.text, t.exactCase) }))
    .filter((t): t is { text: string; re: RegExp } => !!t.re)
  return { terms: res.map((r) => r.text), test: (text) => res.some((r) => r.re.test(text)) }
}

const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase()
const BLANK = new Set(['', 'n/a', 'na', '-', '—', '?', '(confirm)', 'tbd', 'unknown'])
export const isBlank = (s: string | undefined): boolean =>
  BLANK.has(norm(s)) || /^_.*_$/.test((s ?? '').trim())

/* ---------- vault tables ---------- */

const isSeparator = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c))

/** Every table row in a note, with its header and 1-based line number. */
export function tableRows(note: IndexedNote): Array<VaultRow & { header: string[] }> {
  const out: Array<VaultRow & { header: string[] }> = []
  let header: string[] | null = null
  note.lines.forEach((line, i) => {
    if (!line.trim().startsWith('|')) {
      header = null
      return
    }
    const cells = splitRow(line)
    if (!header) {
      header = cells
      return
    }
    if (isSeparator(cells)) return
    const row: Record<string, string> = {}
    header.forEach((h, j) => (row[h] = cells[j] ?? ''))
    out.push({ file: note.rel, line: i + 1, cells: row, header })
  })
  return out
}

/** Rows of computer tables (a Name and a Serial column) that name or number a machine. */
export function inventoryRows(note: IndexedNote): VaultRow[] {
  return tableRows(note)
    .filter((r) => r.header.includes('Name') && r.header.includes('Serial'))
    .filter((r) => !isBlank(r.cells['Name']) || !isBlank(r.cells['Serial']))
    .map(({ file, line, cells }) => ({ file, line, cells }))
}

/** Lines inside the dashboard's own marker blocks, so its output is not read back as a note. */
function dashboardLines(note: IndexedNote): Set<number> {
  const out = new Set<number>()
  let inside = false
  note.lines.forEach((l, i) => {
    if (/<!--\s*DASH:[A-Z0-9_-]+:START\s*-->/.test(l)) inside = true
    if (inside) out.add(i + 1)
    if (/<!--\s*DASH:[A-Z0-9_-]+:END\s*-->/.test(l)) inside = false
  })
  return out
}

/* ---------- vault times ---------- */

/** A wall-clock time in the vault's zone (MT) as a UTC ISO string, so it sorts with scan times. */
export function zonedToIso(date: string, time: string, timeZone: string): string {
  const guess = new Date(`${date}T${time}:00Z`)
  if (Number.isNaN(guess.getTime())) return date
  // offset of the zone at an instant: (wall clock there, read as UTC) minus the instant
  const offsetAt = (t: number): number => {
    const z = zoned(new Date(t), timeZone)
    return Date.parse(`${z.date}T${z.time}:00Z`) - t
  }
  // first pass uses the offset 6-7 h too early; on a DST change day that can be the other side
  // of the change, so take the offset again at the candidate instant
  const first = guess.getTime() - offsetAt(guess.getTime())
  const second = guess.getTime() - offsetAt(first)
  return new Date(second).toISOString()
}

/** The "### HH:MM MT — title" parts of a Work Log day that mention the computer. */
export function matchingParts(
  lines: string[],
  match: Matcher
): Array<{ heading?: string; time?: string; lines: string[] }> {
  const parts: Array<{ heading?: string; time?: string; lines: string[] }> = [{ lines: [] }]
  for (const l of lines) {
    const h = /^#{3,6}\s+(.*)$/.exec(l)
    if (h)
      parts.push({
        heading: h[1]?.trim(),
        time: /^(\d{1,2}:\d{2})\b/.exec(h[1] ?? '')?.[1],
        lines: [l]
      })
    else parts[parts.length - 1]!.lines.push(l)
  }
  return parts.filter((p) => p.lines.length && p.lines.some((l) => match.test(l)))
}

/* ---------- computers ---------- */

export interface Computer {
  key: string
  names: string[]
  serials: string[]
  device?: EnrolledDevice
  runs: ScanRun[]
  inventory: VaultRow[]
}

const runTime = (r: ScanRun): string => r.finishedAt ?? r.startedAt

export function buildComputers(
  devices: EnrolledDevice[],
  runs: ScanRun[],
  inventory: VaultRow[]
): Computer[] {
  const list: Computer[] = []
  // In order of certainty: the enrolled device, then an exact serial, then the name, and the name
  // only when the serials cannot disagree (two different serials are two machines).
  const find = (serial: string, name: string, deviceId?: string): Computer | undefined => {
    if (deviceId) {
      const byDevice = list.find((c) => c.device?.id === deviceId)
      if (byDevice) return byDevice
    }
    const s = isBlank(serial) ? '' : norm(serial)
    if (s) {
      const bySerial = list.find((c) => c.serials.some((x) => norm(x) === s))
      if (bySerial) return bySerial
    }
    if (isBlank(name)) return undefined
    return list.find(
      (c) => (!s || !c.serials.length) && c.names.some((n) => norm(n) === norm(name))
    )
  }
  const remember = (c: Computer, serial: string, name: string): void => {
    if (!isBlank(serial) && !c.serials.some((x) => norm(x) === norm(serial)))
      c.serials.push(serial.trim())
    if (!isBlank(name) && !c.names.some((x) => norm(x) === norm(name))) c.names.push(name.trim())
  }
  const create = (): Computer => {
    const c: Computer = { key: '', names: [], serials: [], runs: [], inventory: [] }
    list.push(c)
    return c
  }

  // every enrolled device is its own computer, even when two share a hostname
  for (const d of devices) {
    const c = create()
    c.device = d
    remember(c, d.serial, d.hostname)
  }
  for (const r of [...runs]
    .filter((x) => x.status !== 'running')
    .sort((a, b) => runTime(b).localeCompare(runTime(a)))) {
    const c = find(r.serial, r.hostname, r.deviceId) ?? create()
    c.runs.push(r)
    remember(c, r.serial, r.hostname)
  }
  for (const row of inventory) {
    const serial = row.cells['Serial'] ?? ''
    const name = row.cells['Name'] ?? ''
    const c = find(serial, name) ?? create()
    c.inventory.push(row)
    remember(c, serial, name)
  }
  const used = new Set<string>()
  for (const c of list) {
    const base = c.serials[0] ? `sn:${norm(c.serials[0])}` : `host:${norm(c.names[0] ?? 'unknown')}`
    let key = base
    for (let n = 2; used.has(key); n++) key = `${base}#${n}`
    used.add(key)
    c.key = key
  }
  return list
}

const SCORE_ORDER: HealthScore[] = ['critical', 'attention', 'healthy']
const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info']

function worstScore(runs: ScanRun[]): HealthScore | undefined {
  const scores = latestPerProfile(runs).map((r) => r.health?.score)
  return SCORE_ORDER.find((s) => scores.includes(s))
}

export function summarize(c: Computer, connected: (deviceId: string) => boolean): ComputerSummary {
  const facts = deviceFacts(c.runs, DEFAULT_CONTENT_OPTIONS)
  const inv = (col: string): string | undefined =>
    c.inventory.map((r) => r.cells[col]).find((v) => !isBlank(v))
  const name = c.device?.hostname || c.names[0] || c.serials[0] || 'unknown'
  const aliases = [
    ...(c.device && c.device.displayName !== c.device.hostname ? [c.device.displayName] : []),
    ...c.names.filter((n) => norm(n) !== norm(name))
  ]
  const sources: ComputerSummary['sources'] = []
  if (c.device) sources.push('enrolled')
  if (c.runs.length) sources.push('scans')
  if (c.inventory.length) sources.push('inventory')
  return {
    key: c.key,
    name,
    aliases,
    serial: c.serials[0],
    model: facts.model ?? inv('Model'),
    os: facts.os ?? inv('OS') ?? (c.device && c.device.os !== 'unknown' ? c.device.os : undefined),
    location: inv('Location'),
    room: inv('Room / role'),
    ip: facts.ip ?? inv('IP'),
    mac: facts.mac ?? inv('MAC'),
    deviceId: c.device?.id,
    connected: c.device ? connected(c.device.id) : false,
    lastSeen: c.device?.lastSeen,
    health: worstScore(c.runs),
    lastScanAt: c.runs[0] ? runTime(c.runs[0]) : undefined,
    scans: c.runs.length,
    sources
  }
}

/** Ranks computers for what was typed: names and serials first, then addresses, room, model. */
export function rankComputers(query: string, summaries: ComputerSummary[]): ComputerSummary[] {
  const q = norm(query)
  if (!q)
    return [...summaries].sort(
      (a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)
    )
  const hex = (s: string): string => s.toLowerCase().replace(/[^0-9a-f]/g, '')
  const scored: Array<{ s: ComputerSummary; score: number; match: string }> = []
  for (const s of summaries) {
    const fields: Array<[string, string | undefined, number]> = [
      ['name', s.name, 100],
      ['serial', s.serial, 95],
      ['IP', s.ip, 90],
      ...s.aliases.map((a): [string, string, number] => ['also', a, 85]),
      ['room', s.room, 60],
      ['location', s.location, 50],
      ['model', s.model, 40],
      ['OS', s.os, 20]
    ]
    let best = { score: 0, match: '' }
    for (const [label, value, weight] of fields) {
      const v = norm(value)
      if (!v) continue
      const score =
        v === q ? weight + 60 : v.startsWith(q) ? weight + 30 : v.includes(q) ? weight : 0
      if (score > best.score) best = { score, match: `${label} ${value}` }
    }
    if (s.mac && hex(q).length >= 4 && hex(s.mac).includes(hex(q)) && 90 > best.score)
      best = { score: 90, match: `MAC ${s.mac}` }
    if (best.score) scored.push({ s, ...best })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .map(({ s, match }) => ({ ...s, match }))
}

/* ---------- notes by role ---------- */

export interface NoteRoles {
  assets?: IndexedNote
  openLoops?: IndexedNote
  workLog?: IndexedNote
  changeLog?: IndexedNote
  tickets: IndexedNote[]
}

const relKey = (p: string): string =>
  p
    .replace(/[\\/]+/g, '/')
    .toLowerCase()
    .replace(/\.md$/, '')

export function noteRoles(
  notes: IndexedNote[],
  settings: Pick<Settings, 'assetNote' | 'openLoopsNote' | 'workLogNote'>
): NoteRoles {
  const byRel = (setting: string): IndexedNote | undefined =>
    notes.find((n) => relKey(n.rel) === relKey(setting))
  return {
    assets: byRel(settings.assetNote),
    openLoops: byRel(settings.openLoopsNote),
    workLog: byRel(settings.workLogNote),
    changeLog: notes.find((n) => n.folder === '' && norm(n.name) === 'arh change log'),
    tickets: notes.filter(
      (n) =>
        n.folder.toLowerCase() === 'tickets' &&
        !['ticket index', 'ticket template'].includes(norm(n.name))
    )
  }
}

export function ticketOf(note: IndexedNote): VaultTicket {
  const fm = note.frontmatter
  const tasks = parseTasks(note.text, note.rel)
  const status = fm['status'] || undefined
  const date =
    (fm['date'] || fm['opened'] || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] ??
    note.name.match(/\d{4}-\d{2}-\d{2}/)?.[0]
  return {
    file: note.rel,
    id: fm['id'] || undefined,
    title: note.title,
    date,
    status,
    priority: fm['priority'] || fm['severity'] || undefined,
    category: fm['category'] || undefined,
    location: fm['location'] || undefined,
    closed: /^(closed|resolved|done)\b/i.test(status ?? ''),
    openTasks: tasks.filter((t) => !t.done).length,
    doneTasks: tasks.filter((t) => t.done).length
  }
}

/* ---------- metric series ---------- */

interface SeriesDef {
  label: string
  unit: string
  threshold?: number
  better: 'higher' | 'lower'
}

export function seriesDef(key: string): SeriesDef | null {
  if (key.startsWith('disk-free:'))
    return {
      label: `Disk ${key.slice('disk-free:'.length)} free`,
      unit: '%',
      threshold: THRESHOLDS.diskFreePctLow,
      better: 'higher'
    }
  const defs: Record<string, SeriesDef> = {
    'update-age': {
      label: 'Days since a Windows update',
      unit: 'd',
      threshold: THRESHOLDS.updateAgeDaysStale,
      better: 'lower'
    },
    'failed-logins-24h': {
      label: 'Failed sign-ins in 24 h',
      unit: '',
      threshold: THRESHOLDS.failedLogins24hSpike,
      better: 'lower'
    },
    'battery-health': {
      label: 'Battery health',
      unit: '%',
      threshold: THRESHOLDS.batteryHealthPctLow,
      better: 'higher'
    },
    'ram-used': {
      label: 'RAM used',
      unit: '%',
      threshold: THRESHOLDS.ramUsedPctHigh,
      better: 'lower'
    },
    cpu: { label: 'CPU', unit: '%', threshold: THRESHOLDS.cpuPctHigh, better: 'lower' },
    'av-signature-age': {
      label: 'AV signature age',
      unit: 'd',
      threshold: THRESHOLDS.signatureAgeDaysStale,
      better: 'lower'
    },
    'uptime-days': {
      label: 'Uptime',
      unit: 'd',
      threshold: THRESHOLDS.uptimeDaysLong,
      better: 'lower'
    },
    'system-errors-7d': {
      label: 'System log errors (7 d)',
      unit: '',
      threshold: THRESHOLDS.systemErrorsMany,
      better: 'lower'
    },
    'startup-items': {
      label: 'Startup programs',
      unit: '',
      threshold: THRESHOLDS.startupItemsMany,
      better: 'lower'
    }
  }
  return defs[key] ?? null
}

const SERIES_ORDER = [
  'disk-free:',
  'update-age',
  'failed-logins-24h',
  'battery-health',
  'ram-used',
  'cpu',
  'av-signature-age',
  'uptime-days',
  'system-errors-7d',
  'startup-items'
]

export function metricSeries(runs: ScanRun[]): MetricSeries[] {
  const map = new Map<string, MetricSeries>()
  for (const r of [...runs].sort((a, b) => runTime(a).localeCompare(runTime(b)))) {
    for (const [key, value] of Object.entries(r.health?.values ?? {})) {
      const def = seriesDef(key)
      if (!def) continue
      let s = map.get(key)
      if (!s) {
        s = { key, ...def, points: [] }
        map.set(key, s)
      }
      s.points.push({ at: runTime(r), value, runId: r.runId })
    }
  }
  const rank = (k: string): number => {
    const i = SERIES_ORDER.findIndex((p) => (p.endsWith(':') ? k.startsWith(p) : k === p))
    return i === -1 ? SERIES_ORDER.length : i
  }
  return [...map.values()].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
}

/* ---------- profile ---------- */

export interface ProfileInput {
  target: LookupTarget
  computers: Computer[]
  notes: IndexedNote[]
  settings: Pick<Settings, 'assetNote' | 'openLoopsNote' | 'workLogNote'>
  connected: (deviceId: string) => boolean
  vaultError?: string
}

export function resolveTarget(target: LookupTarget, computers: Computer[]): Computer | null {
  if ('key' in target) return computers.find((c) => c.key === target.key) ?? null
  if ('deviceId' in target) return computers.find((c) => c.device?.id === target.deviceId) ?? null
  const t = norm(target.term)
  return (
    computers.find(
      (c) => c.serials.some((s) => norm(s) === t) || c.names.some((n) => norm(n) === t)
    ) ?? null
  )
}

export function buildProfile(input: ProfileInput): ComputerProfile {
  const started = performance.now()
  const computer = resolveTarget(input.target, input.computers)
  const term = 'term' in input.target ? input.target.term.trim() : ''
  const summary: ComputerSummary = computer
    ? summarize(computer, input.connected)
    : {
        key: `term:${norm(term)}`,
        name: term,
        aliases: [],
        connected: false,
        scans: 0,
        sources: []
      }
  const match = computer
    ? matcher([
        ...computer.names.map((n) => ({ text: n, exactCase: /^[A-Za-z]+$/.test(n) })),
        ...computer.serials.map((s) => ({ text: s }))
      ])
    : matcher([{ text: term }])
  const runs = computer?.runs ?? []
  const roles = noteRoles(input.notes, input.settings)
  const special = new Set(
    [roles.assets, roles.openLoops, roles.workLog, roles.changeLog, ...roles.tickets]
      .filter((n): n is IndexedNote => !!n)
      .map((n) => n.abs)
  )

  // scans
  const current = latestPerProfile(runs)
  const findings: ProfileFinding[] = current
    .flatMap((r) =>
      (r.health?.findings ?? []).map((f) => ({
        ...f,
        runId: r.runId,
        at: runTime(r),
        purpose: r.purpose
      }))
    )
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        b.at.localeCompare(a.at)
    )
  const scans: ProfileScan[] = runs.map((r) => ({
    runId: r.runId,
    at: runTime(r),
    purpose: r.purpose,
    profile: r.profile,
    version: r.version,
    status: r.status,
    score: r.health?.score,
    findings: r.health?.findings.length ?? 0,
    critical: r.health?.findings.filter((f) => f.severity === 'critical').length ?? 0,
    durationMs: r.durationMs,
    technician: r.technician
  }))

  const facts: ComputerFact[] = []
  const seenFact = new Set<string>()
  for (const r of runs)
    for (const [label, value] of Object.entries(r.health?.metrics ?? {})) {
      if (seenFact.has(label)) continue
      seenFact.add(label)
      facts.push({ label, value, at: runTime(r), purpose: r.purpose })
    }

  const groups = new Map<
    string,
    { f: ProfileFinding; runs: Set<string>; profiles: Set<string>; first: string; last: string }
  >()
  for (const r of runs)
    for (const f of r.health?.findings ?? []) {
      const shape = findingShape(f)
      const at = runTime(r)
      const g = groups.get(shape)
      if (!g)
        groups.set(shape, {
          f: { ...f, runId: r.runId, at, purpose: r.purpose },
          runs: new Set([r.runId]),
          profiles: new Set([r.profile]),
          first: at,
          last: at
        })
      else {
        g.runs.add(r.runId)
        g.profiles.add(r.profile)
        if (at < g.first) g.first = at
        if (at > g.last) {
          g.last = at
          g.f = { ...f, runId: r.runId, at, purpose: r.purpose }
        }
      }
    }
  const currentShapes = new Set(findings.map((f) => findingShape(f)))
  const recurring: RecurringFinding[] = [...groups.entries()]
    .map(([shape, g]) => ({
      shape,
      message: g.f.message,
      category: g.f.category,
      severity: g.f.severity,
      seen: g.runs.size,
      of: runs.filter((r) => g.profiles.has(r.profile)).length,
      firstAt: g.first,
      lastAt: g.last,
      current: currentShapes.has(shape)
    }))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.seen - a.seen ||
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    )

  // vault
  const inventory = computer
    ? computer.inventory
    : roles.assets
      ? inventoryRows(roles.assets).filter((r) => Object.values(r.cells).some((v) => match.test(v)))
      : []
  const tickets = roles.tickets
    .filter((n) => match.test(n.text))
    .map(ticketOf)
    .sort(
      (a, b) => Number(a.closed) - Number(b.closed) || (b.date ?? '').localeCompare(a.date ?? '')
    )
  const loops: ProfileLoop[] = roles.openLoops
    ? parseTasks(roles.openLoops.text, roles.openLoops.rel)
        .filter((t) => match.test(t.raw))
        .map((t) => ({
          file: t.file,
          line: t.line,
          text: t.text,
          done: t.done,
          priority: t.priority,
          section: t.section,
          generated: /\^loop-[0-9a-f]{8}/.test(t.raw)
        }))
        .sort((a, b) => Number(a.done) - Number(b.done))
    : []
  const tz = DEFAULT_CONTENT_OPTIONS.timeZone
  const worklogParts = roles.workLog
    ? parseDatedEntries(roles.workLog.text, roles.workLog.rel).flatMap((e) => {
        const parts = match.test(e.heading) ? [{ lines: e.lines }] : matchingParts(e.lines, match)
        return parts.map((p) => ({
          file: roles.workLog!.rel,
          date: e.date,
          heading: e.heading,
          title: ('heading' in p && p.heading) || e.heading,
          at: 'time' in p && p.time ? zonedToIso(e.date, p.time.padStart(5, '0'), tz) : e.date,
          lines: p.lines.slice(0, 15)
        }))
      })
    : []
  const worklog = worklogParts.map(({ file, date, heading, lines }) => ({
    file,
    date,
    heading,
    lines
  }))
  const changes = roles.changeLog
    ? tableRows(roles.changeLog)
        .filter((r) => Object.values(r.cells).some((v) => match.test(v)))
        .map(({ file, line, cells }) => ({ file, line, cells }))
    : []
  const mentions: VaultMention[] = []
  for (const n of input.notes) {
    if (special.has(n.abs)) continue
    const skip = dashboardLines(n)
    n.lines.forEach((text, i) => {
      if (mentions.length >= 80 || skip.has(i + 1) || !match.test(text)) return
      mentions.push({ file: n.rel, title: n.title, line: i + 1, text: text.trim().slice(0, 300) })
    })
  }

  // timeline
  const timeline: TimelineEvent[] = [
    ...scans.map(
      (s): TimelineEvent => ({
        at: s.at,
        kind: 'scan',
        title: `${purposeLabel(s.purpose)} scan · ${s.status}`,
        detail: `${s.findings} finding${s.findings === 1 ? '' : 's'}${s.critical ? `, ${s.critical} critical` : ''}`,
        runId: s.runId,
        score: s.score
      })
    ),
    ...tickets
      .filter((t) => t.date)
      .map(
        (t): TimelineEvent => ({
          at: t.date!,
          kind: 'ticket',
          title: t.title,
          detail: [t.status, t.priority].filter(Boolean).join(' · '),
          file: t.file
        })
      ),
    ...worklogParts.map(
      (w): TimelineEvent => ({ at: w.at, kind: 'worklog', title: w.title, file: w.file })
    ),
    ...changes.flatMap((c): TimelineEvent[] => {
      const first = Object.values(c.cells)[0] ?? ''
      // the Change Log's Timestamp column is MT
      const m = first.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/)
      if (!m?.[1]) return []
      const at = m[2] ? zonedToIso(m[1], m[2], tz) : m[1]
      return [
        {
          at,
          kind: 'change',
          title: c.cells['What changed'] || Object.values(c.cells).slice(1, 3).join(' · '),
          file: c.file,
          line: c.line
        }
      ]
    }),
    ...(computer?.device?.enrolledAt
      ? [
          {
            at: computer.device.enrolledAt,
            kind: 'enrolled' as const,
            title: `Enrolled as ${computer.device.displayName}`
          }
        ]
      : [])
  ].sort((a, b) => b.at.localeCompare(a.at))

  return {
    summary,
    terms: match.terms,
    facts,
    findings,
    recurring,
    series: metricSeries(runs),
    scans,
    inventory,
    tickets,
    loops,
    worklog,
    changes,
    mentions,
    timeline,
    tookMs: Math.round(performance.now() - started),
    vaultError: input.vaultError
  }
}

/** Lookup across computers plus a count of notes mentioning the query. */
export function lookup(
  query: string,
  summaries: ComputerSummary[],
  notes: IndexedNote[]
): Omit<LookupResult, 'tookMs'> {
  const re = termRegex(query)
  return {
    query,
    computers: rankComputers(query, summaries).slice(0, 20),
    vaultNotes: re ? notes.filter((n) => re.test(n.text)).length : 0
  }
}
