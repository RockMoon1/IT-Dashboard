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
  | 'not-verified'
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
  'not-verified': 'not verified',
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
    case 'not-verified':
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
 * either the run is still going, or the link was lost and the device has not reported back
 * ("unknown"). A result that cannot confirm the change (measuring afterwards failed or skipped an
 * item, or the agent was stopped mid-run) is "not-verified", never "changed".
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
  if (r.access === 'execute' || !(before?.items ?? []).length) {
    if (!ap) return 'not-verified' // the agent stopped before apply reported
    return applyOk ? 'done' : 'failed'
  }
  const after = r.after
  // a blocker afterwards is not a failure (Group Policy still holds a profile the run left
  // alone); what cannot show a change is an item that was not measured again
  if (!measured(after)) return 'not-verified'
  // only items measured both times can show a change
  const afterNames = new Set((after!.items ?? []).map((i) => i.item))
  if ((before!.items ?? []).some((i) => !afterNames.has(i.item))) return 'not-verified'
  const moved = changedItems(before, after).length
  if (after!.change === false) return moved || applyOk ? 'changed' : 'not-verified'
  if (after!.change === true) return moved ? 'partly-applied' : 'not-applied'
  return moved ? 'changed' : 'not-verified'
}

/**
 * Whether a run belongs in the vault's Change Log: a real run of a write action that changed
 * something, partly did, may have (outcome unknown or not verified); a task that left evidence of
 * a change (sfc repairs); and every custom command that started, since its effect is not measured.
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
    (x.status === 'changed' ||
      x.status === 'partly-applied' ||
      x.status === 'unknown' ||
      x.status === 'not-verified')
  )
}

/* ---------- results from agents: checked before anything reads them ---------- */

const MAX_TEXT = 2000
const MAX_LIST = 64

function text(v: unknown, max = MAX_TEXT): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined
}
/** A time, only when it reads as one: the vault cannot show a time that does not. */
function time(v: unknown): string | undefined {
  const t = text(v, 64)
  return t && Number.isFinite(Date.parse(t)) ? t : undefined
}
function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function texts(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v
    .filter((x): x is string => typeof x === 'string')
    .slice(0, MAX_LIST)
    .map((x) => x.slice(0, MAX_TEXT))
}
function pairs(v: unknown): ActionItem[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v
    .filter(
      (x): x is ActionItem =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as ActionItem).item === 'string' &&
        typeof (x as ActionItem).value === 'string'
    )
    .slice(0, MAX_LIST)
    .map((x) => ({ item: x.item.slice(0, MAX_TEXT), value: x.value.slice(0, MAX_TEXT) }))
}
function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v).slice(0, MAX_LIST))
    if (typeof x === 'string') out[k.slice(0, 64)] = x.slice(0, MAX_TEXT)
  return out
}
function measurement(v: unknown): Measurement | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const m = v as Record<string, unknown>
  const out: Measurement = {
    items: pairs(m['items']) ?? null,
    // a measurement that does not say how it ended counts as failed
    exitCode: int(m['exitCode']) ?? -1
  }
  const opt = {
    info: pairs(m['info']),
    change: bool(m['change']),
    plan: text(m['plan']),
    blockers: texts(m['blockers']),
    warnings: texts(m['warnings']),
    restore: stringMap(m['restore']),
    notes: texts(m['notes']),
    changes: texts(m['changes']),
    ignored: int(m['ignored']),
    timedOut: bool(m['timedOut'])
  }
  for (const [k, x] of Object.entries(opt)) if (x !== undefined) Object.assign(out, { [k]: x })
  return out
}

/**
 * The agent's result as the dashboard keeps it: only known fields, each of the right type and a
 * bounded size, so nothing a device sends can break the status logic, the action log or a note.
 * Null when it is not a result for this run.
 */
export function cleanResult(raw: unknown, runId: string): AgentResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r['runId'] !== runId) return null
  const kind = r['kind'] === 'exec' ? 'exec' : r['kind'] === 'action' ? 'action' : null
  if (!kind) return null
  const access = r['access'] === 'write' || r['access'] === 'execute' ? r['access'] : undefined
  const out: AgentResult = {
    runId,
    kind,
    dryRun: r['dryRun'] === true,
    applied: r['applied'] === true,
    startedAt: time(r['startedAt']) ?? ''
  }
  const opt = {
    action: text(r['action'], 100),
    version: int(r['version']),
    sha256: text(r['sha256'], 64),
    access,
    params: stringMap(r['params']),
    before: measurement(r['before']),
    apply: measurement(r['apply']),
    after: measurement(r['after']),
    skipped: text(r['skipped']),
    aborted: bool(r['aborted']),
    error: text(r['error']),
    exitCode: int(r['exitCode']),
    lines: int(r['lines']),
    appliedAt: time(r['appliedAt']),
    endedAt: time(r['endedAt'])
  }
  for (const [k, x] of Object.entries(opt)) if (x !== undefined) Object.assign(out, { [k]: x })
  return out
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
  /** The id the device sent, when it is not one this dashboard makes (never written to the vault). */
  deviceRunId?: string
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
