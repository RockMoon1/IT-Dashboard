import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProfileCatalog,
  profilePurpose,
  validateProfile
} from '../src/main/services/scans/profiles.ts'
import { evaluateHealth, THRESHOLDS, type CheckOutcome } from '../src/main/services/scans/health.ts'
import { ScanRunner, resultsTree } from '../src/main/services/scans/runner.ts'
import { ScanLog } from '../src/main/services/scans/log.ts'
import type { LinkMessage } from '../src/main/services/link/ndjson.ts'
import type { EnrolledDevice } from '../src/main/services/link/devices.ts'

const root = join(import.meta.dirname, '..')
const now = new Date('2026-10-14T12:00:00Z')

test('profile catalog loads the 18 shipped profiles and maps purposes', async () => {
  const catalog = new ProfileCatalog()
  const all = await catalog.load(join(root, 'profiles'))
  assert.equal(all.length, 18)
  for (const p of all) {
    assert.equal(p.schema, 'arh-scan-profile/1')
    for (const c of p.checks) assert.equal(c.access, 'read')
  }
  assert.equal(catalog.forPurpose('windows', 'other')?.name, 'windows-system-diagnostics')
  assert.equal(profilePurpose('other'), 'system-diagnostics')
  assert.equal(catalog.forPurpose('macos', 'phishing-assessment')?.os, 'macos')
  assert.ok(catalog.summaries().every((s) => s.categories.length > 0))
})

test('profile validation refuses write access, shell mismatch and empty commands', () => {
  const base = {
    schema: 'arh-scan-profile/1',
    name: 'x',
    version: 1,
    os: 'linux',
    purpose: 'p',
    checks: [{ id: 'a', shell: 'sh', command: ['uptime'], format: 'text', access: 'read' }]
  }
  assert.equal(validateProfile(base).checks[0]?.timeoutSeconds, 90)
  assert.throws(
    () => validateProfile({ ...base, checks: [{ ...base.checks[0], access: 'write' }] }),
    /not allowed/
  )
  assert.throws(
    () => validateProfile({ ...base, checks: [{ ...base.checks[0], shell: 'powershell' }] }),
    /shell/
  )
  assert.throws(
    () => validateProfile({ ...base, checks: [{ ...base.checks[0], command: ['  '] }] }),
    /empty command/
  )
  assert.throws(() => validateProfile({ ...base, schema: 'other' }), /schema/)
})

function outcome(id: string, stdout: unknown, extra: Partial<CheckOutcome> = {}): CheckOutcome {
  return {
    id,
    title: id,
    category: 'T',
    format: typeof stdout === 'string' ? 'text' : 'json',
    optional: false,
    exitCode: 0,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
    timedOut: false,
    truncated: false,
    ...extra
  }
}

test('health thresholds from the brief: disk < 15%, AV disabled, updates > 30 days, failed-login spike', () => {
  const report = evaluateHealth(
    { os: 'windows', purpose: 'security-check' },
    [
      outcome('sys-overview', {
        os: 'Windows 11',
        disks: [
          { drive: 'C:', freePct: 12, freeGB: 30 },
          { drive: 'D:', freePct: 3, freeGB: 1 }
        ],
        ramUsedPct: 50,
        uptimeHours: 10
      }),
      outcome('sec-defender', {
        available: true,
        antivirusEnabled: false,
        realTimeProtectionEnabled: true,
        signatureAgeDays: 1
      }),
      outcome('sec-updates', {
        hotfixes: [{ HotFixID: 'KB1', InstalledOn: '2026-09-01' }],
        rebootPending: false
      }),
      outcome('sec-logins', {
        failedLogins24h: 25,
        failedLogins7d: 40,
        topFailedAccounts: [{ account: 'admin', failures: 20 }]
      }),
      outcome('sec-services-failed', {
        autoServicesNotRunning: [{ Name: 'Spooler' }],
        scmErrors: []
      }),
      outcome('optional-fail', 'x', { optional: true, exitCode: 1 }),
      outcome('required-fail', 'x', { exitCode: 2 })
    ],
    now
  )
  const msgs = report.findings.map((f) => `${f.severity}:${f.message}`)
  assert.ok(msgs.includes('warning:Disk C: has 12% free (30 GB)'))
  assert.ok(msgs.includes('critical:Disk D: has 3% free (1 GB)'))
  assert.ok(msgs.includes('critical:Microsoft Defender antivirus is disabled'))
  assert.ok(msgs.some((m) => /^warning:No Windows update installed for 4[34] days/.test(m)))
  assert.ok(msgs.includes('critical:25 failed sign-ins in 24 hours: admin (20)'))
  assert.ok(msgs.includes('warning:1 automatic service(s) not running: Spooler'))
  assert.ok(msgs.includes('warning:Check "required-fail" failed (exit 2)'))
  assert.ok(!msgs.some((m) => m.includes('optional-fail')))
  assert.equal(report.score, 'critical')
  assert.equal(THRESHOLDS.diskFreePctLow, 15)
  assert.equal(THRESHOLDS.updateAgeDaysStale, 30)
  assert.ok(report.findings.filter((f) => f.loop).length >= 5)
  assert.ok(
    report.findings.find((f) => f.message.startsWith('Check "required-fail"'))?.loop === false,
    'scan errors are not open loops'
  )
})

test('health: per-user phishing settings and posix heuristics', () => {
  const win = evaluateHealth(
    { os: 'windows', purpose: 'phishing-assessment' },
    [
      outcome('phish-settings', {
        smartScreenExplorer: 'Warn',
        defenderPuaProtection: 0,
        users: [
          { user: 'alice', wordVbaWarnings: 1 },
          { user: 'bob', outlookBlockExternalContent: 0 }
        ]
      }),
      outcome('phish-network', {
        users: [{ user: 'alice', proxyEnabled: true, proxyServer: '10.9.9.9:8080' }],
        hostsEntries: ['1.2.3.4 login.microsoftonline.com'],
        dns: []
      }),
      outcome('phish-extensions', [
        {
          user: 'alice',
          browser: 'Chrome',
          id: 'abc',
          name: 'Coupon Helper',
          permissions: ['<all_urls>']
        }
      ])
    ],
    now
  )
  const m = win.findings.map((f) => f.message)
  assert.ok(m.includes('Office is configured to enable all macros for alice'))
  assert.ok(m.includes('Outlook downloads external content automatically for bob'))
  assert.ok(m.includes('A manual proxy is configured for alice: 10.9.9.9:8080'))
  assert.ok(
    m.some((x) =>
      x.startsWith('1 extension(s) hold broad permissions: Coupon Helper [Chrome, alice]')
    )
  )

  const mac = evaluateHealth(
    { os: 'macos', purpose: 'security-check' },
    [
      outcome(
        'sec-status',
        'gatekeeper: assessments disabled\nfilevault: FileVault is Off.\nsip: enabled'
      ),
      outcome(
        'sec-softwareupdate',
        'Software Update found the following:\n* Label: macOS Sonoma 14.7\n'
      )
    ],
    now
  )
  const mm = mac.findings.map((f) => f.message)
  assert.ok(
    mm.includes('Gatekeeper assessments are disabled') &&
      mm.includes('FileVault disk encryption is off') &&
      mm.includes('1 macOS update(s) available')
  )
  const linux = evaluateHealth(
    { os: 'linux', purpose: 'system-diagnostics' },
    [
      outcome('sys-overview', 'PRETTY_NAME="Ubuntu 24.04"\n/dev/sda1 100G 95G 5G 95% /\n'),
      outcome('sec-services-failed', 'foo.service loaded failed failed Foo\n')
    ],
    now
  )
  assert.ok(
    linux.findings.some(
      (f) => f.message === 'Filesystem / has only 5% free' && f.severity === 'warning'
    )
  )
  assert.ok(linux.findings.some((f) => f.message === '1 systemd unit(s) failed'))
  assert.equal(linux.metrics['OS'], 'Ubuntu 24.04')
})

const device: EnrolledDevice = {
  id: 'dev1',
  serial: 'SER1',
  hostname: 'LAPTOP-01',
  os: 'windows',
  displayName: 'Front desk',
  enrolledAt: 't',
  lastSeen: 't',
  agentVersion: '0.2.0',
  profiles: [
    { name: 'windows-system-diagnostics', version: 1 },
    { name: 'windows-security-check', version: 1 }
  ]
}

test('scan runner: start, stream, finish, log and results tree; failure part way; abort; version mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-scans-'))
  try {
    const catalog = new ProfileCatalog()
    await catalog.load(join(root, 'profiles'))
    const sent: LinkMessage[] = []
    const log = new ScanLog(join(dir, 'scans.jsonl'))
    let clock = Date.parse('2026-10-14T12:00:00Z')
    const runner = new ScanRunner({
      catalog,
      log,
      send: (_id, m) => (sent.push(m), true),
      technician: () => 'Lisandro',
      now: () => new Date(clock)
    })
    const events: string[] = []
    runner.onEvent((e) => events.push(e.type))

    assert.throws(() => runner.start(device, 'system-diagnostics', false), /not connected/)
    assert.throws(
      () => runner.start({ ...device, profiles: [] }, 'system-diagnostics', true),
      /does not carry profile/
    )
    assert.throws(
      () =>
        runner.start(
          { ...device, profiles: [{ name: 'windows-system-diagnostics', version: 2 }] },
          'system-diagnostics',
          true
        ),
      /v2 on the agent but v1 here/
    )

    const run = runner.start(device, 'other', true)
    assert.equal(run.profile, 'windows-system-diagnostics', '"other" runs the baseline profile')
    assert.deepEqual(sent[0], {
      type: 'run',
      runId: run.runId,
      profile: 'windows-system-diagnostics',
      version: 1
    })
    assert.throws(() => runner.start(device, 'security-check', true), /already has a scan running/)

    const first = run.checks[0]!
    runner.handleMessage('dev1', { type: 'check-start', runId: run.runId, checkId: first.id })
    runner.handleMessage('dev1', {
      type: 'check-output',
      runId: run.runId,
      checkId: first.id,
      stream: 'stdout',
      data: '{"os":"Windows 11","disks":[{"drive":"C:","freePct":9,"freeGB":12}]}'
    })
    runner.handleMessage('dev1', {
      type: 'check-end',
      runId: run.runId,
      checkId: first.id,
      exitCode: 0,
      durationMs: 500
    })
    assert.equal(first.status, 'ok')
    // the second check fails and the agent ends the run early
    const second = run.checks[1]!
    runner.handleMessage('dev1', { type: 'check-start', runId: run.runId, checkId: second.id })
    runner.handleMessage('dev1', {
      type: 'check-output',
      runId: run.runId,
      checkId: second.id,
      stream: 'stderr',
      data: 'boom'
    })
    runner.handleMessage('dev1', {
      type: 'check-end',
      runId: run.runId,
      checkId: second.id,
      exitCode: 1,
      durationMs: 20
    })
    clock += 7000
    runner.handleMessage('dev1', {
      type: 'run-end',
      runId: run.runId,
      ok: false,
      error: 'check ' + second.id + ' failed'
    })
    assert.equal(run.status, 'failed')
    assert.equal(run.durationMs, 7000)
    assert.ok(
      run.checks.slice(2).every((c) => c.status === 'failed'),
      'checks never reached are marked failed'
    )
    assert.ok(run.health?.findings.some((f) => f.message === 'Disk C: has 9% free (12 GB)'))
    assert.equal(run.technician, 'Lisandro')
    assert.deepEqual(events, [
      'run-start',
      'check-start',
      'check-output',
      'check-end',
      'check-start',
      'check-output',
      'check-end',
      'run-end'
    ])
    await runner.flush()
    const entries = await log.list({ deviceId: 'dev1' })
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.status, 'failed')
    assert.equal(entries[0]?.technician, 'Lisandro')
    assert.equal(entries[0]?.serial, 'SER1')
    assert.ok(entries[0]!.failedChecks >= 2)
    const tree = resultsTree(run)
    assert.ok(
      tree.some(
        (n) =>
          n.category === 'System' &&
          n.checks.some((c) => (c.parsed as { os?: string })?.os === 'Windows 11')
      )
    )

    // late messages for a finished run are ignored
    runner.handleMessage('dev1', {
      type: 'check-output',
      runId: run.runId,
      checkId: first.id,
      stream: 'stdout',
      data: 'late'
    })
    assert.ok(!first.stdout.endsWith('late'))

    // abort
    const run2 = runner.start(device, 'security-check', true)
    assert.equal(runner.abort(run2.runId), true)
    assert.equal(run2.status, 'aborted')
    assert.deepEqual(sent[sent.length - 1], { type: 'abort', runId: run2.runId })
    assert.equal(runner.abort(run2.runId), false)

    // device loss fails a running scan
    clock += 1000
    const run3 = runner.start(device, 'security-check', true)
    clock += 1000
    runner.deviceLost('dev1')
    assert.equal(run3.status, 'failed')
    assert.match(run3.error ?? '', /disconnected/)
    await runner.flush()
    assert.equal((await log.lastForDevice('dev1'))?.runId, run3.runId)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
