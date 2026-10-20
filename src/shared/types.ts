/**
 * Types shared by the Electron main process, the preload bridge and the Vue renderer.
 * Keep this file free of runtime dependencies beyond the PURPOSES table.
 */

export type TargetOS = 'windows' | 'macos' | 'linux' | 'unknown'

export type Purpose =
  | 'system-diagnostics'
  | 'security-check'
  | 'email-setup'
  | 'hardware-issues'
  | 'slow-performance'
  | 'phishing-assessment'
  | 'other'

export interface PurposeInfo {
  id: Purpose
  label: string
  description: string
}

export const PURPOSES: readonly PurposeInfo[] = [
  {
    id: 'system-diagnostics',
    label: 'System Diagnostics',
    description: 'OS, hardware, storage, drivers, firmware and network configuration'
  },
  {
    id: 'security-check',
    label: 'Security Check',
    description: 'Antivirus, firewall, patching, encryption, accounts and sign-in activity'
  },
  {
    id: 'email-setup',
    label: 'Email Setup',
    description: 'Mail client installation, profiles, Microsoft 365 reachability and DNS'
  },
  {
    id: 'hardware-issues',
    label: 'Hardware Issues',
    description: 'Problem devices, disk health, battery, memory and hardware error events'
  },
  {
    id: 'slow-performance',
    label: 'Slow Performance',
    description: 'CPU, memory and disk pressure, top processes, startup items and services'
  },
  {
    id: 'phishing-assessment',
    label: 'Phishing Assessment',
    description:
      'Browser extensions, protection settings, proxy/DNS/hosts tampering and risky downloads'
  },
  {
    id: 'other',
    label: 'Other',
    description:
      'Runs the baseline system diagnostics profile (custom checks arrive in a later version)'
  }
]

export function purposeLabel(purpose: Purpose): string {
  return PURPOSES.find((p) => p.id === purpose)?.label ?? purpose
}

/* ---------- devices ---------- */

export type DeviceKind = 'enrolled' | 'link-unknown' | 'usb'

export interface DeviceView {
  id: string
  kind: DeviceKind
  displayName: string
  os: TargetOS
  present: boolean
  connected: boolean
  hostname?: string
  serial?: string
  address?: string
  lastSeen?: string
  enrolledAt?: string
  agentVersion?: string
  profiles?: Array<{ name: string; version: number }>
  /** USB peripherals */
  deviceClass?: string
  manufacturer?: string
  status?: string
  vendorId?: string
  productId?: string
  hint?: string
  /** link-unknown: an adapter is up but nothing enrolled has connected */
  adapterName?: string
  linkReason?: string
  lastScan?: { runId: string; purpose: Purpose; at: string; status: string; score?: HealthScore }
  suggestedPurpose?: Purpose
  suggestionReason?: string
}

export interface LinkAdapterView {
  name: string
  description: string
  status: string
  isLink: boolean
  linkReason?: string
  ipv4: string[]
  ipv6LinkLocal: string[]
  pnpDeviceId: string
  mac: string
}

export interface LinkStatus {
  listening: boolean
  port: number
  hostFingerprint: string
  hostId: string
  beaconInterfaces: string[]
  adapters: LinkAdapterView[]
  beaconAllAdapters: boolean
  secretStore: string
  agentBinary: string | null
  firewallRulePresent: boolean | null
  lastError?: string
}

export interface EnrollmentView {
  token: string
  expiresAt: string
  hostFingerprint: string
  label?: string
  commands: { windows: string; macos: string; linux: string }
}

/* ---------- scans ---------- */

export type Severity = 'critical' | 'warning' | 'info'
export type HealthScore = 'healthy' | 'attention' | 'critical'

export interface HealthFinding {
  id: string
  severity: Severity
  category: string
  message: string
  loop: boolean
  checkId?: string
}

export interface HealthReport {
  findings: HealthFinding[]
  metrics: Record<string, string>
  /** Raw numbers for trends (disk-free:<drive>, ram-used, update-age …). Absent on old runs. */
  values?: Record<string, number>
  score: HealthScore
}

export type CheckStatus = 'pending' | 'running' | 'ok' | 'failed' | 'timeout'
export type RunStatus = 'running' | 'ok' | 'failed' | 'aborted'

export interface CheckRun {
  id: string
  title: string
  category: string
  format: 'json' | 'text'
  optional: boolean
  status: CheckStatus
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
  startedAt?: string
}

export interface ScanRun {
  runId: string
  deviceId: string
  serial: string
  hostname: string
  os: TargetOS
  purpose: Purpose
  profile: string
  version: number
  title: string
  technician: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  error?: string
  checks: CheckRun[]
  health?: HealthReport
  durationMs: number
}

export type ScanEvent =
  | { type: 'run-start'; run: ScanRun }
  | { type: 'check-start'; runId: string; checkId: string }
  | {
      type: 'check-output'
      runId: string
      checkId: string
      stream: 'stdout' | 'stderr'
      data: string
    }
  | { type: 'check-end'; runId: string; check: CheckRun }
  | { type: 'run-end'; run: ScanRun }

export interface ResultNode {
  category: string
  checks: Array<{
    id: string
    title: string
    status: CheckStatus
    durationMs: number
    parsed: unknown
    text: string
    stderr: string
    truncated: boolean
  }>
}

export interface ScanHistoryEntry {
  ts: string
  runId: string
  deviceId: string
  serial: string
  hostname: string
  os: string
  purpose: string
  profile: string
  version: number
  technician: string
  durationMs: number
  status: 'ok' | 'failed' | 'aborted'
  exitStatus: string
  checks: number
  failedChecks: number
  findings: number
  critical: number
}

export interface ProfileSummary {
  name: string
  version: number
  os: string
  purpose: string
  title: string
  checks: number
  categories: string[]
}

/* ---------- vault ---------- */

export interface NotePreview {
  notePath: string
  exists: boolean
  keys: string[]
  markersCreated: string[]
  changed: boolean
  diff: string
  added: number
  removed: number
  error?: string
  backupExists: boolean
}

export interface VaultPreview {
  runId: string | null
  generatedAt: string
  live: boolean
  notes: NotePreview[]
}

export interface VaultApplyResult {
  notePath: string
  written: boolean
  backupPath?: string
  conflictCopies: string[]
  error?: string
}

export interface VaultNoteStatus {
  role: 'hub' | 'workLog' | 'openLoops' | 'assets'
  name: string
  path: string
  exists: boolean
  markers: string[]
  backupExists: boolean
}

export interface VaultStatus {
  vaultPath: string
  exists: boolean
  live: boolean
  schemaApproved: boolean
  notes: VaultNoteStatus[]
  conflicts: string[]
  backupsDir: string
  problems: string[]
}

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

export interface OpenLoopsView {
  source: string
  tasks: VaultTask[]
  overdue: number
  dueSoon: number
  candidates: Array<{ runId: string; hostname: string; finding: HealthFinding; at: string }>
  error?: string
}

export interface LogEntry {
  file: string
  date: string
  heading: string
  lines: string[]
}

export interface WorkLogView {
  source: string
  entries: LogEntry[]
  error?: string
}

export interface SearchHit {
  file: string
  line: number
  text: string
  before: string[]
  after: string[]
}

/* ---------- computer lookup ---------- */

/** One computer as the dashboard knows it from enrollment, scans and Asset Inventory. */
export interface ComputerSummary {
  /** Stable id: sn:<serial> or host:<name> (lowercase). */
  key: string
  name: string
  /** Other names seen for it (renames, enrollment label). */
  aliases: string[]
  serial?: string
  model?: string
  os?: string
  location?: string
  room?: string
  ip?: string
  mac?: string
  deviceId?: string
  connected: boolean
  lastSeen?: string
  health?: HealthScore
  lastScanAt?: string
  scans: number
  sources: Array<'enrolled' | 'scans' | 'inventory'>
  /** Why it matched a lookup, e.g. "serial 5CG1234". */
  match?: string
}

export interface LookupResult {
  query: string
  computers: ComputerSummary[]
  /** Notes in the vault that mention the query as a whole word. */
  vaultNotes: number
  tookMs: number
}

export type LookupTarget = { key: string } | { deviceId: string } | { term: string }

export interface MetricPoint {
  at: string
  value: number
  runId: string
}

/** How a value compares with its threshold when health.ts raises the finding. */
export type SeriesAlert = 'below' | 'above' | 'at-or-above'

export interface MetricSeries {
  key: string
  label: string
  unit: string
  threshold?: number
  /** The exact comparison health.ts uses for this value (disk `<`, update age `>`, RAM `>=`). */
  alert: SeriesAlert
  /** Which direction is healthy, for colouring the latest value. */
  better: 'higher' | 'lower'
  points: MetricPoint[]
}

/** True when a value is past its threshold by the same rule the health check applies. */
export function seriesBreach(
  s: Pick<MetricSeries, 'threshold' | 'alert'>,
  value: number | undefined
): boolean {
  const t = s.threshold
  if (t == null || value == null) return false
  return s.alert === 'below' ? value < t : s.alert === 'above' ? value > t : value >= t
}

export interface ComputerFact {
  label: string
  value: string
  at: string
  purpose: Purpose
}

export interface ProfileFinding extends HealthFinding {
  runId: string
  at: string
  purpose: Purpose
}

export interface RecurringFinding {
  shape: string
  message: string
  category: string
  severity: Severity
  /** Scans that reported it, out of the scans of the purposes that check it. */
  seen: number
  of: number
  firstAt: string
  lastAt: string
  current: boolean
}

export interface ProfileScan {
  runId: string
  at: string
  purpose: Purpose
  profile: string
  version: number
  status: RunStatus
  score?: HealthScore
  findings: number
  critical: number
  durationMs: number
  technician: string
}

export interface VaultTicket {
  file: string
  id?: string
  title: string
  date?: string
  status?: string
  priority?: string
  category?: string
  location?: string
  closed: boolean
  openTasks: number
  doneTasks: number
}

export interface VaultRow {
  file: string
  line: number
  cells: Record<string, string>
}

export interface VaultMention {
  file: string
  title: string
  line: number
  text: string
}

export interface ProfileLoop {
  file: string
  line: number
  text: string
  done: boolean
  priority?: string
  section?: string
  /** Written by the dashboard (carries a ^loop- id). */
  generated: boolean
}

export interface TimelineEvent {
  at: string
  kind: 'scan' | 'ticket' | 'worklog' | 'change' | 'enrolled'
  title: string
  detail?: string
  runId?: string
  file?: string
  line?: number
  score?: HealthScore
}

export interface ComputerProfile {
  summary: ComputerSummary
  /** What the vault was searched for (names and serials, or the typed term). */
  terms: string[]
  facts: ComputerFact[]
  findings: ProfileFinding[]
  recurring: RecurringFinding[]
  series: MetricSeries[]
  scans: ProfileScan[]
  inventory: VaultRow[]
  tickets: VaultTicket[]
  loops: ProfileLoop[]
  worklog: Array<{ file: string; date: string; heading: string; lines: string[]; line?: number }>
  changes: VaultRow[]
  mentions: VaultMention[]
  timeline: TimelineEvent[]
  tookMs: number
  vaultError?: string
}

/* ---------- note viewer ---------- */

export interface NoteLinkTarget {
  file: string
  title: string
}

/** A note as the dashboard shows it: parsed, with its links resolved and who links to it. */
export interface NoteView {
  file: string
  title: string
  folder: string
  mtimeMs: number
  frontmatter: Array<[string, string]>
  blocks: import('./markdown.ts').Block[]
  /** Each [[target]] in the note and the note it opens (null: no such note in the vault). */
  links: Record<string, NoteLinkTarget | null>
  backlinks: Array<{ file: string; title: string; line: number; text: string }>
}

/* ---------- settings ---------- */

export interface Settings {
  vaultPath: string
  /** Empty means the hub is not written. */
  hubNote: string
  workLogNote: string
  openLoopsNote: string
  /** Path inside the vault, e.g. Assets/Asset Inventory.md */
  assetNote: string
  /** Live writes stay off until the vault schema is approved. */
  vaultLive: boolean
  schemaApproved: boolean
  dueStyle: 'tasks-emoji' | 'dataview' | 'plain' | 'none'
  technician: string
  beaconAllAdapters: boolean
  usbPollMs: number
  adapterPollMs: number
  linkPort: number
  /** Bumped when stored settings need a one-time migration (see settings.ts). */
  settingsVersion: number
  /* Access and control (Phase 3). Full access by default; each switch narrows it. */
  /** Read notes for lookups and the note viewer. */
  vaultRead: boolean
  /** Write the dashboard's sections into the vault after every scan or action. */
  vaultAutoWrite: boolean
  /** Run scan profiles (read). */
  deviceScan: boolean
  /** Run actions that change a setting on a device (write). */
  deviceWrite: boolean
  /** Run tasks on a device (execute). */
  deviceExecute: boolean
  /** Run commands the technician types. */
  customCommands: boolean
  /** Ask for confirmation before every write, task or command. */
  confirmChanges: boolean
  /** Offer a dry run (measure, change nothing) before a write. */
  previewFirst: boolean
  /** Actions switched off one by one, by name. */
  disabledActions: string[]
}

export interface AppInfo {
  version: string
  platform: string
  powerShell: string
  settingsFile: string
  appDataDir: string
  agentBinary: string | null
  profilesDir: string
}
