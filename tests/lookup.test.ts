import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile, unlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultIndex, parseFrontmatter } from '../src/main/services/lookup/vaultindex.ts'
import {
  buildComputers,
  buildProfile,
  inventoryRows,
  lookup,
  metricSeries,
  noteRoles,
  rankComputers,
  summarize,
  termRegex
} from '../src/main/services/lookup/computers.ts'
import { evaluateHealth } from '../src/main/services/scans/health.ts'
import { DEFAULT_SETTINGS } from '../src/main/services/settings.ts'
import type { ScanRun } from '../src/shared/types.ts'
import type { EnrolledDevice } from '../src/main/services/link/devices.ts'

const SOURCE = join(import.meta.dirname, 'fixtures', 'vault', 'ARH IT')

async function copyVault(): Promise<{ vault: string; done: () => Promise<void> }> {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-lookup-'))
  const vault = join(tmp, 'ARH IT')
  await cp(SOURCE, vault, { recursive: true })
  return { vault, done: () => rm(tmp, { recursive: true, force: true }) }
}

const device: EnrolledDevice = {
  id: 'fp-t01',
  serial: 'SN-T01',
  hostname: 'ARH-T01',
  os: 'windows',
  displayName: 'Front desk laptop',
  enrolledAt: '2026-10-01T15:00:00.000Z',
  lastSeen: '2026-10-14T16:00:00.000Z',
  agentVersion: '0.2.0',
  profiles: []
}

function run(
  id: string,
  at: string,
  values: Record<string, number>,
  findings: NonNullable<ScanRun['health']>['findings'],
  profile = 'windows-security-check'
): ScanRun {
  return {
    runId: id,
    deviceId: 'fp-t01',
    serial: 'SN-T01',
    hostname: 'ARH-T01',
    os: 'windows',
    purpose: profile === 'windows-security-check' ? 'security-check' : 'hardware-issues',
    profile,
    version: 1,
    title: 'Scan',
    technician: 'Lisandro',
    startedAt: at,
    finishedAt: at,
    status: 'ok',
    checks: [],
    durationMs: 60000,
    health: {
      score: findings.some((f) => f.severity === 'critical')
        ? 'critical'
        : findings.length
          ? 'attention'
          : 'healthy',
      metrics: { Model: 'Dell Inc. Latitude 3510', 'Defender AV': 'enabled' },
      values,
      findings
    }
  }
}

const disk = (pct: number) => ({
  id: `d${pct}`,
  severity: 'warning' as const,
  category: 'Storage',
  message: `Disk C: has ${pct}% free`,
  loop: true
})

test('vault index: reads every note once, re-reads only what changed, forgets deleted notes', async () => {
  const { vault, done } = await copyVault()
  try {
    const index = new VaultIndex({ maxAgeMs: 0 })
    const first = await index.notes(vault)
    assert.ok(first.length >= 10)
    const ticket = first.find((n) => n.name.startsWith('Ticket — ARH-T01'))!
    assert.equal(ticket.folder, 'Tickets')
    assert.equal(ticket.frontmatter['id'], 'TKT-2026-901')
    assert.match(ticket.title, /^TKT-2026-901/)
    const hub = first.find((n) => n.name === 'ARH IT Hub')!
    assert.equal(hub.lines[0], '# ARH IT Hub', 'CRLF notes split cleanly')

    const again = await index.notes(vault)
    assert.equal(
      again.find((n) => n.name === 'ARH IT Hub'),
      hub,
      'unchanged notes come from the cache'
    )

    await writeFile(join(vault, 'Reference', 'Loaner notes.md'), '# Loaner notes\n\n- changed\n')
    await unlink(join(vault, 'Runbooks', 'Printer runbook.md'))
    await mkdir(join(vault, '.obsidian'), { recursive: true })
    await writeFile(join(vault, '.obsidian', 'hidden.md'), 'ARH-T01')
    const third = await index.notes(vault)
    assert.equal(third.find((n) => n.name === 'Loaner notes')?.lines[2], '- changed')
    assert.ok(!third.some((n) => n.name === 'Printer runbook'))
    assert.ok(!third.some((n) => n.rel.includes('.obsidian')), 'hidden folders are skipped')

    const cached = new VaultIndex({ maxAgeMs: 60_000 })
    await cached.notes(vault)
    await writeFile(join(vault, 'Reference', 'New.md'), '# New\n')
    assert.ok(!(await cached.notes(vault)).some((n) => n.name === 'New'), 'within maxAge: cache')
    assert.ok(
      (await cached.notes(vault, true)).some((n) => n.name === 'New'),
      'force refresh'
    )

    const missing = new VaultIndex()
    assert.deepEqual(await missing.notes(join(vault, 'nope')), [])
    assert.match(missing.error ?? '', /not readable/)
  } finally {
    await done()
  }
})

test('frontmatter and term matching follow the vault: whole words, exact case for a bare word', () => {
  assert.deepEqual(parseFrontmatter(['---', 'id: TKT-1', 'priority: 🟡 Normal', '---', '# x']), {
    id: 'TKT-1',
    priority: '🟡 Normal'
  })
  assert.deepEqual(parseFrontmatter(['# no frontmatter']), {})
  const host = termRegex('ARH-T01')!
  assert.ok(host.test('Dell Latitude 3510 (ARH-T01): battery'))
  assert.ok(host.test('arh-t01 lower case'))
  assert.ok(!host.test('ARH-T010'), 'not inside a longer name')
  assert.ok(!host.test('ARH-T01-B'))
  const bare = termRegex('COMPUTER', true)!
  assert.ok(bare.test('Hostname COMPUTER.'))
  assert.ok(!bare.test('The computer takes a long time'), 'prose is not the machine')
  assert.equal(termRegex('ab'), null, 'too short to search')
})

test('computers merge enrollment, scans and Asset Inventory; different serials stay apart', async () => {
  const { vault, done } = await copyVault()
  try {
    const notes = await new VaultIndex().notes(vault)
    const roles = noteRoles(notes, DEFAULT_SETTINGS)
    assert.ok(roles.assets && roles.openLoops && roles.workLog && roles.changeLog)
    assert.equal(roles.tickets.length, 3)
    const rows = inventoryRows(roles.assets!)
    assert.deepEqual(
      rows.map((r) => r.cells['Name']),
      ['ARH-T01'],
      'only computer tables, no header or empty rows'
    )

    const lan = JSON.stringify([
      { status: 'Up', mac: 'AA-BB-CC-00-11-22', ipv4: ['10.1.20.45/24'], gateways: ['10.1.20.1'] }
    ])
    const scan = run('r_1', '2026-10-14T15:00:00.000Z', {}, [])
    scan.checks = [
      {
        id: 'net-adapters',
        title: 'Network adapters',
        category: 'Network',
        format: 'json',
        optional: false,
        status: 'ok',
        exitCode: 0,
        stdout: lan,
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 1
      }
    ]
    const twin = {
      ...run('r_x', '2026-10-13T15:00:00.000Z', {}, []),
      deviceId: 'other',
      serial: 'SN-OTHER'
    }
    const computers = buildComputers([device], [scan, twin], rows)
    assert.equal(computers.length, 2, 'same hostname, different serial: two machines')
    const t01 = computers.find((c) => c.key === 'sn:sn-t01')!
    assert.equal(t01.inventory.length, 1)
    assert.equal(t01.runs.length, 1)
    const s = summarize(t01, () => true)
    assert.equal(s.name, 'ARH-T01')
    assert.deepEqual(s.aliases, ['Front desk laptop'])
    assert.equal(s.location, 'Site A')
    assert.equal(s.room, 'Front desk')
    assert.equal(s.model, 'Dell Inc. Latitude 3510', 'scan value wins over the typed model')
    assert.equal(s.ip, '10.1.20.45')
    assert.equal(s.health, 'healthy')
    assert.deepEqual(s.sources, ['enrolled', 'scans', 'inventory'])

    const all = computers.map((c) => summarize(c, () => false))
    assert.equal(rankComputers('sn-t0', all)[0]?.match, 'serial SN-T01')
    assert.equal(rankComputers('10.1.20.45', all)[0]?.key, 'sn:sn-t01')
    assert.equal(rankComputers('cc:00:11', all)[0]?.match, 'MAC AA-BB-CC-00-11-22')
    assert.equal(rankComputers('front desk', all)[0]?.key, 'sn:sn-t01')
    assert.deepEqual(rankComputers('zzz', all), [])

    const found = lookup('ARH-T01', all, notes)
    assert.equal(found.computers.length, 2)
    assert.equal(found.vaultNotes, 6, 'inventory, loops, work log, change log, ticket, loaner note')
  } finally {
    await done()
  }
})

test('profile: everything the vault and the scans hold for one computer, offline', async () => {
  const { vault, done } = await copyVault()
  try {
    // the dashboard's own blocks are not read back as notes
    await writeFile(
      join(vault, 'ARH IT Hub.md'),
      '# ARH IT Hub\r\n\r\n<!-- DASH:DEVICE-HEALTH:START -->\r\n| ARH-T01 | 🟢 healthy |\r\n<!-- DASH:DEVICE-HEALTH:END -->\r\n'
    )
    const notes = await new VaultIndex().notes(vault)
    const rows = inventoryRows(noteRoles(notes, DEFAULT_SETTINGS).assets!)
    const runs = [
      run('r_1', '2026-10-01T15:00:00.000Z', { 'disk-free:C:': 18, 'update-age': 12 }, []),
      run('r_2', '2026-10-08T15:00:00.000Z', { 'disk-free:C:': 13, 'update-age': 19 }, [disk(13)]),
      run('r_3', '2026-10-14T15:00:00.000Z', { 'disk-free:C:': 9, 'update-age': 25 }, [disk(9)]),
      run(
        'r_4',
        '2026-10-14T16:00:00.000Z',
        { 'battery-health': 48 },
        [
          {
            id: 'b',
            severity: 'warning',
            category: 'Power',
            message: 'Battery health is 48% of design capacity',
            loop: true
          }
        ],
        'windows-hardware-issues'
      )
    ]
    const computers = buildComputers([device], runs, rows)
    const p = buildProfile({
      target: { deviceId: 'fp-t01' },
      computers,
      notes,
      settings: DEFAULT_SETTINGS,
      connected: () => false
    })
    assert.equal(p.summary.name, 'ARH-T01')
    assert.equal(p.summary.connected, false, 'nothing needs to be plugged in')
    assert.deepEqual(p.terms, ['ARH-T01', 'SN-T01'])

    assert.deepEqual(
      p.findings.map((f) => f.message),
      ['Battery health is 48% of design capacity', 'Disk C: has 9% free'],
      'current = latest scan of each purpose'
    )
    const diskRec = p.recurring.find((r) => r.category === 'Storage')!
    assert.deepEqual(
      [diskRec.seen, diskRec.of, diskRec.current, diskRec.message],
      [2, 3, true, 'Disk C: has 9% free'],
      'the same problem with a different number is one recurring finding'
    )
    assert.deepEqual(
      p.series.map((s) => [s.key, s.points.map((x) => x.value)]),
      [
        ['disk-free:C:', [18, 13, 9]],
        ['update-age', [12, 19, 25]],
        ['battery-health', [48]]
      ]
    )
    assert.equal(p.series[0]?.threshold, 15)
    assert.equal(p.scans[0]?.runId, 'r_4', 'newest scan first')
    assert.equal(p.facts.find((f) => f.label === 'Model')?.value, 'Dell Inc. Latitude 3510')

    assert.equal(p.inventory.length, 1)
    assert.deepEqual(
      p.tickets.map((t) => [t.id, t.closed, t.openTasks, t.doneTasks, t.date]),
      [['TKT-2026-901', false, 1, 1, '2026-10-09']]
    )
    assert.deepEqual(
      p.loops.map((l) => [l.text.split('.')[0], l.priority, l.generated]),
      [['**ARH-T01 — order a replacement battery', '🟠', false]]
    )
    assert.deepEqual(
      p.worklog.map((w) => [w.date, w.lines]),
      [
        [
          '2026-10-14',
          [
            '### 10:20 MT — ARH-T01 battery check',
            '- Battery report run; capacity is low. → [[Ticket — ARH-T01 — battery — 2026-10-09]]'
          ]
        ]
      ],
      'only the part of the day about this computer'
    )
    assert.deepEqual(
      p.changes.map((c) => c.cells['What changed']),
      ['Disabled wake timers']
    )
    assert.deepEqual(
      p.mentions.map((m) => [m.title, m.line]),
      [['Loaner notes', 3]],
      'the hub block written by the dashboard is not a mention'
    )
    const kinds = p.timeline.map((e) => e.kind)
    // 10:20 MT is 16:20 UTC: after the 16:00 UTC scan
    assert.deepEqual(
      p.timeline.slice(0, 3).map((e) => [e.kind, e.at]),
      [
        ['worklog', '2026-10-14T16:20:00.000Z'],
        ['scan', '2026-10-14T16:00:00.000Z'],
        ['scan', '2026-10-14T15:00:00.000Z']
      ]
    )
    assert.equal(p.timeline.find((e) => e.kind === 'change')?.at, '2026-10-09T17:40:00.000Z')
    assert.ok(kinds.includes('ticket') && kinds.includes('change') && kinds.includes('enrolled'))
    assert.ok(
      p.timeline.every((e, i, a) => i === 0 || a[i - 1]!.at >= e.at),
      'timeline newest first'
    )

    // a word typed on a call, not a known computer: the vault still answers
    const sam = buildProfile({
      target: { term: 'Sam' },
      computers,
      notes,
      settings: DEFAULT_SETTINGS,
      connected: () => false
    })
    assert.equal(sam.summary.key, 'term:sam')
    assert.deepEqual(
      sam.tickets.map((t) => t.id),
      ['TKT-2026-901']
    )
    // a bare-word hostname matches its ticket, not every sentence with "computer"
    const bare = buildProfile({
      target: { term: 'COMPUTER' },
      computers: buildComputers([{ ...device, id: 'x', serial: '', hostname: 'COMPUTER' }], [], []),
      notes,
      settings: DEFAULT_SETTINGS,
      connected: () => false
    })
    assert.deepEqual(
      bare.tickets.map((t) => [t.id, t.closed]),
      [['TKT-2026-902', true]]
    )
    assert.deepEqual(bare.mentions, [], '"Every computer gets a label" is not this machine')
  } finally {
    await done()
  }
})

test('health keeps the raw numbers that the trends are drawn from', () => {
  const report = evaluateHealth({ os: 'windows', purpose: 'system-diagnostics' }, [
    {
      id: 'sys-overview',
      title: 'Overview',
      category: 'System',
      format: 'json',
      optional: false,
      exitCode: 0,
      stdout: JSON.stringify({
        ramUsedPct: 71.5,
        uptimeHours: 50,
        disks: [{ drive: 'C:', freePct: 12.3, freeGB: 30 }]
      }),
      stderr: '',
      timedOut: false,
      truncated: false
    }
  ])
  assert.deepEqual(report.values, { 'disk-free:C:': 12.3, 'ram-used': 71.5, 'uptime-days': 2.1 })
  assert.deepEqual(
    metricSeries([
      { ...run('a', '2026-10-01T00:00:00Z', {}, []), health: { ...report } },
      run('b', '2026-10-02T00:00:00Z', { 'disk-free:C:': 11, unknown: 3 }, [])
    ]).map((s) => [s.key, s.points.length]),
    [
      ['disk-free:C:', 2],
      ['ram-used', 1],
      ['uptime-days', 1]
    ],
    'unknown keys are not drawn'
  )
})

test('lookup stays fast on a vault ten times the size of ARH IT', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-lookup-big-'))
  try {
    await cp(SOURCE, tmp, { recursive: true })
    await mkdir(join(tmp, 'Bulk'))
    const filler = 'Routine note line about printers, phones and the network closet.\n'.repeat(60)
    for (let i = 0; i < 900; i++)
      await writeFile(
        join(tmp, 'Bulk', `Note ${i}.md`),
        `# Note ${i}\n\n${filler}${i % 97 === 0 ? 'ARH-T01 mentioned here.\n' : ''}`
      )
    const index = new VaultIndex({ maxAgeMs: 0 })
    await index.notes(tmp) // first read from disk
    const t0 = performance.now()
    const notes = await index.notes(tmp) // what every lookup pays: stat + cache
    const computers = buildComputers(
      [device],
      [],
      inventoryRows(noteRoles(notes, DEFAULT_SETTINGS).assets!)
    )
    const p = buildProfile({
      target: { key: 'sn:sn-t01' },
      computers,
      notes,
      settings: DEFAULT_SETTINGS,
      connected: () => false
    })
    const ms = performance.now() - t0
    assert.ok(notes.length > 900)
    assert.equal(p.mentions.filter((m) => m.file.startsWith('Bulk')).length, 10)
    assert.ok(ms < 1500, `profile on ${notes.length} notes took ${ms.toFixed(0)} ms`)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
