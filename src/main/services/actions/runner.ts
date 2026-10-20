import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  actionStatus,
  checkParam,
  cleanResult,
  withDefaults,
  type ActionCheck,
  type ActionDef,
  type ActionEvent,
  type ActionOffer,
  type ActionRecord,
  type ActionRequest,
  type ExecRequest
} from '../../../shared/actions.ts'
import type { DeviceCapabilities, Settings } from '../../../shared/types.ts'
import type { EnrolledDevice } from '../link/devices.ts'
import type { LinkMessage } from '../link/ndjson.ts'
import type { DeviceSlots } from '../link/slots.ts'
import type { ActionCatalog } from './catalog.ts'
import type { ActionLog } from './log.ts'

/**
 * Sends named actions and custom commands to agents and keeps the record of each run. Every gate
 * is checked here in the main process (Settings, the device's own policy, the cable, the agent's
 * copy of the action, the preview a run was confirmed from), not only in the page.
 */

export const PREVIEW_VALID_MS = 10 * 60_000
export const ACK_TIMEOUT_MS = 15_000
export const RECONNECT_GRACE_MS = 20_000
const MAX_OUTPUT = 1 << 20
const MAX_SCRIPT = 64 * 1024
/** The agent's limits, in UTF-8 bytes as it counts them. */
const MAX_REASON = 500
const MAX_TECHNICIAN = 100

export interface ActionRunnerDeps {
  catalog: ActionCatalog
  log: ActionLog
  slots: DeviceSlots
  send: (deviceId: string, message: LinkMessage) => boolean
  capabilities: (deviceId: string) => DeviceCapabilities | undefined
  settings: () => Settings
  /** The enrolled device, for a result this dashboard has no request on record for. */
  device?: (deviceId: string) => EnrolledDevice | undefined
  now?: () => Date
  /** Called whenever a real run reaches a state the vault should show. */
  onRecorded?: (record: ActionRecord) => void
  ackTimeoutMs?: number
  reconnectGraceMs?: number
}

export interface RunConfirm {
  /** The preview this run was confirmed from (required while "preview first" is on). */
  previewOf?: string
  /** Typed computer name, required for an interrupting action while someone uses the computer. */
  confirmName?: string
}

function newRunId(prefix: 'a' | 'p' | 'x', now: Date): string {
  return `${prefix}_${now.getTime().toString(36)}_${randomBytes(3).toString('hex')}`
}

/** The agent refuses a reason over 500 or a name over 100 UTF-8 bytes; say so before sending. */
function checkWho(reason: string, technician: string): void {
  if (Buffer.byteLength(reason, 'utf8') > MAX_REASON)
    throw new Error(
      `the reason is too long (at most ${MAX_REASON} bytes; accented letters and symbols count 2 to 4)`
    )
  if (Buffer.byteLength(technician, 'utf8') > MAX_TECHNICIAN)
    throw new Error(`the technician name in Settings is too long (at most ${MAX_TECHNICIAN} bytes)`)
}

/** Decisions the agent will make, mirrored so the page can say why before anyone clicks. */
export function policyBlocks(
  caps: DeviceCapabilities | undefined,
  def: Pick<ActionDef, 'name' | 'access' | 'impact'> | 'exec'
): string[] {
  if (!caps) return ['the device is not connected']
  if (caps.protocol < 2 || !caps.policy)
    return ['the agent on this device is from before Phase 3 (read only); update it']
  const p = caps.policy
  const out: string[] = []
  if (p.error) out.push(`the device is read only: ${p.error}`)
  if (caps.link !== 'cable' && !p.lan)
    out.push('changes run only over the USB cable; this device is connected over the network')
  if (def === 'exec') {
    if (!p.custom || !p.write || !p.execute)
      out.push(
        "the device's policy refuses custom commands (on the device: arh-agent policy --allow custom)"
      )
    return out
  }
  if (p.deny.some((d) => d.toLowerCase() === def.name.toLowerCase()))
    out.push(`the device's policy refuses ${def.name}`)
  if (def.access === 'write' && !p.write)
    out.push("the device's policy refuses changes to settings (write)")
  if (def.access === 'execute' && !p.execute) out.push("the device's policy refuses tasks (execute)")
  if (def.impact === 'interrupts' && !p.interrupts)
    out.push("the device's policy refuses actions that interrupt work (clinical role)")
  return out
}

export class ActionRunner extends EventEmitter {
  private deps: ActionRunnerDeps
  private live = new Map<string, ActionRecord>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private usedPreviews = new Set<string>()
  private pending: Promise<void>[] = []

  constructor(deps: ActionRunnerDeps) {
    super()
    this.deps = deps
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))()
  }

  onEvent(cb: (e: ActionEvent) => void): () => void {
    this.on('event', cb)
    return () => this.off('event', cb)
  }

  private emitUpdate(r: ActionRecord): void {
    this.emit('event', { type: 'update', record: r } satisfies ActionEvent)
  }

  private track(p: Promise<void>): void {
    const q = p.catch(() => undefined)
    this.pending.push(q)
    void q.finally(() => (this.pending = this.pending.filter((x) => x !== q)))
  }

  /** Resolves when every log write issued so far is on disk. */
  async flush(): Promise<void> {
    await Promise.all(this.pending)
  }

  get(runId: string): ActionRecord | undefined {
    return this.live.get(runId) ?? this.deps.log.get(runId)
  }

  list(limit = 200): ActionRecord[] {
    const merged = new Map<string, ActionRecord>()
    for (const r of this.deps.log.list(limit)) merged.set(r.runId, r)
    for (const r of this.live.values()) merged.set(r.runId, r)
    return [...merged.values()]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, limit)
  }

  /* ---------- gates ---------- */

  /** Why a named action cannot run on this device now; empty when it can. */
  blockers(device: EnrolledDevice, def: ActionDef, mode: 'preview' | 'apply'): string[] {
    const s = this.deps.settings()
    const caps = this.deps.capabilities(device.id)
    const out: string[] = []
    if (def.os !== device.os) out.push(`${def.name} is for ${def.os}; this device is ${device.os}`)
    if (!s.deviceScan) out.push('Settings: reading devices is off')
    if (mode === 'apply') {
      if (def.access === 'write' && !s.deviceWrite) out.push('Settings: changing settings is off')
      if (def.access === 'execute' && !s.deviceExecute) out.push('Settings: running tasks is off')
      if (s.disabledActions.includes(def.name)) out.push('Settings: this action is switched off')
    }
    if (!caps) {
      out.push('the device is not connected')
      return out
    }
    const onAgent = caps.actions.find((a) => a.name === def.name)
    if (caps.protocol >= 2 && !onAgent) out.push("the device's agent does not carry this action")
    else if (onAgent && (onAgent.version !== def.version || onAgent.sha256 !== def.sha256))
      out.push(
        `the device's agent has a different copy of this action (v${onAgent.version}); update the agent or the dashboard`
      )
    if (mode === 'apply') {
      out.push(...policyBlocks(caps, def))
      if (caps.pendingRestartUntil && !def.concurrent)
        out.push(`a restart is scheduled (${caps.pendingRestartUntil}); cancel it or wait for it`)
    } else if (caps.protocol < 2) out.push(...policyBlocks(caps, def))
    return [...new Set(out)]
  }

  /** The actions a device's page offers, with what stands in the way of each. */
  offers(device: EnrolledDevice): ActionOffer[] {
    return this.deps.catalog
      .forOs(device.os)
      .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
      .map((def) => ({
        def,
        blocked: this.blockers(device, def, 'apply'),
        previewRequired: this.deps.settings().previewFirst
      }))
  }

  private checkRequest(def: ActionDef, req: ActionRequest): Record<string, string> {
    const known = new Set(def.params.map((p) => p.name))
    for (const k of Object.keys(req.params ?? {}))
      if (!known.has(k)) throw new Error(`${def.title} has no parameter ${k}`)
    const params = withDefaults(def, req.params ?? {})
    for (const p of def.params) {
      const err = checkParam(p, params[p.name] ?? '')
      if (err) throw new Error(err)
    }
    return params
  }

  private base(
    device: EnrolledDevice,
    kind: 'action' | 'exec',
    mode: 'preview' | 'apply',
    runId: string,
    title: string,
    reason: string
  ): ActionRecord {
    const caps = this.deps.capabilities(device.id)
    return {
      runId,
      kind,
      mode,
      deviceId: device.id,
      serial: device.serial,
      hostname: device.hostname,
      displayName: device.displayName,
      os: device.os,
      link: caps?.link ?? 'unknown',
      title,
      reason: reason.trim(),
      technician: this.deps.settings().technician.trim(),
      requestedAt: this.now().toISOString(),
      status: 'running',
      checks: []
    }
  }

  /* ---------- requests ---------- */

  /** Measures only: nothing on the device changes, so no confirmation is needed. */
  preview(device: EnrolledDevice, req: ActionRequest): ActionRecord {
    const def = this.deps.catalog.get(req.action)
    if (!def) throw new Error(`unknown action ${req.action}`)
    const blocked = this.blockers(device, def, 'preview')
    if (blocked.length) throw new Error(blocked.join('; '))
    const params = this.checkRequest(def, req)
    const r = this.base(device, 'action', 'preview', newRunId('p', this.now()), def.title, req.reason ?? '')
    checkWho(r.reason, r.technician)
    Object.assign(r, {
      action: def.name,
      version: def.version,
      sha256: def.sha256,
      access: def.access,
      impact: def.impact,
      params,
      fix: req.fix
    })
    return this.dispatch(device, r, def.concurrent, def.title, {
      type: 'action',
      runId: r.runId,
      action: def.name,
      version: def.version,
      sha256: def.sha256,
      params,
      mode: 'preview',
      technician: r.technician,
      reason: r.reason
    })
  }

  /** A real run. Everything the page checked is checked again here. */
  run(device: EnrolledDevice, req: ActionRequest, confirm: RunConfirm = {}): ActionRecord {
    const s = this.deps.settings()
    const def = this.deps.catalog.get(req.action)
    if (!def) throw new Error(`unknown action ${req.action}`)
    const blocked = this.blockers(device, def, 'apply')
    if (blocked.length) throw new Error(blocked.join('; '))
    const params = this.checkRequest(def, req)
    const reason = (req.reason ?? '').trim()
    if (!reason) throw new Error('say why: the reason goes to the Change Log')
    if (!s.technician.trim())
      throw new Error('set your name in Settings first: every change is recorded with who made it')
    checkWho(reason, s.technician.trim())
    const preview = confirm.previewOf ? this.get(confirm.previewOf) : undefined
    if (s.previewFirst || def.impact === 'interrupts') {
      if (!preview) throw new Error('preview the action first')
      const same =
        preview.mode === 'preview' &&
        preview.deviceId === device.id &&
        preview.action === def.name &&
        preview.sha256 === def.sha256 &&
        JSON.stringify(preview.params) === JSON.stringify(params)
      if (!same) throw new Error('the preview was for a different action, device or values; preview again')
      if (this.usedPreviews.has(preview.runId)) throw new Error('that preview was already used; preview again')
      const age = this.now().getTime() - Date.parse(preview.endedAt ?? preview.requestedAt)
      if (!preview.endedAt || age > PREVIEW_VALID_MS)
        throw new Error('the preview is more than 10 minutes old; preview again')
      if (preview.status !== 'would-change')
        throw new Error(`the preview said "${preview.status}", so there is nothing to run`)
      const warnings = preview.result?.before?.warnings ?? []
      if (def.impact === 'interrupts' && warnings.length) {
        const typed = (confirm.confirmName ?? '').trim().toLowerCase()
        if (typed !== device.hostname.trim().toLowerCase())
          throw new Error(`someone is using ${device.hostname}: type its name to confirm`)
      }
    }
    const r = this.base(device, 'action', 'apply', newRunId('a', this.now()), def.title, reason)
    Object.assign(r, {
      action: def.name,
      version: def.version,
      sha256: def.sha256,
      access: def.access,
      impact: def.impact,
      params,
      fix: req.fix ?? preview?.fix,
      previewOf: preview?.runId
    })
    const sent = this.dispatch(device, r, def.concurrent, def.title, {
      type: 'action',
      runId: r.runId,
      action: def.name,
      version: def.version,
      sha256: def.sha256,
      params,
      mode: 'apply',
      technician: r.technician,
      reason: r.reason
    })
    // used up only once the run went out: a busy device or a pulled cable leaves it usable
    if (preview) this.usedPreviews.add(preview.runId)
    return sent
  }

  /** A custom command: nothing about its effect is measured. */
  exec(device: EnrolledDevice, req: ExecRequest): ActionRecord {
    const s = this.deps.settings()
    const caps = this.deps.capabilities(device.id)
    const blocked = [
      ...(s.customCommands ? [] : ['Settings: custom commands are off']),
      ...policyBlocks(caps, 'exec')
    ]
    if (caps?.pendingRestartUntil) blocked.push('a restart is scheduled; cancel it or wait for it')
    if (blocked.length) throw new Error(blocked.join('; '))
    const script = req.script ?? ''
    if (!script.trim()) throw new Error('the command is empty')
    if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT) throw new Error('the command is over 64 KiB')
    const timeout = Math.round(req.timeoutSeconds || 300)
    if (timeout < 1 || timeout > 3600) throw new Error('the time limit must be 1 to 3600 seconds')
    const reason = (req.reason ?? '').trim()
    if (!reason) throw new Error('say why: the reason goes to the Change Log')
    if (!s.technician.trim())
      throw new Error('set your name in Settings first: every change is recorded with who made it')
    checkWho(reason, s.technician.trim())
    const shell = device.os === 'windows' ? 'powershell' : 'sh'
    const r = this.base(device, 'exec', 'apply', newRunId('x', this.now()), 'Custom command', reason)
    r.shell = shell
    r.scriptSha256 = createHash('sha256').update(script, 'utf8').digest('hex')
    r.scriptLines = script.replace(/\n+$/, '').split('\n').length
    return this.dispatch(
      device,
      r,
      false,
      'Custom command',
      {
        type: 'exec',
        runId: r.runId,
        shell,
        script,
        timeoutSeconds: timeout,
        technician: r.technician,
        reason
      },
      script
    )
  }

  private dispatch(
    device: EnrolledDevice,
    r: ActionRecord,
    concurrent: boolean,
    title: string,
    message: LinkMessage,
    script?: string
  ): ActionRecord {
    if (!concurrent)
      this.deps.slots.take(
        device.id,
        { runId: r.runId, kind: r.kind, title, startedAt: r.requestedAt },
        device.displayName
      )
    this.live.set(r.runId, r)
    if (!this.deps.send(device.id, message)) {
      this.live.delete(r.runId)
      this.deps.slots.release(device.id, r.runId)
      throw new Error(`${device.displayName} disconnected before the request could be sent`)
    }
    this.track(this.deps.log.append('request', r, { script, now: this.now() }))
    this.timers.set(
      r.runId,
      setTimeout(() => this.noAck(r.runId), this.deps.ackTimeoutMs ?? ACK_TIMEOUT_MS)
    )
    this.emitUpdate(r)
    return r
  }

  private noAck(runId: string): void {
    const r = this.live.get(runId)
    if (!r || r.startedAt || r.endedAt) return
    r.error = 'the agent did not answer within 15 seconds'
    if (r.mode === 'preview') this.end(r, 'failed')
    else {
      // it may have arrived; never assume it did not run
      r.status = 'unknown'
      this.save('update', r)
    }
  }

  /** Stops a run where that is safe; the agent decides and says so. */
  abort(runId: string): boolean {
    const r = this.live.get(runId)
    if (!r || r.endedAt) return false
    return this.deps.send(r.deviceId, { type: 'abort', runId })
  }

  /* ---------- messages from the agent ---------- */

  handleMessage(deviceId: string, m: LinkMessage): void {
    const runId = typeof m['runId'] === 'string' ? m['runId'] : ''
    if (m.type === 'result') {
      this.lateResult(deviceId, runId, m['result'])
      return
    }
    const r = this.live.get(runId)
    if (!r || r.deviceId !== deviceId) {
      // the end of a run this dashboard is no longer following (it was restarted meanwhile)
      if (m.type === 'run-end' && m['result'] && typeof m['result'] === 'object')
        this.lateResult(deviceId, runId, m['result'])
      return
    }
    const checkId = typeof m['checkId'] === 'string' ? m['checkId'] : ''
    let check = r.checks.find((c) => c.id === checkId)
    switch (m.type) {
      case 'run-start':
        r.startedAt = this.now().toISOString()
        if (m['link'] === 'cable' || m['link'] === 'lan') r.link = m['link']
        if (r.status === 'unknown') r.status = 'running'
        r.error = undefined // a "no answer" from before the agent started no longer applies
        r.errorCode = undefined
        this.clearTimer(runId)
        this.emitUpdate(r)
        return
      case 'check-start':
        if (!check) {
          check = {
            id: checkId,
            title: typeof m['title'] === 'string' ? m['title'] : checkId,
            status: 'running',
            exitCode: null,
            stdout: '',
            stderr: '',
            durationMs: 0,
            timedOut: false,
            truncated: false
          } satisfies ActionCheck
          r.checks.push(check)
        }
        check.status = 'running'
        if (checkId === 'apply' || r.kind === 'exec') r.appliedAt ??= this.now().toISOString()
        if (checkId === 'apply') this.save('update', r)
        else this.emitUpdate(r)
        return
      case 'check-output':
        if (check && typeof m['data'] === 'string') {
          const stream = m['stream'] === 'stderr' ? 'stderr' : 'stdout'
          if (check[stream].length < MAX_OUTPUT) check[stream] += m['data']
          this.emit('event', {
            type: 'output',
            runId,
            checkId,
            stream,
            data: m['data']
          } satisfies ActionEvent)
        }
        return
      case 'check-end':
        if (check) {
          check.exitCode = typeof m['exitCode'] === 'number' ? m['exitCode'] : null
          check.durationMs = typeof m['durationMs'] === 'number' ? m['durationMs'] : 0
          check.timedOut = m['timedOut'] === true
          check.truncated = m['truncated'] === true
          check.status = check.timedOut ? 'timeout' : check.exitCode === 0 ? 'ok' : 'failed'
          this.emitUpdate(r)
        }
        return
      case 'abort-refused':
        r.error = typeof m['error'] === 'string' ? m['error'] : 'the agent refused to stop'
        this.emitUpdate(r)
        return
      case 'run-end': {
        this.clearTimer(runId)
        if (m['result'] && typeof m['result'] === 'object') {
          this.settle(r, m['result'], typeof m['error'] === 'string' ? m['error'] : '')
          // the agent drops a result once acknowledged: only after it is on disk here
          void this.end(r, r.status).then(
            () => this.deps.send(deviceId, { type: 'ack', runId }),
            () => undefined // not written: the agent sends it again on the next connection
          )
        } else {
          r.errorCode = typeof m['errorCode'] === 'string' ? m['errorCode'] : undefined
          r.error = typeof m['error'] === 'string' ? m['error'] : 'refused by the agent'
          this.end(r, r.errorCode === 'busy' || r.errorCode ? 'refused' : 'failed')
        }
        return
      }
    }
  }

  private clearTimer(runId: string): void {
    const t = this.timers.get(runId)
    if (t) clearTimeout(t)
    this.timers.delete(runId)
  }

  /** Takes the agent's result into the record: checked first, then the status from it. */
  private settle(r: ActionRecord, raw: unknown, error: string, wireId = r.runId): void {
    const result = cleanResult(raw, wireId)
    if (result) result.runId = r.runId
    r.error = error || undefined // an earlier "link lost" or "no answer" is over now
    r.errorCode = undefined
    if (result) {
      r.result = result
      r.status = actionStatus(result)
      if (!error && result.error) r.error = result.error
    } else {
      r.status = r.mode === 'apply' ? 'not-verified' : 'failed'
      r.error = 'the device sent a result this dashboard could not read; check the device'
    }
  }

  /** Ends the run; resolves once its result line is on disk (rejects if it could not be written). */
  private end(r: ActionRecord, status: ActionRecord['status']): Promise<void> {
    r.status = status
    r.endedAt = this.now().toISOString()
    for (const c of r.checks) if (c.status === 'running' || c.status === 'pending') c.status = 'failed'
    this.live.delete(r.runId)
    this.clearTimer(r.runId)
    this.deps.slots.release(r.deviceId, r.runId)
    return this.save('result', r)
  }

  private save(event: 'update' | 'result', r: ActionRecord): Promise<void> {
    const write = this.deps.log.append(event, r, {
      keepCustomOutput: this.deps.settings().saveCustomOutput,
      now: this.now()
    })
    this.track(write)
    this.emitUpdate(r)
    if (r.mode === 'apply') this.deps.onRecorded?.(r)
    return write
  }

  /**
   * A result from the agent's outbox: a run whose end was missed (cable pulled, dashboard
   * restarted), or one this dashboard has no request on record for, which is recorded as such
   * rather than dropped. Acknowledged only once it is on disk.
   */
  private lateResult(deviceId: string, runId: string, raw: unknown): void {
    if (!runId || !raw || typeof raw !== 'object') return
    const ack = (): void => void this.deps.send(deviceId, { type: 'ack', runId })
    const known = this.live.get(runId) ?? this.deps.log.get(runId)
    if (known && known.deviceId === deviceId && known.result && known.endedAt) {
      if (known.status !== 'unknown') return ack() // already recorded
    }
    let rec: ActionRecord | undefined
    if (known && known.deviceId === deviceId) rec = this.live.get(runId) ? known : structuredClone(known)
    else rec = this.orphan(deviceId, runId, raw, !!known)
    if (!rec) return
    this.settle(rec, raw, '', runId)
    void this.end(rec, rec.status).then(ack, () => undefined)
  }

  /**
   * A record for a result the dashboard never asked for, as far as its own log says. When the id
   * is another device's run (a re-enrolled device, or a device reporting someone else's run), the
   * record gets an id of its own, so it can never replace or end that run.
   */
  private orphan(
    deviceId: string,
    runId: string,
    raw: unknown,
    taken: boolean
  ): ActionRecord | undefined {
    const result = cleanResult(raw, runId)
    if (!result) return undefined
    if (taken) result.runId = `${runId}~${deviceId.slice(0, 8)}`
    const device = this.deps.device?.(deviceId)
    const def = result.action ? this.deps.catalog.get(result.action) : undefined
    const caps = this.deps.capabilities(deviceId)
    return {
      runId: result.runId,
      kind: result.kind,
      mode: result.dryRun ? 'preview' : 'apply',
      deviceId,
      serial: device?.serial ?? '',
      hostname: device?.hostname ?? '',
      displayName: device?.displayName ?? deviceId.slice(0, 8),
      os: device?.os ?? def?.os ?? '',
      link: caps?.link ?? 'unknown',
      title: def?.title ?? (result.kind === 'exec' ? 'Custom command' : (result.action ?? 'Action')),
      reason: 'no request for this run is on record in this dashboard; reported by the device',
      technician: '',
      requestedAt: result.startedAt || this.now().toISOString(),
      status: 'running',
      checks: [],
      ...(result.action ? { action: result.action } : {}),
      ...(result.version !== undefined ? { version: result.version } : {}),
      ...(result.sha256 ? { sha256: result.sha256 } : {}),
      ...(result.access ? { access: result.access } : {}),
      ...(def ? { impact: def.impact } : {}),
      ...(result.params ? { params: result.params } : {}),
      ...(result.appliedAt ? { appliedAt: result.appliedAt } : {})
    }
  }

  /** The link dropped: previews fail; a change in progress becomes "outcome unknown". */
  deviceLost(deviceId: string): void {
    for (const r of [...this.live.values()]) {
      if (r.deviceId !== deviceId || r.endedAt) continue
      if (r.mode === 'preview') {
        r.error = 'the link was lost during the preview'
        this.end(r, 'failed')
      } else {
        r.status = 'unknown'
        r.error = 'the link was lost; the device finishes a started change and reports it on the next connection'
        this.save('update', r)
      }
    }
  }

  /** The device is back: a run it still holds continues; any other waits briefly for its result. */
  deviceConnected(deviceId: string): void {
    const caps = this.deps.capabilities(deviceId)
    for (const r of [...this.live.values()]) {
      if (r.deviceId !== deviceId || r.endedAt) continue
      if (caps?.running === r.runId) {
        r.status = 'running'
        r.error = undefined // the link is back and the device is still on it
        this.emitUpdate(r)
        continue
      }
      this.clearTimer(r.runId)
      this.timers.set(
        r.runId,
        setTimeout(() => {
          const still = this.live.get(r.runId)
          if (!still || still.endedAt) return
          // no result came back: keep the record as unknown and free the device
          this.live.delete(r.runId)
          this.deps.slots.release(deviceId, r.runId)
          still.status = 'unknown'
          still.error = 'the device reconnected without reporting this run; check it on the device'
          this.save('update', still)
        }, this.deps.reconnectGraceMs ?? RECONNECT_GRACE_MS)
      )
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
