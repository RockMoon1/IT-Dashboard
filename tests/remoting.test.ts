import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodePowerShellCommand,
  encodePowerShellCommand,
  powerShellArgs,
  PS_PREAMBLE,
  windowsSshCommandLine
} from '../src/main/services/remoting/powershell.ts'
import {
  trustedHostsCovers,
  trustedHostsCommand,
  winRmEnv,
  WINRM_HOST_SCRIPT
} from '../src/main/services/remoting/winrm.ts'
import { decideHostKey, hostKeyId } from '../src/main/services/remoting/hostkeys.ts'
import { materialize, runSession, validateRequest } from '../src/main/services/remoting/session.ts'
import type { RemoteExecutor, RunResult } from '../src/main/services/remoting/types.ts'
import type { Device, OutputEvent, SessionRequest } from '../src/shared/types.ts'

test('EncodedCommand round-trips UTF-16LE base64', () => {
  const script = "Write-Output 'héllo'"
  assert.equal(decodePowerShellCommand(encodePowerShellCommand(script)), script)
  const args = powerShellArgs(script)
  assert.equal(args[0], '-NoLogo')
  assert.equal(args[args.length - 2], '-EncodedCommand')
  assert.ok(
    windowsSshCommandLine(script).startsWith('powershell.exe -NoLogo -NoProfile -NonInteractive')
  )
})

test('WinRM wrapper takes secrets from the environment, never the command line', () => {
  const env = winRmEnv(
    {
      host: 'PC1',
      username: 'tech',
      password: 'p@ss',
      port: 5986,
      useSsl: true,
      skipCertCheck: true
    },
    'Get-Date'
  )
  assert.equal(env['ARH_TARGET_HOST'], 'PC1')
  assert.equal(env['ARH_TARGET_PASSWORD'], 'p@ss')
  assert.equal(env['ARH_TARGET_PORT'], '5986')
  assert.equal(env['ARH_TARGET_USESSL'], '1')
  assert.equal(env['ARH_TARGET_SKIPCERT'], '1')
  assert.equal(Buffer.from(env['ARH_TARGET_SCRIPT_B64']!, 'base64').toString('utf8'), 'Get-Date')
  assert.ok(!WINRM_HOST_SCRIPT.includes('p@ss'))
  assert.ok(WINRM_HOST_SCRIPT.includes('Invoke-Command @params'))
})

test('TrustedHosts matching supports wildcards and is case-insensitive', () => {
  assert.equal(trustedHostsCovers('*', 'anything'), true)
  assert.equal(trustedHostsCovers('192.168.1.*, LAPTOP-01', '192.168.1.44'), true)
  assert.equal(trustedHostsCovers('192.168.1.*, LAPTOP-01', 'laptop-01'), true)
  assert.equal(trustedHostsCovers('192.168.1.*', '192.168.2.1'), false)
  assert.equal(trustedHostsCovers('', 'x'), false)
  assert.equal(
    trustedHostsCommand("it's"),
    "Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value 'it''s' -Concatenate -Force"
  )
})

test('SSH host key decisions', () => {
  const id = hostKeyId('Server.LAN', 22)
  assert.equal(id, 'server.lan:22')
  assert.equal(decideHostKey({}, id, 'aa', false), 'recorded')
  assert.equal(decideHostKey({}, id, 'aa', true), 'unknown-strict')
  assert.equal(decideHostKey({ [id]: 'aa' }, id, 'aa', true), 'known')
  assert.equal(decideHostKey({ [id]: 'aa' }, id, 'bb', false), 'mismatch')
})

test('materialize picks the transport form of each command', () => {
  const ps = {
    id: 'x',
    title: 'x',
    shell: 'powershell' as const,
    script: 'Get-Date',
    format: 'text' as const
  }
  const sh = {
    id: 'y',
    title: 'y',
    shell: 'sh' as const,
    script: 'uname -a',
    format: 'text' as const
  }
  assert.equal(materialize(ps, 'winrm', 'windows').command, `${PS_PREAMBLE}\nGet-Date\n`)
  const overSsh = materialize(ps, 'ssh', 'windows')
  assert.ok(overSsh.command.includes('-EncodedCommand'))
  assert.equal(
    decodePowerShellCommand(overSsh.command.split('-EncodedCommand ')[1]!),
    `${PS_PREAMBLE}\nGet-Date\n`
  )
  assert.deepEqual(materialize(sh, 'ssh', 'linux'), { command: '/bin/sh -s', stdin: 'uname -a\n' })
  assert.deepEqual(materialize(sh, 'local', 'linux'), { command: 'uname -a' })
})

const device: Device = {
  id: 'manual:pc1',
  kind: 'manual',
  name: 'PC1',
  present: true,
  firstSeen: 't',
  lastSeen: 't',
  os: 'windows',
  protocols: ['winrm'],
  host: 'pc1'
}

test('validateRequest rejects missing authorisation and credentials', () => {
  const base: SessionRequest = {
    deviceId: device.id,
    purpose: 'system-diagnostics',
    protocol: 'winrm',
    authorizationConfirmed: false
  }
  assert.match(validateRequest(base, device)!, /Authorisation/)
  assert.match(validateRequest({ ...base, authorizationConfirmed: true }, device)!, /WinRM needs/)
  assert.match(
    validateRequest(
      { ...base, authorizationConfirmed: true, protocol: 'ssh', credentials: { username: 'u' } },
      device
    )!,
    /password or a private key/
  )
  assert.equal(
    validateRequest(
      { ...base, authorizationConfirmed: true, credentials: { username: 'u', password: 'p' } },
      device
    ),
    null
  )
  assert.match(
    validateRequest(
      {
        ...base,
        authorizationConfirmed: true,
        purpose: 'other',
        protocol: 'local',
        customCommands: ['# only a comment']
      },
      device
    )!,
    /custom command/
  )
})

function fakeExecutor(
  answer: (script: string) => Partial<RunResult>
): RemoteExecutor & { closed: boolean; calls: string[] } {
  const ex = {
    closed: false,
    calls: [] as string[],
    async exec(script: string, opts: { onStdout?: (t: string) => void } = {}): Promise<RunResult> {
      ex.calls.push(script)
      const r = {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        durationMs: 5,
        ...answer(script)
      }
      if (r.stdout) opts.onStdout?.(r.stdout)
      return r
    },
    close() {
      ex.closed = true
    }
  }
  return ex
}

test('runSession streams output, summarises and closes the executor', async () => {
  const executor = fakeExecutor((script) => ({
    stdout:
      script.includes('sys-overview') || script.includes('Win32_OperatingSystem')
        ? JSON.stringify({ os: 'Windows 11', ramUsedPct: 97, disks: [] })
        : '[]'
  }))
  const events: OutputEvent[] = []
  const req: SessionRequest = {
    deviceId: device.id,
    purpose: 'system-diagnostics',
    protocol: 'winrm',
    credentials: { username: 'u', password: 'p' },
    authorizationConfirmed: true,
    notes: 'ticket 42'
  }
  const summary = await runSession(
    req,
    device,
    {
      local: () => executor,
      winrm: () => executor,
      ssh: async () => executor,
      knownHosts: {},
      strictHostKeys: false,
      newId: () => 'sess1',
      now: () => new Date('2026-10-14T12:00:00Z')
    },
    (e) => events.push(e)
  )
  assert.equal(summary.sessionId, 'sess1')
  assert.equal(summary.ok, true)
  assert.equal(summary.targetOs, 'windows')
  assert.equal(summary.host, 'pc1')
  assert.equal(summary.notes, 'ticket 42')
  assert.equal(summary.results.length, executor.calls.length)
  assert.ok(summary.findings.includes('RAM usage is 97%'))
  assert.ok(events[0]?.text.startsWith('Session sess1: System Diagnostics on PC1 (pc1) via winrm'))
  assert.ok(events.some((e) => e.stream === 'stdout'))
  assert.ok(events.some((e) => e.stream === 'status' && e.text.startsWith('✓ done')))
  assert.equal(executor.closed, true)
  assert.ok(
    executor.calls.every((c) => c.startsWith(PS_PREAMBLE)),
    'every WinRM script carries the preamble'
  )
})

test('runSession fails cleanly when a required command fails and when the connection fails', async () => {
  const failing = fakeExecutor(() => ({ exitCode: 1, stderr: 'boom' }))
  const req: SessionRequest = {
    deviceId: device.id,
    purpose: 'other',
    protocol: 'local',
    customCommands: ['whoami'],
    authorizationConfirmed: true
  }
  const s1 = await runSession(
    req,
    device,
    {
      local: () => failing,
      winrm: () => failing,
      ssh: async () => failing,
      knownHosts: {},
      strictHostKeys: false
    },
    () => undefined
  )
  assert.equal(s1.ok, false)
  assert.deepEqual(s1.findings, ['Command "whoami" failed (exit 1)'])
  assert.equal(failing.closed, true)

  const sshReq: SessionRequest = {
    ...req,
    protocol: 'ssh',
    credentials: { username: 'u', password: 'p' },
    targetOs: 'linux'
  }
  const s2 = await runSession(
    sshReq,
    device,
    {
      local: () => failing,
      winrm: () => failing,
      ssh: async () => {
        throw new Error('ECONNREFUSED')
      },
      knownHosts: {},
      strictHostKeys: false
    },
    () => undefined
  )
  assert.equal(s2.ok, false)
  assert.match(s2.error!, /Could not connect: ECONNREFUSED/)
  assert.equal(s2.results.length, 0)
})

test('runSession honours an abort signal', async () => {
  const executor = fakeExecutor(() => ({ stdout: 'x' }))
  const ac = new AbortController()
  ac.abort()
  const req: SessionRequest = {
    deviceId: device.id,
    purpose: 'other',
    protocol: 'local',
    customCommands: ['a', 'b'],
    authorizationConfirmed: true
  }
  const s = await runSession(
    req,
    device,
    {
      local: () => executor,
      winrm: () => executor,
      ssh: async () => executor,
      knownHosts: {},
      strictHostKeys: false
    },
    () => undefined,
    ac.signal
  )
  assert.equal(s.ok, false)
  assert.equal(s.results.length, 0)
  assert.match(s.error!, /aborted/)
})
