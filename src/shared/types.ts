/**
 * Types shared by the Electron main process, the preload bridge and the Vue renderer.
 * Keep this file free of runtime dependencies: it is imported from every layer.
 */

export type TargetOS = 'windows' | 'macos' | 'linux' | 'unknown'
export type Protocol = 'winrm' | 'ssh' | 'local'
export type ShellKind = 'powershell' | 'sh'
export type OutputFormat = 'json' | 'text'

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
    description: 'OS, CPU, RAM, disk usage, drivers, BIOS and thermal zones'
  },
  {
    id: 'security-check',
    label: 'Security Check',
    description: 'Antivirus, firewall, patch level, BitLocker, UAC/SmartScreen, local admins'
  },
  {
    id: 'email-setup',
    label: 'Email Setup',
    description:
      'Outlook profiles, Microsoft 365 install, mail endpoint connectivity, MX/autodiscover DNS'
  },
  {
    id: 'hardware-issues',
    label: 'Hardware Issues',
    description:
      'Problem devices, disk health and SMART, battery wear, memory modules, system errors'
  },
  {
    id: 'slow-performance',
    label: 'Slow Performance',
    description: 'CPU, memory and disk pressure, top processes, startup items, third-party services'
  },
  {
    id: 'phishing-assessment',
    label: 'Phishing Assessment',
    description:
      'Browser extensions, SmartScreen/PUA settings, proxy/DNS/hosts tampering, risky downloads'
  },
  {
    id: 'other',
    label: 'Other',
    description: 'Run a custom command set supplied by the technician'
  }
]

export function purposeLabel(purpose: Purpose): string {
  return PURPOSES.find((p) => p.id === purpose)?.label ?? purpose
}

export type DeviceKind = 'usb' | 'network' | 'manual' | 'local'

export interface Device {
  id: string
  kind: DeviceKind
  name: string
  present: boolean
  firstSeen: string
  lastSeen: string
  os: TargetOS
  osHint?: string
  /** Protocols that can plausibly reach this device. Empty for pure USB peripherals. */
  protocols: Protocol[]
  host?: string
  mac?: string
  instanceId?: string
  vendorId?: string
  productId?: string
  serial?: string
  deviceClass?: string
  manufacturer?: string
  status?: string
}

export interface Credentials {
  username?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  port?: number
  useSsl?: boolean
  skipCertCheck?: boolean
}

export interface SessionRequest {
  deviceId: string
  purpose: Purpose
  protocol: Protocol
  host?: string
  targetOs?: TargetOS
  credentials?: Credentials
  /** One command per entry; used only when purpose === 'other'. */
  customCommands?: string[]
  notes?: string
  /** The technician confirms they are authorised to run commands on the target. */
  authorizationConfirmed: boolean
}

export interface CommandSpec {
  id: string
  title: string
  shell: ShellKind
  script: string
  format: OutputFormat
  timeoutMs?: number
  /** Optional commands may fail without marking the session as failed. */
  optional?: boolean
  description?: string
}

export interface CommandResult {
  id: string
  title: string
  format: OutputFormat
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  optional: boolean
}

export interface OutputEvent {
  sessionId: string
  commandId?: string
  stream: 'stdout' | 'stderr' | 'status'
  text: string
  at: string
}

export interface SessionSummary {
  sessionId: string
  deviceId: string
  deviceName: string
  purpose: Purpose
  protocol: Protocol
  host?: string
  targetOs: TargetOS
  startedAt: string
  finishedAt: string
  results: CommandResult[]
  findings: string[]
  metrics: Record<string, string>
  ok: boolean
  error?: string
  notes?: string
}

export interface ProbeResult {
  host: string
  reachable: boolean
  openPorts: number[]
  sshBanner?: string
  os: TargetOS
  osHint: string
  suggestedProtocol: Protocol | null
  durationMs: number
}

export interface Settings {
  vaultPath: string
  hubNote: string
  workLogNote: string
  hubSection: string
  autoLog: boolean
  workLogNewestFirst: boolean
  usbPollMs: number
  networkDiscovery: boolean
  networkRefreshMs: number
  strictHostKeys: boolean
  knownHosts: Record<string, string>
  defaultUsername: string
}

export interface VaultWriteResult {
  hubPath: string
  workLogPath: string
  hubEntryLines: number
  workLogEntryLines: number
}

export interface VaultCheckResult {
  vaultPath: string
  vaultExists: boolean
  hubPath: string
  hubExists: boolean
  hubSectionExists: boolean | null
  workLogPath: string
  workLogExists: boolean
  problems: string[]
}

export interface SessionDoneEvent {
  summary: SessionSummary
  vault?: VaultWriteResult
  vaultError?: string
}
