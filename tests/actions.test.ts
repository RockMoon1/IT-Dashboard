import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  actionStatus,
  belongsInChangeLog,
  changedItems,
  checkParam,
  type ActionRecord,
  type AgentResult
} from '../src/shared/actions.ts'
import { DEFAULT_SETTINGS } from '../src/shared/settings-defaults.ts'
import type { DeviceCapabilities, Settings } from '../src/shared/types.ts'
import { ActionCatalog } from '../src/main/services/actions/catalog.ts'
import { ActionLog } from '../src/main/services/actions/log.ts'
import { ActionRunner, policyBlocks } from '../src/main/services/actions/runner.ts'
import { DeviceSlots } from '../src/main/services/link/slots.ts'
import { capabilitiesOf } from '../src/main/services/link/server.ts'
import type { LinkMessage } from '../src/main/services/link/ndjson.ts'
import type { EnrolledDevice } from '../src/main/services/link/devices.ts'
import {
  DEFAULT_CONTENT_OPTIONS,
  mergeChanges,
  mergeLog,
  vaultText,
  type ActionEntry
} from '../src/main/services/vault/content.ts'
import { findBlock, setBlock } from '../src/main/services/vault/markers.ts'

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
  assert.equal(actionStatus(result({ after: { items: null, exitCode: 1 } })), 'unknown')
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
