import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  actionStatus,
  belongsInChangeLog,
  changedItems,
  checkParam,
  cleanResult,
  type ActionRecord,
  type AgentResult
} from '../src/shared/actions.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settings-defaults.ts'
import type { DeviceCapabilities, ScanRun, Settings } from '../src/shared/types.ts'
import { ActionCatalog } from '../src/main/services/actions/catalog.ts'
import { ActionLog } from '../src/main/services/actions/log.ts'
import { ActionRunner, policyBlocks } from '../src/main/services/actions/runner.ts'
import { DeviceSlots } from '../src/main/services/link/slots.ts'
import { capabilitiesOf } from '../src/main/services/link/server.ts'
import type { LinkMessage } from '../src/main/services/link/ndjson.ts'
import type { EnrolledDevice } from '../src/main/services/link/devices.ts'
import {
  DEFAULT_CONTENT_OPTIONS,
  actionLogEntry,
  mergeChanges,
  mergeLog,
  vaultText,
  whatChanged,
  type ActionEntry
} from '../src/main/services/vault/content.ts'
import { findBlock, setBlock } from '../src/main/services/vault/markers.ts'
import { parseMarkdown, type Block } from '../src/shared/markdown.ts'

const root = join(import.meta.dirname, '..')

async function catalog(): Promise<ActionCatalog> {
  const c = new ActionCatalog()
  await c.load(join(root, 'actions'))
  assert.deepEqual(c.errors, [])
  return c
}

test('catalog: every shipped action loads, and Node hashes each file exactly as Go does', async () => {
  const c = await catalog()
  assert.ok(c.list().length >= 20)
  const lock = (await readFile(join(root, 'actions', 'versions.lock'), 'utf8'))
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.split(/\s+/))
  const locked = new Map(lock.map(([k, v]) => [k, v]))
  for (const a of c.list()) assert.equal(locked.get(`${a.name}@${a.version}`), a.sha256, a.name)
})

// The agent checks parameters with Go's RE2 and the dashboard with JavaScript: both must agree
// on every sample value in the action files, and on the values every parameter must refuse.
test('catalog: parameter samples give the same answer in JavaScript as in Go', async () => {
  const alwaysBad = ['-x', '--all', 'a*', 'a?', 'a[b]', 'a\nb', 'a\rb', 'a\u0000b']
  for (const a of (await catalog()).list())
    for (const p of a.params) {
      for (const v of p.examples.ok)
        assert.equal(checkParam(p, v), null, `${a.name}/${p.name} ${v}`)
      for (const v of [...alwaysBad, ...p.examples.bad.filter(Boolean)])
        assert.notEqual(
          checkParam(p, v),
          null,
          `${a.name}/${p.name} should refuse ${JSON.stringify(v)}`
        )
      if (p.default) assert.equal(checkParam(p, p.default), null)
    }
})

test('catalog: Fix buttons match the findings health.ts raises', async () => {
  const c = await catalog()
  const fixes = (os: string, category: string, message: string): string[] =>
    c.fixesFor(os, category, message).map((a) => a.name)
  assert.deepEqual(fixes('windows', 'Firewall', 'Firewall profile "Public" is disabled'), [
    'windows-firewall-on'
  ])
  assert.deepEqual(fixes('windows', 'Antivirus', 'Defender real-time protection is off'), [
    'windows-defender-realtime-on'
  ])
  assert.deepEqual(fixes('windows', 'Antivirus', 'Defender signatures are 9 days old'), [
    'windows-defender-update'
  ])
  assert.deepEqual(
    fixes('windows', 'Protection', 'Defender potentially-unwanted-app blocking is off'),
    ['windows-defender-pua-on']
  )
  assert.deepEqual(
    fixes('windows', 'Services', '2 automatic service(s) not running: Spooler, BITS'),
    ['windows-service-start']
  )
  assert.ok(
    fixes('windows', 'Updates', 'A reboot is pending to finish servicing/updates').includes(
      'windows-restart'
    )
  )
  assert.deepEqual(fixes('macos', 'Firewall', 'macOS application firewall is disabled'), [
    'macos-firewall-on'
  ])
  assert.deepEqual(fixes('windows', 'Antivirus', 'Microsoft Defender antivirus is disabled'), [])
  assert.deepEqual(fixes('linux', 'Firewall', 'Firewall profile "Public" is disabled'), [])
})

/* ---------- status from measurements ---------- */

const m = (items: Array<[string, string]>, extra: Partial<AgentResult['before']> = {}) => ({
  items: items.map(([item, value]) => ({ item, value })),
  exitCode: 0,
  ...extra
})

function result(over: Partial<AgentResult> = {}): AgentResult {
  return {
    runId: 'a_1',
    kind: 'action',
    action: 'windows-firewall-on',
    version: 1,
    access: 'write',
    dryRun: false,
    applied: true,
    startedAt: '2026-10-20T20:05:00Z',
    before: m(
      [
        ['Firewall Public', 'off'],
        ['Firewall Domain', 'on']
      ],
      { change: true }
    ),
    apply: { items: null, exitCode: 0 },
    after: m(
      [
        ['Firewall Public', 'on'],
        ['Firewall Domain', 'on']
      ],
      { change: false }
    ),
    ...over
  }
}

test('status: worked out from measured before and after, not from exit codes alone', () => {
  assert.equal(actionStatus(result()), 'changed')
  // apply exited 0 but nothing moved and the check afterwards still wants a change
  assert.equal(
    actionStatus(
      result({
        after: m(
          [
            ['Firewall Public', 'off'],
            ['Firewall Domain', 'on']
          ],
          { change: true }
        )
      })
    ),
    'not-applied'
  )
  assert.equal(
    actionStatus(
      result({
        before: m(
          [
            ['A', 'off'],
            ['B', 'off']
          ],
          { change: true }
        ),
        after: m(
          [
            ['A', 'on'],
            ['B', 'off']
          ],
          { change: true }
        )
      })
    ),
    'partly-applied'
  )
  // a result that cannot confirm the change is "not verified", never "unknown" (no result yet)
  assert.equal(actionStatus(result({ after: { items: null, exitCode: 1 } })), 'not-verified')
  assert.equal(
    actionStatus(
      result({
        applied: false,
        apply: undefined,
        after: undefined,
        before: m([['A', 'on']], { change: false })
      })
    ),
    'already-set'
  )
  assert.equal(
    actionStatus(
      result({
        applied: false,
        apply: undefined,
        after: undefined,
        before: m([['A', 'off']], { change: true, blockers: ['Group Policy'] })
      })
    ),
    'blocked'
  )
  assert.equal(
    actionStatus(result({ dryRun: true, applied: false, apply: undefined, after: undefined })),
    'would-change'
  )
  assert.equal(
    actionStatus(
      result({ dryRun: true, applied: false, before: m([['A', 'on']], { change: false }) })
    ),
    'nothing-to-change'
  )
  assert.equal(
    actionStatus(result({ dryRun: true, applied: false, before: { items: [], exitCode: 1 } })),
    'failed'
  )
  assert.equal(
    actionStatus(result({ access: 'execute', apply: { items: null, exitCode: 0 } })),
    'done'
  )
  assert.equal(
    actionStatus(result({ access: 'execute', apply: { items: null, exitCode: 5 } })),
    'failed'
  )
  // sfc: a write whose effect is evidence (CBS.log lines), not a measured value
  assert.equal(
    actionStatus(
      result({
        before: m([], { change: true }),
        apply: { items: null, exitCode: 0, changes: ['Repaired 2 files'] }
      })
    ),
    'done'
  )
  assert.equal(
    actionStatus({
      runId: 'x',
      kind: 'exec',
      dryRun: false,
      applied: true,
      exitCode: 0,
      startedAt: ''
    }),
    'not-measured'
  )
  assert.equal(actionStatus(undefined, { lost: true }), 'unknown')
  assert.deepEqual(changedItems(result().before, result().after), [
    { item: 'Firewall Public', before: 'off', after: 'on' }
  ])
})

test('status: what reaches the Change Log', () => {
  const base = { mode: 'apply' as const, kind: 'action' as const, access: 'write' as const }
  assert.equal(belongsInChangeLog({ ...base, status: 'changed', result: result() }), true)
  assert.equal(belongsInChangeLog({ ...base, status: 'already-set' }), false)
  assert.equal(belongsInChangeLog({ ...base, status: 'not-applied' }), false)
  assert.equal(belongsInChangeLog({ ...base, status: 'unknown' }), true)
  assert.equal(belongsInChangeLog({ ...base, mode: 'preview', status: 'would-change' }), false)
  assert.equal(belongsInChangeLog({ ...base, access: 'execute', status: 'done' }), false)
  assert.equal(
    belongsInChangeLog({
      ...base,
      status: 'done',
      result: result({ apply: { items: null, exitCode: 0, changes: ['Repaired 1'] } })
    }),
    true
  )
  assert.equal(
    belongsInChangeLog({
      mode: 'apply',
      kind: 'exec',
      status: 'not-measured',
      result: { runId: 'x', kind: 'exec', dryRun: false, applied: true, startedAt: '' }
    }),
    true
  )
})

/* ---------- protocol fixture shared with the Go tests ---------- */

async function golden(): Promise<LinkMessage[]> {
  const text = await readFile(join(root, 'tests', 'fixtures', 'protocol', 'actions.ndjson'), 'utf8')
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LinkMessage)
}

test('protocol fixture: hello capabilities and policy messages decode', async () => {
  const msgs = await golden()
  const caps = capabilitiesOf(msgs[0]!)
  assert.equal(caps.protocol, 2)
  assert.equal(caps.link, 'cable')
  assert.equal(caps.actions[0]?.name, 'windows-firewall-on')
  assert.deepEqual(caps.policy, {
    write: true,
    execute: true,
    custom: false,
    lan: false,
    interrupts: true,
    deny: ['windows-sfc'],
    error: undefined
  })
  assert.equal(caps.running, 'a_k1_000001')
  assert.equal(caps.pendingRestartUntil, '2026-10-20T20:15:00Z')
  // an agent from before Phase 3 reports none of this: read only
  const old = capabilitiesOf({ type: 'hello', hostname: 'x', profiles: [] })
  assert.equal(old.protocol, 1)
  assert.equal(old.policy, null)
  assert.deepEqual(policyBlocks(old, { name: 'x', access: 'write', impact: 'quiet' }).length, 1)
})

/* ---------- the runner: gates in main, records, lost links ---------- */

const device: EnrolledDevice = {
  id: 'dev1',
  serial: '5CG1234XYZ',
  hostname: 'ARH-FD01',
  os: 'windows',
  displayName: 'Front desk 1',
  enrolledAt: '2026-10-01T00:00:00Z',
  lastSeen: '2026-10-20T00:00:00Z',
  agentVersion: '0.3.0',
  profiles: []
}

async function harness(over: Partial<Settings> = {}) {
  const c = await catalog()
  const dir = await mkdtemp(join(tmpdir(), 'arh-actions-'))
  const log = new ActionLog(join(dir, 'actions.jsonl'))
  const sent: LinkMessage[] = []
  const recorded: ActionRecord[] = []
  let settings: Settings = { ...DEFAULT_SETTINGS, technician: 'Lisandro', ...over }
  let clock = new Date('2026-10-20T20:00:00Z')
  const fw = c.get('windows-firewall-on')!
  let caps: DeviceCapabilities | undefined = {
    protocol: 2,
    link: 'cable',
    actions: c
      .forOs('windows')
      .map((a) => ({ name: a.name, version: a.version, sha256: a.sha256 })),
    policy: { write: true, execute: true, custom: false, lan: false, interrupts: true, deny: [] }
  }
  const slots = new DeviceSlots()
  const runner = new ActionRunner({
    catalog: c,
    log,
    slots,
    send: (_d, msg) => {
      sent.push(msg)
      return true
    },
    capabilities: () => caps,
    settings: () => settings,
    now: () => clock,
    onRecorded: (r) => recorded.push(structuredClone(r)),
    ackTimeoutMs: 60_000,
    reconnectGraceMs: 20
  })
  return {
    c,
    dir,
    log,
    sent,
    recorded,
    runner,
    slots,
    fw,
    setCaps: (x: DeviceCapabilities | undefined) => (caps = x),
    caps: () => caps!,
    setSettings: (p: Partial<Settings>) => (settings = { ...settings, ...p }),
    tick: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    done: async () => {
      runner.stop()
      await runner.flush()
      await rm(dir, { recursive: true, force: true })
    }
  }
}

function previewEnd(runId: string, change = true, warnings: string[] = []): LinkMessage {
  return {
    type: 'run-end',
    runId,
    ok: true,
    result: result({
      runId,
      dryRun: true,
      applied: false,
      apply: undefined,
      after: undefined,
      before: m([['Firewall Public', 'off']], { change, warnings })
    })
  }
}

test('runner: a run needs a fresh, matching preview, a reason and a technician', async () => {
  const h = await harness()
  try {
    const req = {
      deviceId: device.id,
      action: 'windows-firewall-on',
      params: {},
      reason: 'Fix: Public off'
    }
    assert.throws(() => h.runner.run(device, req), /preview the action first/)
    const p = h.runner.preview(device, req)
    assert.equal(h.sent[0]?.['mode'], 'preview')
    assert.equal(h.sent[0]?.['sha256'], h.fw.sha256)
    assert.throws(() => h.runner.preview(device, req), /busy/, 'one run per device')
    h.runner.handleMessage(device.id, { type: 'run-start', runId: p.runId })
    h.runner.handleMessage(device.id, previewEnd(p.runId))
    assert.equal(h.runner.get(p.runId)?.status, 'would-change')
    await h.runner.flush() // acknowledged only once the result is on disk
    await new Promise((r) => setImmediate(r))
    assert.ok(
      h.sent.some((x) => x.type === 'ack' && x['runId'] === p.runId),
      'result acknowledged'
    )

    assert.throws(
      () => h.runner.run(device, { ...req, reason: ' ' }, { previewOf: p.runId }),
      /say why/
    )
    h.setSettings({ technician: '' })
    assert.throws(() => h.runner.run(device, req, { previewOf: p.runId }), /set your name/)
    h.setSettings({ technician: 'Lisandro' })
    h.tick(11 * 60_000)
    assert.throws(
      () => h.runner.run(device, req, { previewOf: p.runId }),
      /more than 10 minutes old/
    )
    h.tick(-11 * 60_000)

    const r = h.runner.run(device, req, { previewOf: p.runId })
    const msg = h.sent.at(-1)!
    assert.equal(msg.type, 'action')
    assert.equal(msg['mode'], 'apply')
    assert.equal(msg['technician'], 'Lisandro')
    assert.equal(msg['reason'], 'Fix: Public off')
    assert.throws(() => h.runner.run(device, req, { previewOf: p.runId }), /busy|already used/)

    h.runner.handleMessage(device.id, { type: 'run-start', runId: r.runId, link: 'cable' })
    h.runner.handleMessage(device.id, { type: 'check-start', runId: r.runId, checkId: 'apply' })
    h.runner.handleMessage(device.id, {
      type: 'run-end',
      runId: r.runId,
      ok: true,
      result: result({ runId: r.runId })
    })
    const done = h.runner.get(r.runId)!
    assert.equal(done.status, 'changed')
    assert.ok(done.appliedAt)
    assert.equal(h.slots.holder(device.id), undefined, 'slot released')
    assert.ok(h.recorded.some((x) => x.runId === r.runId && x.status === 'changed'))
  } finally {
    await h.done()
  }
})

test('runner: Settings, the device policy, the cable and the agent copy are all enforced in main', async () => {
  const h = await harness()
  try {
    const req = { deviceId: device.id, action: 'windows-firewall-on', params: {}, reason: 'r' }
    const blocked = (): string[] => h.runner.blockers(device, h.fw, 'apply')
    assert.deepEqual(blocked(), [])
    h.setSettings({ deviceWrite: false })
    assert.match(blocked().join(), /changing settings is off/)
    h.setSettings({ deviceWrite: true, disabledActions: ['windows-firewall-on'] })
    assert.match(blocked().join(), /switched off/)
    h.setSettings({ disabledActions: [] })
    h.setCaps({ ...h.caps(), link: 'lan' })
    assert.match(blocked().join(), /only over the USB cable/)
    h.setCaps({ ...h.caps(), link: 'cable', policy: { ...h.caps().policy!, write: false } })
    assert.match(blocked().join(), /refuses changes to settings/)
    h.setCaps({ ...h.caps(), policy: { ...h.caps().policy!, write: true, interrupts: false } })
    assert.match(blocked().join(), /interrupt work/)
    h.setCaps({
      ...h.caps(),
      policy: { ...h.caps().policy!, interrupts: true },
      actions: [{ name: 'windows-firewall-on', version: 1, sha256: 'f'.repeat(64) }]
    })
    assert.match(blocked().join(), /different copy/)
    assert.throws(
      () => h.runner.preview(device, req),
      /different copy/,
      'not even a preview of a script that differs'
    )
    h.setCaps(undefined)
    assert.match(blocked().join(), /not connected/)
    // parameters are checked here too
    h.setCaps({
      protocol: 2,
      link: 'cable',
      actions: h.c
        .forOs('windows')
        .map((a) => ({ name: a.name, version: a.version, sha256: a.sha256 })),
      policy: { write: true, execute: true, custom: false, lan: false, interrupts: true, deny: [] }
    })
    assert.throws(
      () =>
        h.runner.preview(device, {
          ...req,
          action: 'windows-service-start',
          params: { name: '-rf' }
        }),
      /may not start with -/
    )
    assert.throws(
      () => h.runner.preview(device, { ...req, params: { extra: 'x' } }),
      /no parameter extra/
    )
    // custom commands need the device's own opt-in
    assert.throws(
      () =>
        h.runner.exec(device, {
          deviceId: device.id,
          script: 'Get-Date',
          timeoutSeconds: 60,
          reason: 'r'
        }),
      /refuses custom commands/
    )
  } finally {
    await h.done()
  }
})

test('runner: an interrupting action while someone is signed in needs the computer name typed', async () => {
  const h = await harness()
  try {
    const req = {
      deviceId: device.id,
      action: 'windows-restart',
      params: { minutes: '10' },
      reason: 'updates'
    }
    const p = h.runner.preview(device, req)
    h.runner.handleMessage(device.id, previewEnd(p.runId, true, ['LISANDRO is signed in']))
    assert.throws(() => h.runner.run(device, req, { previewOf: p.runId }), /type its name/)
    assert.throws(
      () => h.runner.run(device, req, { previewOf: p.runId, confirmName: 'ARH-FD02' }),
      /type its name/
    )
    const r = h.runner.run(device, req, { previewOf: p.runId, confirmName: 'arh-fd01' })
    assert.equal(r.params?.['minutes'], '10')
    // interrupting actions always need a preview, even with "preview first" off
    h.runner.handleMessage(device.id, {
      type: 'run-end',
      runId: r.runId,
      ok: false,
      errorCode: 'busy',
      error: 'busy'
    })
    h.setSettings({ previewFirst: false })
    assert.throws(() => h.runner.run(device, req), /preview the action first/)
  } finally {
    await h.done()
  }
})

test('runner: a lost link makes a started change "outcome unknown"; the late result settles it', async () => {
  const h = await harness({ previewFirst: false })
  try {
    const req = {
      deviceId: device.id,
      action: 'windows-dns-flush',
      params: {},
      reason: 'stale names'
    }
    const r = h.runner.run(device, req)
    h.runner.handleMessage(device.id, { type: 'run-start', runId: r.runId })
    h.runner.handleMessage(device.id, { type: 'check-start', runId: r.runId, checkId: 'apply' })
    h.runner.deviceLost(device.id)
    assert.equal(h.runner.get(r.runId)?.status, 'unknown')
    assert.ok(h.slots.holder(device.id), 'the slot stays taken: the device is still working')
    h.runner.deviceConnected(device.id)
    h.runner.handleMessage(device.id, {
      type: 'result',
      runId: r.runId,
      result: result({ runId: r.runId, access: 'execute', action: 'windows-dns-flush' })
    })
    assert.equal(h.runner.get(r.runId)?.status, 'done')
    assert.equal(h.slots.holder(device.id), undefined)
    await h.runner.flush()
    await new Promise((res) => setTimeout(res, 10))
    assert.ok(h.sent.some((x) => x.type === 'ack' && x['runId'] === r.runId))
    // a preview interrupted by a lost link simply failed
    const p = h.runner.preview(device, req)
    h.runner.deviceLost(device.id)
    assert.equal(h.runner.get(p.runId)?.status, 'failed')
    // a device that comes back without reporting a run frees the slot after a grace period
    const r2 = h.runner.run(device, req)
    h.runner.handleMessage(device.id, { type: 'run-start', runId: r2.runId })
    h.runner.deviceLost(device.id)
    h.runner.deviceConnected(device.id)
    await new Promise((res) => setTimeout(res, 60))
    assert.equal(h.slots.holder(device.id), undefined)
    assert.equal(h.runner.get(r2.runId)?.status, 'unknown')
  } finally {
    await h.done()
  }
})

test('action log: hash-chained; editing or removing a line is detected', async () => {
  const h = await harness({ previewFirst: false })
  try {
    const r = h.runner.run(device, {
      deviceId: device.id,
      action: 'windows-dns-flush',
      params: {},
      reason: 'x'
    })
    h.runner.handleMessage(device.id, {
      type: 'run-end',
      runId: r.runId,
      ok: true,
      result: result({ runId: r.runId, access: 'execute' })
    })
    await h.runner.flush()
    assert.deepEqual(await h.log.verify(), { lines: 2, broken: [] })
    const file = join(h.dir, 'actions.jsonl')
    const text = await readFile(file, 'utf8')
    await writeFile(file, text.replace('"reason":"x"', '"reason":"y"'))
    assert.deepEqual(
      (await h.log.verify()).broken,
      [1, 2].filter((n) => n === 1 || n === 2).slice(0, 1)
    )
  } finally {
    await h.done()
  }
})

/* ---------- vault: Change Log rows and Work Log entries ---------- */

function entry(over: Partial<ActionRecord> = {}): ActionEntry {
  const record: ActionRecord = {
    runId: 'a_mgzz_abc123',
    kind: 'action',
    mode: 'apply',
    deviceId: device.id,
    serial: device.serial,
    hostname: device.hostname,
    displayName: device.displayName,
    os: 'windows',
    link: 'cable',
    action: 'windows-firewall-on',
    version: 1,
    title: 'Turn on firewall profiles that are off',
    access: 'write',
    impact: 'interrupts',
    params: {},
    reason: 'Fix: Firewall profile "Public" is disabled',
    technician: 'Lisandro',
    requestedAt: '2026-10-20T20:04:00Z',
    startedAt: '2026-10-20T20:04:01Z',
    appliedAt: '2026-10-20T20:05:00Z',
    endedAt: '2026-10-20T20:05:09Z',
    status: 'changed',
    result: result(),
    checks: [],
    ...over
  }
  return {
    record,
    def: {
      manualUndo: 'Set-NetFirewallProfile -Profile <the profiles> -Enabled False',
      undo: ''
    } as ActionEntry['def']
  }
}

test('vault: Change Log rows use the note columns, oldest first, append-only by run id', () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const one = mergeChanges(null, [entry()], opts)
  assert.equal(one.added, 1)
  const lines = one.body.split('\n')
  assert.equal(
    lines[4],
    '| Timestamp (MT) | System / machine | What changed | Why | Reversible? | Rollback | By |'
  )
  assert.equal(
    lines[6],
    '| 2026-10-20 14:05 | Front desk 1 · ARH-FD01 · serial 5CG1234XYZ | Firewall Public: off → on | Fix: Firewall profile "Public" is disabled | Yes, by hand | Manual: Set-NetFirewallProfile -Profile \\<the profiles\\> -Enabled False | Lisandro · run a_mgzz_abc123 |'
  )
  assert.equal(mergeChanges(one.body, [entry()], opts).added, 0)
  assert.equal(mergeChanges(one.body, [entry()], opts).body, one.body)
  // nothing for previews, things already set, or tasks
  assert.equal(
    mergeChanges(null, [entry({ mode: 'preview', status: 'would-change' })], opts).added,
    0
  )
  assert.equal(mergeChanges(null, [entry({ status: 'already-set' })], opts).added, 0)
  // a change whose outcome is unknown gets a row now, and a result row once the device reports
  const lost = entry({ runId: 'a_lost', status: 'unknown', result: undefined, endedAt: undefined })
  const u = mergeChanges(one.body, [entry(), lost], opts)
  assert.match(u.body, /OUTCOME UNKNOWN: Turn on firewall profiles that are off started/)
  const settled = entry({ runId: 'a_lost', endedAt: '2026-10-20T21:00:00Z' })
  const s = mergeChanges(u.body, [entry(), settled], opts)
  assert.equal(s.added, 1)
  assert.match(
    s.body.split('\n').at(-1)!,
    /^\| 2026-10-20 15:00 .*Result of run a_lost: Firewall Public: off → on .*result a_lost \|$/
  )
  assert.equal(mergeChanges(s.body, [entry(), settled], opts).added, 0)
  // custom commands: listed, never measured, never their text
  const x = mergeChanges(
    null,
    [
      entry({
        runId: 'x_1',
        kind: 'exec',
        title: 'Custom command',
        action: undefined,
        access: undefined,
        scriptSha256: 'b'.repeat(64),
        scriptLines: 3,
        status: 'not-measured',
        result: {
          runId: 'x_1',
          kind: 'exec',
          dryRun: false,
          applied: true,
          exitCode: 0,
          startedAt: ''
        }
      })
    ],
    opts
  )
  assert.match(
    x.body,
    /Custom command \(effect not measured\): sha256 bbbbbbbbbbbb, 3 line\(s\), exit 0 .* Unknown \| Unknown \(custom command\) \|/
  )
})

test('vault: device text cannot break the block, forge a marker or inject Markdown', () => {
  const evil =
    'Public\r<!-- DASH:CHANGES:END -->\u2028```dataviewjs\n[[Secret]] ![[x]] <img src=http://a> %%x%% $y$ #tag ^id | `c`'
  const e = entry({
    result: result({
      after: m(
        [
          ['Firewall Public', evil],
          ['Firewall Domain', 'on']
        ],
        { change: false }
      )
    }),
    reason: evil
  })
  const body = mergeChanges(null, [e], DEFAULT_CONTENT_OPTIONS).body
  const note = setBlock('# ARH Change Log\n', 'CHANGES', body).text
  const block = findBlock(note, 'CHANGES')
  assert.ok(block, 'still exactly one marker pair')
  const row = body.split('\n').at(-1)!
  assert.equal(row.split(/(?<!\\)\|/).length, 9, 'seven cells, no extra pipes')
  assert.ok(!/[\r\n\u2028\u2029]/.test(row), 'no line breaks of any kind')
  // with every backslash escape taken out, no character with a Markdown meaning is left bare
  const bare = row.replace(/\\./g, '')
  for (const bad of ['<', '>', '[', ']', '`', '$', '#', '^', '%%'])
    assert.ok(!bare.includes(bad), `${JSON.stringify(bad)} unescaped in ${row}`)
  assert.equal(vaultText('é'.repeat(300), 10).length, 10)
  assert.ok(!vaultText('\\'.repeat(50), 10).endsWith('\\\\\\'), 'an escape is never cut in half')
  assert.equal([...vaultText('\\'.repeat(50), 10)].filter((c) => c === '\\').length % 2, 0)
})

test('vault: actions join scans in the Work Log, newest first, with what changed', () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const log = mergeLog(null, [], opts, [
    entry(),
    entry({ runId: 'a_older', appliedAt: '2026-10-20T18:00:00Z' })
  ])
  const entries = log.body.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(entries.length, 2)
  assert.equal(
    entries[0],
    '- 2026-10-20 14:05 MT · **ARH-FD01** · serial 5CG1234XYZ · Action: Turn on firewall profiles that are off (windows-firewall-on v1) · changed · Firewall Public: off → on · why: Fix: Firewall profile "Public" is disabled · Lisandro · run a_mgzz_abc123'
  )
  assert.match(entries[1]!, /run a_older$/)
  // a refused request did nothing, so it is not logged
  assert.equal(mergeLog(null, [], opts, [entry({ status: 'refused' })]).added, 0)
})

/* ---------- regressions from the Phase 3 review ---------- */

test('results from a device are checked: wrong types are dropped before anything reads them', () => {
  const evil = '0\n<!-- DASH:SCAN-LOG:END -->\n```dataviewjs\nalert(1)\n```'
  const r = cleanResult(
    {
      runId: 'x_9',
      kind: 'exec',
      dryRun: false,
      applied: true,
      startedAt: '2026-10-20T20:00:00Z',
      exitCode: evil,
      before: { items: 'not a list', exitCode: 0, change: 'yes', warnings: ['ok', 3] },
      extra: { anything: true }
    },
    'x_9'
  )!
  assert.equal(r.exitCode, undefined, 'a non-integer exit code is dropped')
  assert.equal(r.before?.items, null)
  assert.equal(r.before?.change, undefined)
  assert.deepEqual(r.before?.warnings, ['ok'])
  assert.ok(!('extra' in r))
  assert.equal(cleanResult({ ...r, runId: 'other' }, 'x_9'), null, 'another run id')
  assert.equal(cleanResult('a string', 'x_9'), null)
  // a measurement that does not say how it ended counts as failed, never as measured
  assert.equal(cleanResult({ runId: 'a', kind: 'action', after: {} }, 'a')?.after?.exitCode, -1)
  // and the raw exit code never reaches the Work Log
  const e = entry({
    runId: 'x_9',
    kind: 'exec',
    action: undefined,
    title: 'Custom command',
    status: 'failed',
    result: { ...r, exitCode: evil as unknown as number }
  })
  const lines = actionLogEntry(e, DEFAULT_CONTENT_OPTIONS)
  assert.ok(!lines.join('\n').includes('DASH:'), lines.join('\n'))
  assert.ok(!/exit 0/.test(lines[0]!))
})

test('status: an after-measurement that failed, was blocked or skipped an item is "not verified"', () => {
  const failed = result({ after: { items: null, exitCode: 1 } })
  assert.equal(actionStatus(failed), 'not-verified')
  const blocked = result({
    after: { items: null, change: false, exitCode: 0, blockers: ['Defender is not available'] }
  })
  assert.equal(
    actionStatus(blocked),
    'not-verified',
    'no items afterwards is not proof of a change'
  )
  // a blocker afterwards with every item measured is not a failure: Public went on, Group Policy
  // still holds Domain off
  const gpo = result({
    after: m(
      [
        ['Firewall Public', 'on'],
        ['Firewall Domain', 'on']
      ],
      { change: false, blockers: ['Group Policy keeps the Domain profile off'] }
    )
  })
  assert.equal(actionStatus(gpo), 'changed')
  const missing = result({ after: m([['Firewall Public', 'on']], { change: false }) })
  assert.equal(actionStatus(missing), 'not-verified', 'Firewall Domain was not measured afterwards')
  // the agent was stopped mid-apply (its next start reports the run as interrupted)
  const cut = result({
    apply: undefined,
    after: undefined,
    aborted: true,
    error: 'the agent stopped'
  })
  assert.equal(actionStatus(cut), 'not-verified')
  assert.equal(actionStatus({ ...cut, access: 'execute' }), 'not-verified')
  // and the vault says so in those words, never "the result has not come back"
  const e = entry({ status: 'not-verified', result: failed })
  assert.match(whatChanged(e), /^NOT VERIFIED: .* measuring afterwards failed \(exit 1\)/)
  const head = actionLogEntry(e, DEFAULT_CONTENT_OPTIONS)[0]!
  assert.match(head, /not verified: measuring afterwards failed/)
  assert.ok(!/link was lost|has not come back/.test(head), head)
  assert.equal(belongsInChangeLog({ ...e.record, status: 'not-verified' }), true)
})

test('vault: an unknown row gets its result row whatever the run ended as', () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const sfc = {
    runId: 'a_sfc',
    action: 'windows-sfc',
    title: 'Check and repair system files',
    access: 'write' as const
  }
  const lost = entry({ ...sfc, status: 'unknown', result: undefined, endedAt: undefined })
  const one = mergeChanges(null, [lost], opts)
  assert.match(one.body, /OUTCOME UNKNOWN: Check and repair system files started/)
  assert.match(one.body.split('\n').at(-1)!, /· run a_sfc · result pending \|$/)
  // done, no repairs: not a Change Log status, but the unknown row still needs its answer
  const done = entry({
    ...sfc,
    status: 'done',
    result: result({ runId: 'a_sfc', before: m([]), after: undefined })
  })
  const two = mergeChanges(one.body, [done], opts)
  assert.equal(two.added, 1)
  assert.match(two.body.split('\n').at(-1)!, /Result of run a_sfc: Done .*· result a_sfc \|$/)
  assert.equal(mergeChanges(two.body, [done], opts).added, 0)
  // the same for the Work Log
  const log1 = mergeLog(null, [], opts, [lost])
  const log2 = mergeLog(log1.body, [], opts, [done])
  assert.equal(log2.added, 1)
  assert.match(log2.body, /result of run a_sfc .*· done .*· result a_sfc/)
  // a custom command whose outcome was unknown gets its exit code
  const x = { runId: 'x_lost', kind: 'exec' as const, title: 'Custom command', action: undefined }
  const xl = mergeChanges(null, [entry({ ...x, status: 'unknown', result: undefined })], opts)
  assert.match(xl.body, /OUTCOME UNKNOWN: custom command started/)
  const xr = entry({
    ...x,
    status: 'not-measured',
    result: {
      runId: 'x_lost',
      kind: 'exec',
      dryRun: false,
      applied: true,
      startedAt: '',
      exitCode: 0
    }
  })
  assert.match(mergeChanges(xl.body, [xr], opts).body, /Result of run x_lost: .*exit 0/)
})

test("vault: another run's reason that names a run id does not touch that run's rows", () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const a = entry({ runId: 'a_A' })
  const undo = entry({
    runId: 'a_B',
    reason: 'Undo of run a_A: · run a_A · result pending OUTCOME UNKNOWN outcome unknown',
    technician: 'Lisandro · run a_A',
    status: 'unknown',
    result: undefined,
    endedAt: undefined
  })
  const one = mergeChanges(null, [a, undo], opts)
  assert.equal(one.added, 2)
  assert.equal(mergeChanges(one.body, [a, undo], opts).added, 0, 'no result row for a_A')
  const log = mergeLog(null, [], opts, [a, undo])
  assert.equal(mergeLog(log.body, [], opts, [a, undo]).added, 0)
})

test('vault: a padded or realigned Change Log header is still the header', () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const one = mergeChanges(null, [entry()], opts).body
  const padded = one
    .replace(
      '| Timestamp (MT) | System / machine | What changed | Why | Reversible? | Rollback | By |',
      '| Timestamp (MT)   | System / machine   | What changed | Why  | Reversible? | Rollback | By        |'
    )
    .replace(
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| :--- | ---- | ---: | --- | --- | --- | --- |'
    )
  const again = mergeChanges(padded, [entry()], opts)
  assert.equal(again.added, 0)
  assert.equal(again.body.split('\n').filter((l) => l.includes('Timestamp (MT)')).length, 1)
})

test('runner: a run-end after a dashboard restart is recorded and acknowledged once on disk', async () => {
  const h = await harness({ previewFirst: false })
  try {
    const r = h.runner.run(device, {
      deviceId: device.id,
      action: 'windows-dns-flush',
      params: {},
      reason: 'stale names'
    })
    h.runner.handleMessage(device.id, { type: 'run-start', runId: r.runId })
    await h.runner.flush()
    // a new dashboard process: the same log, nothing live
    const log2 = new ActionLog(join(h.dir, 'actions.jsonl'))
    await log2.load()
    const sent: LinkMessage[] = []
    const fresh = new ActionRunner({
      catalog: h.c,
      log: log2,
      slots: new DeviceSlots(),
      send: (_d, msg) => (sent.push(msg), true),
      capabilities: () => h.caps(),
      settings: () => ({ ...DEFAULT_SETTINGS, technician: 'Lisandro' })
    })
    fresh.handleMessage(device.id, {
      type: 'run-end',
      runId: r.runId,
      ok: true,
      result: result({ runId: r.runId, access: 'execute', action: 'windows-dns-flush' })
    })
    await fresh.flush()
    await new Promise((res) => setImmediate(res))
    assert.equal(fresh.get(r.runId)?.status, 'done')
    assert.ok(sent.some((x) => x.type === 'ack' && x['runId'] === r.runId))
    fresh.stop()
  } finally {
    await h.done()
  }
})

test('runner: a result is never acknowledged when it could not be written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-noack-'))
  try {
    await writeFile(join(dir, 'blocker'), 'a file where the log folder should be')
    const c = await catalog()
    const sent: LinkMessage[] = []
    const runner = new ActionRunner({
      catalog: c,
      log: new ActionLog(join(dir, 'blocker', 'actions.jsonl')),
      slots: new DeviceSlots(),
      send: (_d, msg) => (sent.push(msg), true),
      capabilities: () => undefined,
      settings: () => DEFAULT_SETTINGS,
      device: () => device
    })
    runner.handleMessage(device.id, {
      type: 'result',
      runId: 'a_orphan',
      result: result({ runId: 'a_orphan', access: 'execute', action: 'windows-dns-flush' })
    })
    await runner.flush()
    await new Promise((res) => setTimeout(res, 20))
    assert.ok(!sent.some((x) => x.type === 'ack'), 'the agent keeps it and sends it again')
    runner.stop()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runner: a result with no request on record is kept as such, not dropped', async () => {
  const h = await harness()
  try {
    const id = 'a_mgzz0000_0a0b0c' // the form of an id this dashboard makes
    h.runner.handleMessage(device.id, {
      type: 'result',
      runId: id,
      result: result({ runId: id, access: 'execute', action: 'windows-dns-flush' })
    })
    await h.runner.flush()
    await new Promise((res) => setImmediate(res))
    const rec = h.runner.get(id)
    assert.equal(rec?.status, 'done')
    assert.equal(rec?.title, h.c.get('windows-dns-flush')?.title)
    assert.match(rec?.reason ?? '', /no request for this run is on record/)
    assert.ok(h.sent.some((x) => x.type === 'ack' && x['runId'] === id))
  } finally {
    await h.done()
  }
})

test("runner: a device reporting another device's run id cannot replace or end that run", async () => {
  const h = await harness({ previewFirst: false })
  try {
    const r = h.runner.run(device, {
      deviceId: device.id,
      action: 'windows-dns-flush',
      params: {},
      reason: 'stale names'
    })
    h.runner.handleMessage(device.id, { type: 'run-start', runId: r.runId })
    h.runner.handleMessage('other-device-id', {
      type: 'run-end',
      runId: r.runId,
      ok: true,
      result: result({ runId: r.runId, access: 'execute', action: 'windows-dns-flush' })
    })
    await h.runner.flush()
    assert.equal(h.runner.get(r.runId)?.status, 'running', 'the real run is untouched')
    assert.equal(h.runner.get(r.runId)?.deviceId, device.id)
    assert.equal(h.runner.get(`${r.runId}~other-de`)?.deviceId, 'other-device-id')
  } finally {
    await h.done()
  }
})

test('runner: an old "link lost" or "no answer" error does not outlive the run coming back', async () => {
  const h = await harness({ previewFirst: false })
  try {
    const r = h.runner.run(device, {
      deviceId: device.id,
      action: 'windows-defender-update',
      params: {},
      reason: 'old signatures'
    })
    h.runner.handleMessage(device.id, { type: 'run-start', runId: r.runId })
    h.runner.handleMessage(device.id, { type: 'check-start', runId: r.runId, checkId: 'apply' })
    h.runner.deviceLost(device.id)
    assert.match(h.runner.get(r.runId)?.error ?? '', /link was lost/)
    h.setCaps({ ...h.caps(), running: r.runId })
    h.runner.deviceConnected(device.id)
    assert.equal(h.runner.get(r.runId)?.error, undefined)
    h.runner.handleMessage(device.id, {
      type: 'run-end',
      runId: r.runId,
      ok: false,
      result: result({
        runId: r.runId,
        access: 'execute',
        action: 'windows-defender-update',
        apply: { items: null, exitCode: 2 }
      })
    })
    const rec = h.runner.get(r.runId)!
    assert.equal(rec.status, 'failed')
    assert.equal(rec.error, undefined)
    const sub = actionLogEntry({ record: rec }, DEFAULT_CONTENT_OPTIONS).slice(1).join('\n')
    assert.ok(!/link was lost/.test(sub), sub)
  } finally {
    await h.done()
  }
})

test('runner: reason and name limits are counted in bytes, as the agent counts them', async () => {
  const h = await harness({ previewFirst: false })
  try {
    const req = { deviceId: device.id, action: 'windows-dns-flush', params: {} }
    const arrows = `${'→'.repeat(110)}${'x'.repeat(190)}` // 300 characters, 520 bytes
    assert.equal(arrows.length, 300)
    assert.throws(() => h.runner.run(device, { ...req, reason: arrows }), /reason is too long/)
    assert.throws(() => h.runner.preview(device, { ...req, reason: arrows }), /reason is too long/)
    h.setSettings({ technician: 'é'.repeat(60) }) // 120 bytes
    assert.throws(
      () => h.runner.run(device, { ...req, reason: 'ok' }),
      /technician name .* too long/
    )
    // the vault keeps a reason the agent accepts whole
    const long = 'r'.repeat(480)
    const row = mergeChanges(null, [entry({ reason: long })], DEFAULT_CONTENT_OPTIONS).body
    assert.ok(row.includes(long))
  } finally {
    await h.done()
  }
})

test('action log: a line cut short by a power cut does not swallow the next record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-torn-'))
  try {
    const file = join(dir, 'actions.jsonl')
    const one = new ActionLog(file)
    await one.load()
    await one.append('request', entry({ runId: 'a_1' }).record)
    await appendFile(file, '{"ts":"2026-10-20T20:00:00Z","event":"upd') // torn, no newline
    const two = new ActionLog(file)
    await two.load()
    await two.append('request', entry({ runId: 'a_2' }).record)
    await two.append('request', entry({ runId: 'a_3' }).record)
    const three = new ActionLog(file)
    await three.load()
    assert.ok(three.get('a_2'), 'the record after the torn line is kept')
    assert.ok(three.get('a_3'))
    assert.deepEqual((await three.verify()).broken, [2], 'only the torn fragment is flagged')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------- regressions from the second Phase 3 review ---------- */

const acks = (sent: LinkMessage[]): unknown[] =>
  sent.filter((x) => x.type === 'ack').map((x) => x['runId'])

test("runner: a device's run id and action cannot forge a marker, a block, a link or another run's rows", async () => {
  const h = await harness()
  try {
    const opts = DEFAULT_CONTENT_OPTIONS
    const real = 'a_mgzz0001_abc123'
    const fence =
      'z1\n<!-- DASH:SCAN-LOG:END -->\n<!-- DASH:CHANGES:END -->\n```dataviewjs\nalert(1)\n```'
    const wire = [fence, `n · run ${real}`, `n · result ${real}`]
    const sentBy = (runId: string): AgentResult =>
      result({ runId, action: 'x) `$1+1$` [[Secret]] <b>' })
    const orphans: ActionEntry[] = []
    for (const runId of wire) {
      const seen = new Set(h.runner.list().map((r) => r.runId))
      h.runner.handleMessage(device.id, { type: 'result', runId, result: sentBy(runId) })
      const rec = h.runner.list().find((r) => !seen.has(r.runId))!
      assert.match(rec.runId, /^d_[0-9a-f]{16}$/, 'kept under an id the dashboard made')
      assert.equal(rec.deviceRunId, runId, 'what the device sent stays in the action log')
      orphans.push({ record: rec })
    }
    await h.runner.flush()
    await new Promise((res) => setImmediate(res))
    assert.deepEqual(acks(h.sent), wire, 'acknowledged by the id the device sent')
    // the same result sent again is the same record, acknowledged again
    h.runner.handleMessage(device.id, { type: 'result', runId: fence, result: sentBy(fence) })
    await h.runner.flush()
    await new Promise((res) => setImmediate(res))
    assert.equal(h.runner.list().length, 3)
    assert.equal(acks(h.sent).length, 4)
    // and after the dashboard restarts
    const log2 = new ActionLog(join(h.dir, 'actions.jsonl'))
    await log2.load()
    const sent2: LinkMessage[] = []
    const fresh = new ActionRunner({
      catalog: h.c,
      log: log2,
      slots: new DeviceSlots(),
      send: (_d, msg) => (sent2.push(msg), true),
      capabilities: () => h.caps(),
      settings: () => ({ ...DEFAULT_SETTINGS, technician: 'Lisandro' })
    })
    fresh.handleMessage(device.id, { type: 'result', runId: fence, result: sentBy(fence) })
    assert.deepEqual(acks(sent2), [fence])
    assert.equal(fresh.list().length, 3)
    fresh.stop()

    // the real run comes later: its row, and its result row, are still added
    const lost = entry({ runId: real, status: 'unknown', result: undefined, endedAt: undefined })
    const settled = entry({ runId: real })
    const c1 = mergeChanges(null, orphans, opts)
    assert.equal(c1.added, 3)
    const c2 = mergeChanges(c1.body, [...orphans, lost], opts)
    assert.equal(c2.added, 1, "an orphan's row is not taken for the real run's")
    const c3 = mergeChanges(c2.body, [...orphans, settled], opts)
    assert.equal(c3.added, 1, "an orphan's row is not taken for the real run's result row")
    const l1 = mergeLog(null, [], opts, orphans)
    const l2 = mergeLog(l1.body, [], opts, [...orphans, lost])
    assert.equal(l2.added, 1)
    const l3 = mergeLog(l2.body, [], opts, [...orphans, settled])
    assert.equal(l3.added, 1)
    for (const [key, body] of [
      ['CHANGES', c3.body],
      ['SCAN-LOG', l3.body]
    ] as const) {
      const note = setBlock('# Note\n', key, body).text
      assert.doesNotThrow(() => findBlock(note, key), 'still exactly one marker pair')
      const lines = note.split('\n')
      assert.equal(lines.filter((l) => l.includes('DASH:')).length, 2, note)
      assert.ok(!lines.some((l) => l.trimStart().startsWith('```')), `no code block in ${note}`)
      const bare = body.replace(/\\./g, '')
      assert.ok(!bare.includes('[[Secret') && !bare.includes('`'), `no link or code in ${body}`)
    }
  } finally {
    await h.done()
  }
})

test('runner: a result whose write failed is written when the device sends it again, then acknowledged', async () => {
  const h = await harness({ previewFirst: false })
  try {
    const file = join(h.dir, 'actions.jsonl')
    const r = h.runner.run(device, {
      deviceId: device.id,
      action: 'windows-dns-flush',
      params: {},
      reason: 'stale names'
    })
    h.runner.handleMessage(device.id, { type: 'run-start', runId: r.runId })
    await h.runner.flush()
    const sent = result({ runId: r.runId, access: 'execute', action: 'windows-dns-flush' })
    const settle = async (): Promise<void> => {
      await h.runner.flush()
      await new Promise((res) => setImmediate(res))
    }
    // the disk refuses the result line (full, or held by an antivirus scan)
    await rename(file, `${file}.keep`)
    await mkdir(file)
    h.runner.handleMessage(device.id, { type: 'run-end', runId: r.runId, ok: true, result: sent })
    await settle()
    assert.deepEqual(acks(h.sent), [], 'not written, so not acknowledged')
    h.runner.handleMessage(device.id, { type: 'result', runId: r.runId, result: sent })
    await settle()
    assert.deepEqual(acks(h.sent), [], 'sent again while the disk still refuses: still not')
    // the disk is back: the next replay is written first, then acknowledged
    await rmdir(file)
    await rename(`${file}.keep`, file)
    h.runner.handleMessage(device.id, { type: 'result', runId: r.runId, result: sent })
    assert.deepEqual(acks(h.sent), [], 'not before its line is written')
    await settle()
    assert.deepEqual(acks(h.sent), [r.runId])
    const after = new ActionLog(file)
    await after.load()
    assert.equal(after.get(r.runId)?.status, 'done')
    assert.ok(after.get(r.runId)?.result, 'the result is on disk')
    // after a restart, a result already on disk is acknowledged at once, with no new line
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).length
    const sent2: LinkMessage[] = []
    const fresh = new ActionRunner({
      catalog: h.c,
      log: after,
      slots: new DeviceSlots(),
      send: (_d, msg) => (sent2.push(msg), true),
      capabilities: () => h.caps(),
      settings: () => ({ ...DEFAULT_SETTINGS, technician: 'Lisandro' })
    })
    fresh.handleMessage(device.id, { type: 'result', runId: r.runId, result: sent })
    assert.deepEqual(acks(sent2), [r.runId])
    await fresh.flush()
    assert.equal((await readFile(file, 'utf8')).split('\n').filter(Boolean).length, lines)
    fresh.stop()
  } finally {
    await h.done()
  }
})

test('runner: a result sent again while its first line is still being written waits for a line on disk', async () => {
  const h = await harness({ previewFirst: false })
  try {
    const r = h.runner.run(device, {
      deviceId: device.id,
      action: 'windows-dns-flush',
      params: {},
      reason: 'stale names'
    })
    h.runner.handleMessage(device.id, { type: 'run-start', runId: r.runId })
    await h.runner.flush()
    const sent = result({ runId: r.runId, access: 'execute', action: 'windows-dns-flush' })
    h.runner.handleMessage(device.id, { type: 'run-end', runId: r.runId, ok: true, result: sent })
    h.runner.handleMessage(device.id, { type: 'result', runId: r.runId, result: sent })
    assert.deepEqual(acks(h.sent), [], 'nothing is on disk yet')
    await h.runner.flush()
    await new Promise((res) => setImmediate(res))
    assert.deepEqual(acks(h.sent), [r.runId, r.runId])
  } finally {
    await h.done()
  }
})

test('runner: a device time that does not parse is dropped and can never stop a vault write', async () => {
  const bad = cleanResult(
    {
      runId: 'a',
      kind: 'action',
      startedAt: 'yesterday',
      appliedAt: 'not a time',
      endedAt: '2026-13-45'
    },
    'a'
  )!
  assert.equal(bad.startedAt, '')
  assert.equal(bad.appliedAt, undefined)
  assert.equal(bad.endedAt, undefined)
  const good = cleanResult(result({ appliedAt: '2026-10-20T20:05:00Z' }), 'a_1')!
  assert.equal(good.startedAt, '2026-10-20T20:05:00Z')
  assert.equal(good.appliedAt, '2026-10-20T20:05:00Z')
  const opts = DEFAULT_CONTENT_OPTIONS
  const h = await harness()
  try {
    const id = 'a_mgzz0002_0a0b0c'
    h.runner.handleMessage(device.id, {
      type: 'result',
      runId: id,
      result: result({ runId: id, startedAt: 'yesterday', appliedAt: 'not a time' })
    })
    const rec = h.runner.get(id)!
    assert.equal(rec.requestedAt, '2026-10-20T20:00:00.000Z', "the dashboard's clock instead")
    assert.equal(rec.appliedAt, undefined)
    assert.match(mergeChanges(null, [{ record: rec }], opts).body, /\| 2026-10-20 14:00 \|/)
    assert.match(mergeLog(null, [], opts, [{ record: rec }]).body, /- 2026-10-20 14:00 MT · /)
  } finally {
    await h.done()
  }
  // a record an older build kept with such times still lets every other row be written
  const old = entry({
    runId: 'a_old',
    requestedAt: 'yesterday',
    startedAt: undefined,
    appliedAt: 'not a time'
  })
  const changes = mergeChanges(null, [old, entry()], opts)
  assert.equal(changes.added, 2)
  assert.match(changes.body, /\| time unknown \| .* run a_old \|/)
  const log = mergeLog(null, [], opts, [old, entry()])
  assert.equal(log.added, 2)
  assert.match(log.body, /- time unknown · .* run a_old$/m)
  // the last time a date can hold reads as one, but has no hour after it
  const edge = entry({ runId: 'a_edge', appliedAt: '+275760-09-13T00:00:00.000Z' })
  assert.equal(
    cleanResult(result({ appliedAt: edge.record.appliedAt }), 'a_1')?.appliedAt,
    edge.record.appliedAt
  )
  assert.equal(mergeChanges(null, [edge], opts).added, 1)
  assert.equal(mergeLog(null, [], opts, [edge]).added, 1)
})

test('action log: a write that failed part way does not glue the next record onto its fragment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-torn-'))
  try {
    const file = join(dir, 'actions.jsonl')
    const log = new ActionLog(file)
    await log.load()
    await log.append('request', entry({ runId: 'a_1' }).record)
    // the write fails (here the path is briefly a folder) ...
    await rename(file, `${file}.keep`)
    await mkdir(file)
    await assert.rejects(log.append('result', entry({ runId: 'a_2' }).record))
    await rmdir(file)
    await rename(`${file}.keep`, file)
    // ... after part of its line reached the file, as on a full disk
    await appendFile(file, '{"ts":"2026-10-20T20:05:00Z","event":"res')
    await log.append('result', entry({ runId: 'a_3' }).record)
    const again = new ActionLog(file)
    await again.load()
    assert.ok(again.get('a_3'), 'the record after the failed write is kept')
    assert.deepEqual((await again.verify()).broken, [2], 'only the fragment is flagged')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runner: a result is acknowledged only after its line is synced to the disk', async () => {
  const h = await harness({ previewFirst: false })
  const probe = await open(join(h.dir, 'probe'), 'w')
  const proto = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  const order: string[] = []
  const original = proto.datasync
  const sync = mock.method(proto, 'datasync', function (this: FileHandle) {
    order.push(acks(h.sent).length ? 'sync after the ack' : 'sync')
    return original.call(this)
  })
  try {
    const r = h.runner.run(device, {
      deviceId: device.id,
      action: 'windows-dns-flush',
      params: {},
      reason: 'stale names'
    })
    await h.runner.flush()
    order.length = 0
    h.runner.handleMessage(device.id, {
      type: 'run-end',
      runId: r.runId,
      ok: true,
      result: result({ runId: r.runId, access: 'execute', action: 'windows-dns-flush' })
    })
    await h.runner.flush()
    await new Promise((res) => setImmediate(res))
    assert.deepEqual(acks(h.sent), [r.runId])
    assert.deepEqual(order, ['sync'], 'the result line was synced, before the ack')
  } finally {
    sync.mock.restore()
    await h.done()
  }
})

test('runner: a custom command with no request on record keeps the script hash and size it reported', async () => {
  const h = await harness()
  try {
    const exec = (runId: string, sha256: string): AgentResult => ({
      runId,
      kind: 'exec',
      dryRun: false,
      applied: true,
      exitCode: 0,
      sha256,
      lines: 4,
      startedAt: '2026-10-20T20:05:00Z',
      appliedAt: '2026-10-20T20:05:00Z'
    })
    const id = 'x_mgzz0003_0c0d0e'
    h.runner.handleMessage(device.id, {
      type: 'result',
      runId: id,
      result: exec(id, 'c'.repeat(64))
    })
    const rec = h.runner.get(id)!
    assert.equal(rec.scriptSha256, 'c'.repeat(64))
    assert.equal(rec.scriptLines, 4)
    assert.equal(rec.sha256, undefined, "the action file's hash field is not the script's")
    assert.match(whatChanged({ record: rec }), /sha256 cccccccccccc, 4 line\(s\), exit 0$/)
    assert.match(
      actionLogEntry({ record: rec }, DEFAULT_CONTENT_OPTIONS)[0]!,
      /Custom command \(sha256 cccccccccccc, 4 line\(s\)\)/
    )
    const id2 = 'x_mgzz0004_0c0d0f'
    h.runner.handleMessage(device.id, {
      type: 'result',
      runId: id2,
      result: exec(id2, 'not a hash')
    })
    assert.equal(h.runner.get(id2)?.scriptSha256, undefined, 'only a SHA-256 is taken as one')
  } finally {
    await h.done()
  }
})

test('vault: a real run that was skipped (already set, blocked, measure failed) lists no item as changed', () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const skipped = { applied: false, apply: undefined, after: undefined }
  const set = entry({
    status: 'already-set',
    result: result({
      ...skipped,
      before: m(
        [
          ['Firewall Domain', 'on'],
          ['Firewall Private', 'on'],
          ['Firewall Public', 'on']
        ],
        { change: false }
      )
    })
  })
  const blocked = entry({
    status: 'blocked',
    result: result({
      ...skipped,
      before: m([['Service x.service', 'inactive']], { change: true, blockers: ['masked'] })
    })
  })
  const failed = entry({
    status: 'failed',
    result: result({
      ...skipped,
      before: m([['Service x.service', 'inactive']], { exitCode: 1 })
    })
  })
  assert.equal(actionStatus(set.record.result), 'already-set')
  assert.equal(actionStatus(blocked.record.result), 'blocked')
  assert.equal(actionStatus(failed.record.result), 'failed')
  for (const [e, label] of [
    [set, 'already set'],
    [blocked, 'blocked'],
    [failed, 'failed']
  ] as const) {
    const head = actionLogEntry(e, opts)[0]!
    assert.ok(!head.includes('(not measured)'), head)
    assert.match(head, new RegExp(` · ${label} · why: `))
  }
})

/* ---------- regressions from verifying the second review's fixes ---------- */

function scan(over: Partial<ScanRun> = {}): ScanRun {
  return {
    runId: 'r_mgzz0000_abcdef',
    deviceId: device.id,
    serial: device.serial,
    hostname: device.hostname,
    os: 'windows',
    purpose: 'security-check',
    profile: 'windows-security-check',
    version: 1,
    title: 'Security Check',
    technician: 'Lisandro',
    startedAt: '2026-10-20T20:10:00.000Z',
    finishedAt: '2026-10-20T20:15:00.000Z',
    status: 'ok',
    checks: [],
    durationMs: 300_000,
    health: { score: 'healthy', metrics: {}, findings: [] },
    ...over
  }
}

test('vault: a device value that names a scan run cannot keep that scan out of the Work Log', async () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const target = scan()
  const named = `run ${target.runId}`
  const own = (body: string): string[] =>
    body.split('\n').filter((l) => l.startsWith('- ') && l.endsWith(` · ${named}`))
  const h = await harness()
  try {
    // the device was sent scan r_…; before it ends, it reports a run nobody asked for that
    // names the scan in every value it controls
    const id = 'a_mgzz0001_0a0b0c'
    h.runner.handleMessage(device.id, {
      type: 'result',
      runId: id,
      result: result({
        runId: id,
        action: named,
        before: m([[`x · ${named}`, 'off']], { change: true }),
        apply: { items: null, exitCode: 0, changes: [`· ${named}`], warnings: [named] },
        after: m([[`x · ${named}`, 'on']])
      })
    })
    await h.runner.flush()
    await new Promise((res) => setImmediate(res))
    const orphan: ActionEntry = { record: h.runner.get(id)! }
    // so does another scan's device text (its name, and the error it ended with)
    const other = scan({
      runId: 'r_mgzz0002_fedcba',
      hostname: `x · ${named}`,
      status: 'failed',
      error: `· ${named}`
    })
    const first = mergeLog(null, [other], opts, [orphan])
    assert.equal(first.added, 2)
    assert.ok(first.body.split('\n').filter((l) => l.includes(named)).length >= 3, first.body)
    assert.deepEqual(own(first.body), [], first.body)
    const second = mergeLog(first.body, [other, target], opts, [orphan])
    assert.equal(second.added, 1, 'the scan is still logged')
    assert.equal(own(second.body).length, 1, second.body)
    assert.equal(mergeLog(second.body, [other, target], opts, [orphan]).added, 0, 'and once')
  } finally {
    await h.done()
  }
})

test('action log: a line written whole whose sync or close failed still chains the next line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-syncfail-'))
  const probe = await open(join(dir, 'probe'), 'w')
  const proto = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  const eio = (call: string): Error =>
    Object.assign(new Error(`EIO: i/o error, ${call}`), { code: 'EIO' })
  const fail = { sync: false, close: false }
  const datasync = proto.datasync
  const syncMock = mock.method(proto, 'datasync', async function (this: FileHandle) {
    if (fail.sync) {
      fail.sync = false
      throw eio('fdatasync')
    }
    await datasync.call(this)
    if (!fail.close) return
    fail.close = false
    const close = this.close // each handle has its own
    this.close = async () => {
      await close.call(this)
      throw eio('close')
    }
  })
  try {
    const file = join(dir, 'actions.jsonl')
    const log = new ActionLog(file)
    await log.load()
    await log.append('request', entry({ runId: 'a_1' }).record)
    // the whole line reaches the file, but the sync after it fails: not known to be on disk
    fail.sync = true
    await assert.rejects(log.append('result', entry({ runId: 'a_2' }).record), { code: 'EIO' })
    assert.equal(log.resultOnDisk('a_2'), false, 'written again when the device sends it again')
    // synced, but closing the file fails: on disk
    fail.close = true
    await assert.rejects(log.append('result', entry({ runId: 'a_3' }).record), { code: 'EIO' })
    assert.equal(log.resultOnDisk('a_3'), true)
    await log.append('result', entry({ runId: 'a_4' }).record)
    const text = await readFile(file, 'utf8')
    assert.ok(!text.includes('\n\n'), 'no blank line: nothing was cut short')
    const again = new ActionLog(file)
    await again.load()
    for (const id of ['a_1', 'a_2', 'a_3', 'a_4']) assert.ok(again.get(id), id)
    assert.deepEqual(await again.verify(), { lines: 4, broken: [] }, 'no false sign of tampering')
  } finally {
    syncMock.mock.restore()
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------- regressions from verifying the fixes to those regressions ---------- */

test('vault: a Work Log entry the technician linked to in Obsidian is still found as its own', () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const target = scan()
  const id = 'a_mgzz0003_0d0e0f'
  const lost = entry({ runId: id, status: 'unknown', result: undefined, endedAt: undefined })
  const settled = entry({ runId: id })
  const done = entry({ runId: 'a_mgzz0004_101112' })
  // "Copy link to block" in Obsidian ends the entry's first line with " ^" and a block id
  let n = 0
  const link = (body: string): string =>
    body
      .split('\n')
      .map((l) => (l.startsWith('- ') && !/\^[\w-]+$/.test(l) ? `${l} ^b${++n}-x` : l))
      .join('\n')
  const first = mergeLog(null, [target], opts, [lost, done])
  assert.equal(first.added, 3)
  const second = mergeLog(link(first.body), [target], opts, [settled, done])
  assert.equal(
    second.added,
    1,
    `only the result of the run whose outcome was unknown: ${second.body}`
  )
  const third = mergeLog(link(second.body), [target], opts, [settled, done])
  assert.equal(third.added, 0, third.body)
  assert.equal(third.body.split('\n').filter((l) => l.startsWith('- ')).length, 4)
  assert.equal(third.body.split('\n').filter((l) => / \^b\d-x$/.test(l)).length, 4, 'links kept')
})

test('vault: a device value cannot open a code block with tildes or strike text through', async () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const fenced = ['~~~dataviewjs', '~~~tasks', '~~~~']
  const normal = entry({
    runId: 'a_mgzz0005_aaaaaa',
    result: result({
      apply: { items: null, exitCode: 0, changes: fenced, warnings: ['~~struck~~'] }
    })
  })
  const failed = entry({ runId: 'a_mgzz0006_bbbbbb', status: 'failed', error: '~~~tasks' })
  const h = await harness()
  try {
    // and one no request is on record for
    h.runner.handleMessage(device.id, {
      type: 'result',
      runId: '~~~dataviewjs',
      result: result({
        runId: '~~~dataviewjs',
        action: '~~~tasks',
        apply: { items: null, exitCode: 0, changes: fenced }
      })
    })
    await h.runner.flush()
    await new Promise((res) => setImmediate(res))
    const orphan: ActionEntry = { record: h.runner.list().find((r) => r.runId.startsWith('d_'))! }
    const entries = [normal, failed, orphan]
    for (const [key, body] of [
      ['SCAN-LOG', mergeLog(null, [], opts, entries).body],
      ['CHANGES', mergeChanges(null, entries, opts).body]
    ] as const) {
      assert.ok(body.includes('\\~\\~\\~dataviewjs'), body)
      assert.ok(!/(^|[^\\])~/.test(body), `every tilde escaped in ${body}`)
      const note = setBlock('# Note\n', key, body).text + '\n## After\n\nNotes.\n'
      const code: Block[] = []
      const walk = (bs: Block[]): void => {
        for (const b of bs) {
          if (b.t === 'code') code.push(b)
          if (b.t === 'list') for (const it of b.items) walk(it.c)
          if (b.t === 'quote' || b.t === 'callout') walk(b.c)
        }
      }
      walk(parseMarkdown(note).blocks)
      assert.deepEqual(code, [], `no code block in ${note}`)
      assert.ok(note.includes('## After'))
    }
    assert.equal(vaultText('~~~tasks ~~x~~'), '\\~\\~\\~tasks \\~\\~x\\~\\~')
  } finally {
    await h.done()
  }
})

test('action log: a failed write that left its whole line but not the newline still chains the next', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-torn-exact-'))
  const probe = await open(join(dir, 'probe'), 'w')
  const proto = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  // what reaches the file before the disk fills: all but the newline, nothing, or part of the line
  let fail: 'newline' | 'nothing' | 'part' | null = null
  const appendFile = proto.appendFile
  const enospc = (): Error =>
    Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
  const writeMock = mock.method(
    proto,
    'appendFile',
    async function (this: FileHandle, data: string, options: BufferEncoding) {
      const how = fail
      fail = null
      if (!how) return appendFile.call(this, data, options)
      if (how === 'newline') await appendFile.call(this, data.slice(0, -1), options)
      if (how === 'part') await appendFile.call(this, data.slice(0, data.length >> 1), options)
      throw enospc()
    }
  )
  try {
    const file = join(dir, 'actions.jsonl')
    const log = new ActionLog(file)
    await log.load()
    await log.append('request', entry({ runId: 'a_1' }).record)
    fail = 'newline'
    await assert.rejects(log.append('result', entry({ runId: 'a_2' }).record), { code: 'ENOSPC' })
    assert.equal(log.resultOnDisk('a_2'), false, 'not synced: written again when sent again')
    await log.append('result', entry({ runId: 'a_3' }).record)
    fail = 'nothing'
    await assert.rejects(log.append('result', entry({ runId: 'a_4' }).record), { code: 'ENOSPC' })
    await log.append('result', entry({ runId: 'a_5' }).record)
    fail = 'part'
    await assert.rejects(log.append('result', entry({ runId: 'a_6' }).record), { code: 'ENOSPC' })
    await log.append('result', entry({ runId: 'a_7' }).record)
    const again = new ActionLog(file)
    await again.load()
    for (const id of ['a_1', 'a_2', 'a_3', 'a_5', 'a_7']) assert.ok(again.get(id), id)
    assert.deepEqual(
      await again.verify(),
      { lines: 6, broken: [5] },
      'only the fragment is flagged, not the whole lines after a failed write'
    )
    const text = await readFile(file, 'utf8')
    assert.ok(!text.includes('\n\n'), 'a line starts on its own line, with no blank line before it')
  } finally {
    writeMock.mock.restore()
    await rm(dir, { recursive: true, force: true })
  }
})
