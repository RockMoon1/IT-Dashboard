import { randomBytes } from 'node:crypto'
import type {
  CommandResult,
  CommandSpec,
  Device,
  OutputEvent,
  SessionRequest,
  SessionSummary,
  TargetOS
} from '../../../shared/types.ts'
import { purposeLabel } from '../../../shared/types.ts'
import { DEFAULT_COMMAND_TIMEOUT_MS, getCommands } from '../diagnostics/catalog.ts'
import { summarize } from '../diagnostics/summary.ts'
import { preparePowerShellScript, windowsSshCommandLine } from './powershell.ts'
import type { RemoteExecutor, RunOptions, RunResult } from './types.ts'
import type { SshOptions, SshTarget } from './ssh.ts'
import type { WinRmTarget } from './winrm.ts'

/**
 * Runs one diagnostic session: resolves the command set for the purpose and target OS, executes
 * each command through the chosen protocol, streams output as it arrives, then summarises.
 * Executors are injected so the orchestration is testable without PowerShell or a network.
 */

export interface SessionDeps {
  local: () => RemoteExecutor
  winrm: (target: WinRmTarget) => RemoteExecutor
  ssh: (target: SshTarget, opts: SshOptions) => Promise<RemoteExecutor>
  knownHosts: Record<string, string>
  strictHostKeys: boolean
  onHostKeyRecorded?: (id: string, fingerprint: string) => void
  now?: () => Date
  newId?: () => string
}

export function newSessionId(): string {
  return randomBytes(4).toString('hex')
}

export function resolveTargetOs(req: SessionRequest, device: Device): TargetOS {
  if (req.targetOs && req.targetOs !== 'unknown') return req.targetOs
  if (req.protocol === 'local')
    return process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'macos'
        : 'linux'
  if (req.protocol === 'winrm') return 'windows'
  return device.os
}

export function validateRequest(req: SessionRequest, device: Device): string | null {
  if (!req.authorizationConfirmed)
    return 'Authorisation to run commands on the target was not confirmed'
  const host = req.host ?? device.host
  if (req.protocol !== 'local' && !host) return 'No host name or IP address for the target'
  if (req.protocol === 'winrm') {
    if (!req.credentials?.username || !req.credentials.password)
      return 'WinRM needs a username and password'
  }
  if (req.protocol === 'ssh') {
    if (!req.credentials?.username) return 'SSH needs a username'
    if (!req.credentials.password && !req.credentials.privateKeyPath)
      return 'SSH needs a password or a private key'
  }
  if (
    req.purpose === 'other' &&
    !(req.customCommands ?? []).some((c) => c.trim() && !c.trim().startsWith('#'))
  ) {
    return 'Purpose "Other" needs at least one custom command'
  }
  return null
}

/** Wraps a catalog command for the transport: PowerShell gets its preamble; sh goes to stdin. */
export function materialize(
  spec: CommandSpec,
  protocol: SessionRequest['protocol'],
  os: TargetOS
): { command: string; stdin?: string } {
  if (spec.shell === 'powershell') {
    const script = preparePowerShellScript(spec.script)
    if (protocol === 'ssh') return { command: windowsSshCommandLine(script) }
    return { command: script }
  }
  if (protocol === 'ssh' && os !== 'windows')
    return { command: '/bin/sh -s', stdin: `${spec.script}\n` }
  return { command: spec.script }
}

export async function runSession(
  req: SessionRequest,
  device: Device,
  deps: SessionDeps,
  onEvent: (e: OutputEvent) => void,
  signal?: AbortSignal
): Promise<SessionSummary> {
  const now = deps.now ?? (() => new Date())
  const sessionId = (deps.newId ?? newSessionId)()
  const startedAt = now().toISOString()
  const targetOs = resolveTargetOs(req, device)
  const host = req.protocol === 'local' ? undefined : (req.host ?? device.host)
  const emit = (stream: OutputEvent['stream'], text: string, commandId?: string): void =>
    onEvent({ sessionId, commandId, stream, text, at: now().toISOString() })

  const base = {
    sessionId,
    deviceId: device.id,
    deviceName: device.name,
    purpose: req.purpose,
    protocol: req.protocol,
    host,
    targetOs,
    startedAt,
    notes: req.notes
  }

  const invalid = validateRequest(req, device)
  if (invalid) {
    emit('status', `Session rejected: ${invalid}`)
    return {
      ...base,
      finishedAt: now().toISOString(),
      results: [],
      findings: [],
      metrics: {},
      ok: false,
      error: invalid
    }
  }

  const commands = getCommands(req.purpose, targetOs, req.customCommands ?? [])
  emit(
    'status',
    `Session ${sessionId}: ${purposeLabel(req.purpose)} on ${device.name}${host ? ` (${host})` : ''} via ${req.protocol}, target OS ${targetOs}, ${commands.length} command(s)`
  )

  let executor: RemoteExecutor
  try {
    executor = await openExecutor(req, host, deps, (t) => emit('status', t))
  } catch (err) {
    const message = `Could not connect: ${(err as Error).message}`
    emit('status', message)
    return {
      ...base,
      finishedAt: now().toISOString(),
      results: [],
      findings: [],
      metrics: {},
      ok: false,
      error: message
    }
  }

  const results: CommandResult[] = []
  let error: string | undefined
  try {
    for (const spec of commands) {
      if (signal?.aborted) {
        error = 'Session aborted by the technician'
        emit('status', error)
        break
      }
      emit('status', `▶ ${spec.title}`, spec.id)
      const { command, stdin } = materialize(spec, req.protocol, targetOs)
      const opts: RunOptions = {
        timeoutMs: spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        signal,
        stdin,
        shell: spec.shell,
        onStdout: (t) => emit('stdout', t, spec.id),
        onStderr: (t) => emit('stderr', t, spec.id)
      }
      const r: RunResult = await executor.exec(command, opts)
      const result: CommandResult = {
        id: spec.id,
        title: spec.title,
        format: spec.format,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        optional: Boolean(spec.optional)
      }
      results.push(result)
      const mark = r.timedOut
        ? '⏱ timed out'
        : r.aborted
          ? '■ aborted'
          : r.exitCode === 0
            ? '✓ done'
            : `✗ exit ${r.exitCode ?? 'n/a'}`
      emit('status', `${mark} · ${spec.title} · ${(r.durationMs / 1000).toFixed(1)}s`, spec.id)
      if (r.aborted) {
        error = 'Session aborted by the technician'
        break
      }
    }
  } finally {
    await executor.close()
  }

  const { findings, metrics } = summarize(req.purpose, targetOs, results, now())
  const required = results.filter((r) => !r.optional)
  const ok = !error && required.length > 0 && required.every((r) => r.exitCode === 0 && !r.timedOut)
  if (!ok && !error) {
    error =
      required.length === 0
        ? 'No required command produced a result'
        : 'One or more required commands failed'
  }
  emit(
    'status',
    `Session ${sessionId} finished: ${ok ? 'OK' : 'FAILED'} · ${findings.length} finding(s)`
  )
  return { ...base, finishedAt: now().toISOString(), results, findings, metrics, ok, error }
}

async function openExecutor(
  req: SessionRequest,
  host: string | undefined,
  deps: SessionDeps,
  onStatus: (t: string) => void
): Promise<RemoteExecutor> {
  const c = req.credentials ?? {}
  switch (req.protocol) {
    case 'local':
      return deps.local()
    case 'winrm':
      return deps.winrm({
        host: host!,
        username: c.username!,
        password: c.password!,
        port: c.port,
        useSsl: c.useSsl,
        skipCertCheck: c.skipCertCheck,
        authentication: 'Default'
      })
    case 'ssh':
      return deps.ssh(
        {
          host: host!,
          port: c.port ?? 22,
          username: c.username!,
          password: c.password,
          privateKeyPath: c.privateKeyPath,
          passphrase: c.passphrase
        },
        {
          knownHosts: deps.knownHosts,
          strictHostKeys: deps.strictHostKeys,
          onStatus,
          onHostKeyRecorded: deps.onHostKeyRecorded
        }
      )
  }
}
