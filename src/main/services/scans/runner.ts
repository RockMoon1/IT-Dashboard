import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type {
  CheckRun,
  Purpose,
  ResultNode,
  RunStatus,
  ScanEvent,
  ScanRun
} from '../../../shared/types.ts'
import type { EnrolledDevice } from '../link/devices.ts'
import type { LinkMessage } from '../link/ndjson.ts'
import { evaluateHealth } from './health.ts'
import type { ScanLog, ScanLogEntry } from './log.ts'
import type { ProfileCatalog, ScanProfile } from './profiles.ts'
import { tryParseJson } from '../util/json.ts'

/**
 * Drives one scan over the link: picks the profile for the purpose, asks the agent to run it,
 * collects streamed output, then evaluates health and appends the scan log.
 */

export type { CheckRun, RunStatus, ScanEvent, ScanRun }

export interface RunnerDeps {
  catalog: ProfileCatalog
  log: ScanLog
  send: (deviceId: string, message: LinkMessage) => boolean
  technician: () => string
  now?: () => Date
}

export class ScanRunner extends EventEmitter {
  private deps: RunnerDeps
  private runs = new Map<string, ScanRun>()
  private active = new Map<string, string>() // deviceId -> runId
  private pendingWrites: Promise<void>[] = []

  constructor(deps: RunnerDeps) {
    super()
    this.deps = deps
  }

  onEvent(cb: (e: ScanEvent) => void): () => void {
    this.on('event', cb)
    return () => this.off('event', cb)
  }

  private emitEvent(e: ScanEvent): void {
    this.emit('event', e)
  }

  get(runId: string): ScanRun | undefined {
    return this.runs.get(runId)
  }

  list(): ScanRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  activeFor(deviceId: string): ScanRun | undefined {
    const id = this.active.get(deviceId)
    return id ? this.runs.get(id) : undefined
  }

  /** Chooses the profile and asks the agent to run it. Throws when it cannot start. */
  start(device: EnrolledDevice, purpose: Purpose, connected: boolean): ScanRun {
    if (!connected) throw new Error(`${device.displayName} is not connected on the link`)
    if (this.active.has(device.id))
      throw new Error(`${device.displayName} already has a scan running`)
    if (device.os === 'unknown') throw new Error('the device OS is unknown; re-enroll the device')
    const profile = this.deps.catalog.forPurpose(device.os, purpose)
    if (!profile) throw new Error(`no ${device.os} profile for purpose ${purpose}`)
    const onAgent = device.profiles.find((p) => p.name === profile.name)
    if (!onAgent)
      throw new Error(
        `the agent on ${device.displayName} does not carry profile ${profile.name}; update the agent`
      )
    if (onAgent.version !== profile.version)
      throw new Error(
        `profile ${profile.name} is v${onAgent.version} on the agent but v${profile.version} here; update the agent`
      )

    const now = (this.deps.now ?? (() => new Date()))()
    const run: ScanRun = {
      runId: `r_${now.getTime().toString(36)}_${randomBytes(3).toString('hex')}`,
      deviceId: device.id,
      serial: device.serial,
      hostname: device.hostname,
      os: device.os,
      purpose,
      profile: profile.name,
      version: profile.version,
      title: profile.title,
      technician: this.deps.technician(),
      startedAt: now.toISOString(),
      status: 'running',
      checks: profile.checks.map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        format: c.format,
        optional: c.optional,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
        status: 'pending',
        durationMs: 0
      })),
      durationMs: 0
    }
    this.runs.set(run.runId, run)
    this.active.set(device.id, run.runId)
    if (
      !this.deps.send(device.id, {
        type: 'run',
        runId: run.runId,
        profile: profile.name,
        version: profile.version
      })
    ) {
      this.runs.delete(run.runId)
      this.active.delete(device.id)
      throw new Error(`${device.displayName} disconnected before the run could start`)
    }
    this.emitEvent({ type: 'run-start', run })
    return run
  }

  abort(runId: string): boolean {
    const run = this.runs.get(runId)
    if (!run || run.status !== 'running') return false
    this.deps.send(run.deviceId, { type: 'abort', runId })
    this.finish(run, 'aborted', 'aborted by the technician')
    return true
  }

  /** Called when a device disconnects: any running scan on it fails. */
  deviceLost(deviceId: string): void {
    const run = this.activeFor(deviceId)
    if (run) this.finish(run, 'failed', 'device disconnected during the scan')
  }

  handleMessage(
    deviceId: string,
    m: LinkMessage,
    profileLookup: (name: string) => ScanProfile | undefined = (n) => this.deps.catalog.get(n)
  ): void {
    const runId = typeof m['runId'] === 'string' ? m['runId'] : ''
    const run = this.runs.get(runId)
    if (!run || run.deviceId !== deviceId || run.status !== 'running') return
    const checkId = typeof m['checkId'] === 'string' ? m['checkId'] : ''
    const check = run.checks.find((c) => c.id === checkId)
    switch (m.type) {
      case 'run-start':
        return
      case 'check-start':
        if (check) {
          check.status = 'running'
          check.startedAt = (this.deps.now ?? (() => new Date()))().toISOString()
          this.emitEvent({ type: 'check-start', runId, checkId })
        }
        return
      case 'check-output':
        if (check && typeof m['data'] === 'string') {
          const stream = m['stream'] === 'stderr' ? 'stderr' : 'stdout'
          if (stream === 'stdout') check.stdout += m['data']
          else check.stderr += m['data']
          this.emitEvent({ type: 'check-output', runId, checkId, stream, data: m['data'] })
        }
        return
      case 'check-end':
        if (check) {
          check.exitCode = typeof m['exitCode'] === 'number' ? m['exitCode'] : null
          check.durationMs = typeof m['durationMs'] === 'number' ? m['durationMs'] : 0
          check.timedOut = m['timedOut'] === true
          check.truncated = m['truncated'] === true
          check.status = check.timedOut ? 'timeout' : check.exitCode === 0 ? 'ok' : 'failed'
          this.emitEvent({ type: 'check-end', runId, check })
        }
        return
      case 'run-end': {
        const ok = m['ok'] === true
        const error = typeof m['error'] === 'string' && m['error'] ? m['error'] : undefined
        for (const c of run.checks)
          if (c.status === 'pending' || c.status === 'running') c.status = 'failed'
        this.finish(run, ok ? 'ok' : 'failed', error, profileLookup(run.profile))
        return
      }
    }
  }

  private finish(run: ScanRun, status: RunStatus, error?: string, profile?: ScanProfile): void {
    if (run.status !== 'running') return
    const now = (this.deps.now ?? (() => new Date()))()
    run.status = status
    run.error = error
    run.finishedAt = now.toISOString()
    run.durationMs = now.getTime() - Date.parse(run.startedAt)
    this.active.delete(run.deviceId)
    const prof = profile ?? this.deps.catalog.get(run.profile)
    run.health = evaluateHealth(
      {
        os: run.os === 'unknown' ? 'linux' : run.os,
        purpose: prof?.purpose ?? 'system-diagnostics'
      },
      run.checks,
      now
    )
    const entry: ScanLogEntry = {
      ts: run.finishedAt,
      runId: run.runId,
      deviceId: run.deviceId,
      serial: run.serial,
      hostname: run.hostname,
      os: run.os,
      purpose: run.purpose,
      profile: run.profile,
      version: run.version,
      technician: run.technician,
      durationMs: run.durationMs,
      status: status === 'running' ? 'failed' : status,
      exitStatus: status === 'ok' ? 'all required checks exit 0' : (error ?? status),
      checks: run.checks.length,
      failedChecks: run.checks.filter((c) => c.status === 'failed' || c.status === 'timeout')
        .length,
      findings: run.health.findings.length,
      critical: run.health.findings.filter((f) => f.severity === 'critical').length
    }
    const write = this.deps.log.append(entry).catch(() => undefined)
    this.pendingWrites.push(write)
    void write.finally(() => {
      this.pendingWrites = this.pendingWrites.filter((p) => p !== write)
    })
    this.emitEvent({ type: 'run-end', run })
  }

  /** Resolves once every scan-log append issued so far has completed. */
  async flush(): Promise<void> {
    await Promise.all(this.pendingWrites)
  }
}

/** Results tree for the renderer: category → checks with parsed JSON where available. */
export function resultsTree(run: ScanRun): ResultNode[] {
  const byCat = new Map<string, ResultNode>()
  for (const c of run.checks) {
    const node = byCat.get(c.category) ?? { category: c.category, checks: [] }
    byCat.set(c.category, node)
    node.checks.push({
      id: c.id,
      title: c.title,
      status: c.status,
      durationMs: c.durationMs,
      parsed: c.format === 'json' ? tryParseJson(c.stdout) : null,
      text: c.format === 'json' ? '' : c.stdout,
      stderr: c.stderr,
      truncated: c.truncated
    })
  }
  return [...byCat.values()]
}
