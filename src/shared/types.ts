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
  role: 'hub' | 'workLog' | 'openLoops'
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
  priority?: string
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

/* ---------- settings ---------- */

export interface Settings {
  vaultPath: string
  hubNote: string
  workLogNote: string
  openLoopsNote: string
  /** Live writes stay off until the vault schema is approved. */
  vaultLive: boolean
  schemaApproved: boolean
  dueStyle: 'tasks-emoji' | 'dataview' | 'plain' | 'none'
  technician: string
  beaconAllAdapters: boolean
  usbPollMs: number
  adapterPollMs: number
  linkPort: number
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
