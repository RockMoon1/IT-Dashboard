/**
 * Phase 3 actions as the dashboard sees them (docs/PHASE3-DESIGN.md). The definitions are the
 * same files the agent embeds (actions/*.json); the result mirrors the agent's actions.Result.
 * The status of a run is worked out here, from the measured values, never from what a script
 * claims, so the page, the action log and the vault all say the same thing.
 */

export type ActionAccess = 'write' | 'execute'
export type ActionImpact = 'quiet' | 'slows' | 'interrupts'
export type ActionMode = 'preview' | 'apply'

export interface ActionParamDef {
  name: string
  label: string
  pattern: string
  maxLength: number
  required: boolean
  default: string
  choices: string[]
  examples: { ok: string[]; bad: string[] }
}

export interface ActionDef {
  schema: string
  name: string
  version: number
  os: 'windows' | 'macos' | 'linux'
  access: ActionAccess
  category: string
  title: string
  description: string
  impact: ActionImpact
  reversible: boolean
  undo: string
  manualUndo: string
  abortable: boolean
  concurrent: boolean
  fixes: string[]
  shell: 'powershell' | 'sh'
  timeoutSeconds: number
  settleSeconds: number
  params: ActionParamDef[]
  measure: string[]
  apply: string[]
  /** SHA-256 of the file as shipped; the agent refuses a request whose hash differs. */
  sha256: string
}

export interface ActionItem {
  item: string
  value: string
}

export interface Measurement {
  items: ActionItem[] | null
  info?: ActionItem[]
  change?: boolean
  plan?: string
  blockers?: string[]
  warnings?: string[]
  restore?: Record<string, string>
  notes?: string[]
  changes?: string[]
  ignored?: number
  exitCode: number
  timedOut?: boolean
}

/** The agent's account of one action or custom command. Times are the device's clock (UTC). */
export interface AgentResult {
  runId: string
  kind: 'action' | 'exec'
  action?: string
  version?: number
  sha256?: string
  access?: ActionAccess
  params?: Record<string, string>
  dryRun: boolean
  before?: Measurement
  applied: boolean
  apply?: Measurement
  after?: Measurement
  skipped?: string
  aborted?: boolean
  error?: string
  exitCode?: number
  lines?: number
  startedAt: string
  appliedAt?: string
  endedAt?: string
}

export type ActionStatus =
  | 'running'
  | 'would-change'
  | 'nothing-to-change'
  | 'blocked'
  | 'changed'
  | 'already-set'
  | 'not-applied'
  | 'partly-applied'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'refused'
  | 'unknown'
  | 'not-measured'

export const STATUS_LABEL: Record<ActionStatus, string> = {
  running: 'running',
  'would-change': 'would change',
  'nothing-to-change': 'nothing to change',
  blocked: 'blocked',
  changed: 'changed',
  'already-set': 'already set',
  'not-applied': 'not applied',
  'partly-applied': 'partly applied',
  done: 'done',
  failed: 'failed',
  aborted: 'stopped',
  refused: 'refused',
  unknown: 'outcome unknown',
  'not-measured': 'ran (effect not measured)'
}

export type StatusTone = 'ok' | 'warn' | 'bad' | 'info'

export function statusTone(s: ActionStatus): StatusTone {
  switch (s) {
    case 'changed':
    case 'done':
    case 'already-set':
    case 'nothing-to-change':
      return 'ok'
    case 'failed':
    case 'not-applied':
    case 'refused':
      return 'bad'
    case 'partly-applied':
    case 'blocked':
    case 'unknown':
    case 'aborted':
    case 'not-measured':
      return 'warn'
    default:
      return 'info'
  }
}

export interface ItemChange {
  item: string
  before: string
  after: string
}

/** Items whose measured value differs between two measurements, in the order first seen. */
export function changedItems(before?: Measurement, after?: Measurement): ItemChange[] {
  const b = new Map((before?.items ?? []).map((i) => [i.item, i.value]))
  const a = new Map((after?.items ?? []).map((i) => [i.item, i.value]))
  const names = [...new Set([...b.keys(), ...a.keys()])]
  return names
    .filter((n) => (b.get(n) ?? '') !== (a.get(n) ?? ''))
    .map((n) => ({
      item: n,
      before: b.get(n) ?? '(not measured)',
      after: a.get(n) ?? '(not measured)'
    }))
}

const measured = (m?: Measurement): boolean => !!m && m.exitCode === 0 && !m.timedOut

/**
 * The status of a run, from what the agent measured. `pending` means no result has arrived yet:
 * either the run is still going, or the link was lost and the device has not reported back.
 */
export function actionStatus(
  r: AgentResult | undefined,
  opts: { refused?: boolean; pending?: boolean; lost?: boolean } = {}
): ActionStatus {
  if (opts.refused) return 'refused'
  if (!r) return opts.lost ? 'unknown' : opts.pending ? 'running' : 'unknown'
  if (r.kind === 'exec') {
    if (r.aborted) return 'aborted'
    return r.exitCode === 0 ? 'not-measured' : 'failed'
  }
  const before = r.before
  if (r.dryRun) {
    if (!measured(before)) return r.aborted ? 'aborted' : 'failed'
    if (before!.blockers?.length) return 'blocked'
    if (before!.change === undefined) return 'failed'
    return before!.change ? 'would-change' : 'nothing-to-change'
  }
  if (!r.applied) {
    if (r.aborted) return 'aborted'
    if (!measured(before)) return 'failed'
    if (before!.blockers?.length) return 'blocked'
    if (before!.change === false) return 'already-set'
    return 'failed'
  }
  const ap = r.apply
  const applyOk = !!ap && ap.exitCode === 0 && !ap.timedOut
  // tasks, and write actions whose effect is evidence rather than a measured value (sfc)
  if (r.access === 'execute' || !(before?.items ?? []).length) return applyOk ? 'done' : 'failed'
  if (!measured(r.after)) return 'unknown'
  const moved = changedItems(before, r.after).length
  if (r.after!.change === false) return moved || applyOk ? 'changed' : 'unknown'
  if (r.after!.change === true) return moved ? 'partly-applied' : 'not-applied'
  return moved ? 'changed' : 'unknown'
}

/**
 * Whether a run belongs in the vault's Change Log: a real run of a write action that changed
 * something, partly did, or whose outcome is not known yet; a task that left evidence of a change
 * (sfc repairs); and every custom command that started, since its effect is not measured.
 */
export function belongsInChangeLog(x: {
  mode: ActionMode
  kind: 'action' | 'exec'
  access?: ActionAccess
  status: ActionStatus
  result?: AgentResult
}): boolean {
  if (x.mode !== 'apply' || x.status === 'refused') return false
  if (x.kind === 'exec') return x.result ? x.result.applied : x.status === 'unknown'
  if ((x.result?.apply?.changes ?? []).length) return true
  return (
    x.access === 'write' &&
    (x.status === 'changed' || x.status === 'partly-applied' || x.status === 'unknown')
  )
}

/** JavaScript check of one parameter, the same rules the agent applies (regexes are anchored). */
export function checkParam(p: ActionParamDef, value: string): string | null {
  if (!value) return p.required && !p.default ? `${p.label} is required` : null
  if (value.length > p.maxLength) return `${p.label}: at most ${p.maxLength} characters`
  if (/[\0\r\n]/.test(value) || value.startsWith('-'))
    return `${p.label}: no line breaks, and it may not start with -`
  if (p.choices.length && !p.choices.includes(value))
    return `${p.label}: one of ${p.choices.join(', ')}`
  let re: RegExp
  try {
    re = new RegExp(`^(?:${p.pattern})$`)
  } catch {
    return `${p.label}: the action's pattern does not compile here`
  }
  return re.test(value) ? null : `${p.label}: not a valid value`
}

/** Fills defaults so the request, the record and the agent all see every declared parameter. */
export function withDefaults(
  def: ActionDef,
  params: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of def.params) out[p.name] = params[p.name] || p.default
  return out
}

export interface ActionCheck {
  id: string
  title: string
  status: 'pending' | 'running' | 'ok' | 'failed' | 'timeout'
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
}

/** Where a run was opened from, when it was a Fix for a finding. */
export interface FixContext {
  scanRunId: string
  category: string
  message: string
  profile?: string
}

/** The dashboard's record of one action or custom command (also one line of its action log). */
export interface ActionRecord {
  runId: string
  kind: 'action' | 'exec'
  mode: ActionMode
  deviceId: string
  serial: string
  hostname: string
  displayName: string
  os: string
  link: 'cable' | 'lan' | 'unknown'
  action?: string
  version?: number
  sha256?: string
  title: string
  access?: ActionAccess
  impact?: ActionImpact
  params?: Record<string, string>
  shell?: string
  /** Custom commands: the hash and size are recorded; the text stays in the local log only. */
  scriptSha256?: string
  scriptLines?: number
  reason: string
  technician: string
  fix?: FixContext
  /** The preview this run was confirmed from. */
  previewOf?: string
  /** Dashboard clock, ISO UTC. */
  requestedAt: string
  startedAt?: string
  appliedAt?: string
  endedAt?: string
  status: ActionStatus
  errorCode?: string
  error?: string
  result?: AgentResult
  checks: ActionCheck[]
}

export interface ActionEvent {
  type: 'update' | 'output'
  record?: ActionRecord
  runId?: string
  checkId?: string
  stream?: 'stdout' | 'stderr'
  data?: string
}

/** One action of a device, as the computer page offers it. */
export interface ActionOffer {
  def: ActionDef
  /** Why it cannot run now (Settings, device policy, LAN, agent version); empty when it can. */
  blocked: string[]
  /** Run needs the computer name typed (interrupts while someone is signed in, or always). */
  previewRequired: boolean
}

export interface ActionRequest {
  deviceId: string
  action: string
  params: Record<string, string>
  reason: string
  fix?: FixContext
}

export interface ExecRequest {
  deviceId: string
  script: string
  timeoutSeconds: number
  reason: string
}
