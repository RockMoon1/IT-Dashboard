import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile, unlink, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { VaultIndex, parseFrontmatter } from '../src/main/services/lookup/vaultindex.ts'
import {
  buildComputers,
  buildProfile,
  inventoryRows,
  lookup,
  metricSeries,
  noteRoles,
  rankComputers,
  seriesDef,
  summarize,
  termRegex,
  zonedToIso
} from '../src/main/services/lookup/computers.ts'
import { seriesBreach } from '../src/shared/types.ts'
import {
  currentRuns,
  devicesBlock,
  mergeLoops,
  vaultText,
  DEFAULT_CONTENT_OPTIONS,
  type ActionEntry
} from '../src/main/services/vault/content.ts'
import { setBlock } from '../src/main/services/vault/markers.ts'
import { buildWritePlans, notePaths } from '../src/main/services/vault/plans.ts'
import { VaultWriter } from '../src/main/services/vault/writer.ts'
import type { IndexedNote } from '../src/main/services/lookup/vaultindex.ts'
import { evaluateHealth } from '../src/main/services/scans/health.ts'
import { DEFAULT_SETTINGS } from '../src/main/services/settings.ts'
import type { Measurement } from '../src/shared/actions.ts'
import type { ComputerProfile, LookupTarget, ScanRun, Settings } from '../src/shared/types.ts'
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
    assert.ok(roles.assets && roles.openLoops && roles.workLog)
    assert.equal(roles.changeLog?.rel, 'ARH Change Log.md')
    assert.equal(
      roles.changeLog,
      roles.rootChangeLog,
      'the default Change Log note is the root one'
    )
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
    // the line the note viewer jumps to: the "### 10:20 MT" entry in the Work Log
    const wlNote = notes.find((n) => n.name === 'ARH Work Log')!
    assert.equal(
      wlNote.lines[(p.worklog[0]?.line ?? 0) - 1],
      '### 10:20 MT — ARH-T01 battery check'
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

/* ---------- regressions from the review of the lookup commit ---------- */

const sec = (
  id: string,
  at: string,
  hostname: string,
  serial: string,
  critical: boolean
): ScanRun => ({
  ...run(
    id,
    at,
    {},
    critical
      ? [
          {
            id: 'av',
            severity: 'critical',
            category: 'Antivirus',
            message: 'Defender real-time protection is off',
            loop: true
          }
        ]
      : []
  ),
  hostname,
  serial
})

test('a serial-less PC renamed between scans: only its latest scan of each purpose is current', () => {
  const dev: EnrolledDevice = { ...device, id: 'fp-wb', serial: '', hostname: 'ARH-PC2' }
  const runs = [
    { ...sec('r_old', '2026-10-01T15:00:00.000Z', 'DESKTOP-7GH2K', '', true), deviceId: 'fp-wb' },
    { ...sec('r_new', '2026-10-10T15:00:00.000Z', 'ARH-PC2', '', false), deviceId: 'fp-wb' }
  ]
  const computers = buildComputers([dev], runs, [])
  assert.equal(computers.length, 1)
  const s = summarize(computers[0]!, () => false)
  assert.equal(s.health, 'healthy', "the old name's critical scan is history, not current")
  assert.deepEqual(s.aliases, ['Front desk laptop', 'DESKTOP-7GH2K'])
  const p = buildProfile({
    target: { deviceId: 'fp-wb' },
    computers,
    notes: [],
    settings: DEFAULT_SETTINGS,
    connected: () => false
  })
  assert.deepEqual(p.findings, [])
  assert.equal(p.recurring[0]?.current, false)
  // the vault's open loops use the same rule across all devices
  assert.deepEqual(
    currentRuns(runs).map((r) => r.runId),
    ['r_new']
  )
  assert.equal(mergeLoops(null, runs, DEFAULT_CONTENT_OPTIONS).added, 0)
})

test('two enrolled devices under one hostname stay two computers, each with its own page', () => {
  const old: EnrolledDevice = {
    ...device,
    id: 'fp-old',
    serial: '',
    hostname: 'ARH-PC1',
    displayName: 'Front desk PC'
  }
  const laptop: EnrolledDevice = {
    ...device,
    id: 'fp-new',
    serial: 'SN-NEW',
    hostname: 'ARH-PC1',
    displayName: 'New laptop'
  }
  const computers = buildComputers([old, laptop], [], [])
  assert.equal(computers.length, 2)
  for (const id of ['fp-old', 'fp-new']) {
    const p = buildProfile({
      target: { deviceId: id },
      computers,
      notes: [],
      settings: DEFAULT_SETTINGS,
      connected: (x) => x === 'fp-new'
    })
    assert.equal(p.summary.name, 'ARH-PC1')
    assert.equal(p.summary.deviceId, id)
    assert.equal(p.summary.connected, id === 'fp-new')
  }
})

test('an inventory row with a serial goes to the computer with that serial, not an earlier name match', () => {
  const old: EnrolledDevice = {
    ...device,
    id: 'fp-old',
    serial: '',
    hostname: 'ARH-PC1',
    displayName: 'Front desk PC'
  }
  const laptop: EnrolledDevice = {
    ...device,
    id: 'fp-new',
    serial: '5CD1234XYZ',
    hostname: 'DESKTOP-K3J9L',
    displayName: 'New laptop'
  }
  const row = {
    file: 'Assets/Asset Inventory.md',
    line: 10,
    cells: { Name: 'ARH-PC1', Serial: '5CD1234XYZ', Location: 'Site A' }
  }
  const computers = buildComputers([old, laptop], [], [row])
  const withRow = computers.filter((c) => c.inventory.length)
  assert.deepEqual(
    withRow.map((c) => c.device?.id),
    ['fp-new']
  )
  const keys = computers.map((c) => c.key)
  assert.equal(new Set(keys).size, keys.length, 'every computer has its own key')
  // even when two records really carry the same serial, keys stay unique
  const dup = buildComputers([laptop, { ...laptop, id: 'fp-dup', displayName: 'dup' }], [], [])
  assert.deepEqual(
    dup.map((c) => c.key),
    ['sn:5cd1234xyz', 'sn:5cd1234xyz#2']
  )
})

test('MT wall times convert to UTC correctly on both DST change days', () => {
  const tz = 'America/Denver'
  const cases: Array<[string, string, string]> = [
    ['2026-10-14', '10:20', '2026-10-14T16:20:00.000Z'], // MDT
    ['2026-01-10', '09:00', '2026-01-10T16:00:00.000Z'], // MST
    ['2026-11-01', '02:30', '2026-11-01T09:30:00.000Z'], // after the fall-back: MST
    ['2026-11-01', '07:30', '2026-11-01T14:30:00.000Z'],
    ['2026-03-08', '03:30', '2026-03-08T09:30:00.000Z'], // after the spring-forward: MDT
    ['2026-03-08', '08:30', '2026-03-08T14:30:00.000Z'],
    ['2026-03-08', '09:30', '2026-03-08T15:30:00.000Z'],
    ['2027-03-14', '08:45', '2027-03-14T14:45:00.000Z']
  ]
  for (const [date, time, iso] of cases)
    assert.equal(zonedToIso(date, time, tz), iso, `${date} ${time} MT`)
})

test('vault index: changing the vault folder mid-refresh never returns the old vault', async () => {
  const a = await copyVault()
  const b = await copyVault()
  try {
    await writeFile(join(b.vault, 'Only in B.md'), '# Only in B\n')
    const index = new VaultIndex({ maxAgeMs: 60_000 })
    const [fromA, fromB] = await Promise.all([index.notes(a.vault), index.notes(b.vault)])
    assert.ok(fromA.every((n) => n.abs.startsWith(a.vault)))
    assert.ok(
      fromB.every((n) => n.abs.startsWith(b.vault)),
      'B gets B notes'
    )
    assert.ok(fromB.some((n) => n.name === 'Only in B'))
    const again = await index.notes(b.vault)
    assert.ok(
      again.every((n) => n.abs.startsWith(b.vault)),
      'the cache holds B, not a late A'
    )
  } finally {
    await a.done()
    await b.done()
  }
})

test('a serial-less PC whose agent was reinstalled: its old runs still belong to it', () => {
  // the reinstall re-enrolls by hostname under a new id; stored runs keep the old id
  const now: EnrolledDevice = { ...device, id: 'fp-new', serial: '', hostname: 'FRONTDESK' }
  const runs = [
    { ...sec('r_1', '2026-10-01T15:00:00.000Z', 'FRONTDESK', '', true), deviceId: 'fp-old' },
    { ...sec('r_2', '2026-10-10T15:00:00.000Z', 'FRONTDESK', '', false), deviceId: 'fp-new' }
  ]
  assert.deepEqual(
    currentRuns(runs, [now]).map((r) => r.runId),
    ['r_2'],
    'the clean scan after the reinstall is current'
  )
  assert.equal(mergeLoops(null, runs, DEFAULT_CONTENT_OPTIONS, new Date(), [now]).added, 0)
  // two serial-less devices that share a hostname are still kept apart by their ids
  const twin: EnrolledDevice = { ...now, id: 'fp-twin' }
  const both = [
    { ...sec('a', '2026-10-01T15:00:00.000Z', 'FRONTDESK', '', true), deviceId: 'fp-new' },
    { ...sec('b', '2026-10-02T15:00:00.000Z', 'FRONTDESK', '', false), deviceId: 'fp-twin' }
  ]
  assert.deepEqual(
    currentRuns(both, [now, twin])
      .map((r) => r.runId)
      .sort(),
    ['a', 'b']
  )
})

test('trend "past the limit" uses exactly the comparison each health check uses', () => {
  const day = 86_400_000
  const now = new Date('2026-10-20T12:00:00.000Z')
  const out = (id: string, value: unknown, format: 'json' | 'text' = 'json') => ({
    id,
    title: id,
    category: 'x',
    format,
    optional: false,
    exitCode: 0,
    stdout: format === 'json' ? JSON.stringify(value) : String(value),
    stderr: '',
    timedOut: false,
    truncated: false
  })
  const cases: Array<{
    key: string
    category: string
    make: (v: number) => ReturnType<typeof out>
  }> = [
    {
      key: 'disk-free:C:',
      category: 'Storage',
      make: (v) => out('sys-overview', { disks: [{ drive: 'C:', freePct: v }] })
    },
    {
      key: 'ram-used',
      category: 'Performance',
      make: (v) => out('sys-overview', { ramUsedPct: v })
    },
    {
      key: 'uptime-days',
      category: 'System',
      make: (v) => out('sys-overview', { uptimeHours: v * 24 })
    },
    {
      key: 'update-age',
      category: 'Updates',
      make: (v) =>
        out('sec-updates', {
          hotfixes: [
            { HotFixID: 'KB1', InstalledOn: new Date(now.getTime() - v * day).toISOString() }
          ]
        })
    },
    {
      key: 'av-signature-age',
      category: 'Antivirus',
      make: (v) =>
        out('sec-defender', {
          available: true,
          antivirusEnabled: true,
          realTimeProtectionEnabled: true,
          signatureAgeDays: v
        })
    },
    {
      key: 'failed-logins-24h',
      category: 'Accounts',
      make: (v) => out('sec-logins', { failedLogins24h: v, failedLogins7d: v })
    },
    {
      key: 'battery-health',
      category: 'Power',
      make: (v) => out('hw-battery', { present: true, healthPct: v, chargePct: 50 })
    },
    { key: 'cpu', category: 'Performance', make: (v) => out('perf-resources', { cpuPct: v }) },
    {
      key: 'system-errors-7d',
      category: 'Events',
      make: (v) =>
        out(
          'hw-system-errors',
          Array.from({ length: v }, () => '2026-10-19T10:00:00 Error x').join('\n'),
          'text'
        )
    },
    {
      key: 'startup-items',
      category: 'Startup',
      make: (v) =>
        out(
          'perf-startup',
          Array.from({ length: v }, (_, i) => ({ n: i }))
        )
    }
  ]
  // values that are measured, not counted, also get fractions right next to the limit
  const continuous = new Set([
    'disk-free:C:',
    'ram-used',
    'uptime-days',
    'update-age',
    'battery-health',
    'cpu'
  ])
  for (const c of cases) {
    const def = seriesDef(c.key)!
    const t = def.threshold!
    const values = [t - 1, t, t + 1]
    if (continuous.has(c.key)) values.push(t - 0.04, t - 0.02, t + 0.02, t + 0.04)
    for (const v of values) {
      const report = evaluateHealth(
        { os: 'windows', purpose: 'system-diagnostics' },
        [c.make(v)],
        now
      )
      const stored = report.values?.[c.key]
      assert.equal(stored, Math.round(v * 10) / 10, `${c.key} value at ${v}`)
      const flagged = report.findings.some(
        (f) => f.category === c.category && f.category !== 'Scan'
      )
      assert.equal(
        seriesBreach({ threshold: def.threshold, alert: def.alert }, stored),
        flagged,
        `${c.key} = ${v}: the trend card and the health check must agree`
      )
    }
  }
})

/** A note as the vault index reads it, for a vault that lives only in the test. */
function note(rel: string, text: string): IndexedNote {
  const name = rel.replace(/^.*\//, '').replace(/\.md$/, '')
  const folder = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : ''
  const lines = text.split('\n')
  return {
    rel,
    abs: `/vault/${rel}`,
    name,
    folder,
    text,
    lines,
    frontmatter: {},
    title: name,
    mtimeMs: 0,
    size: text.length
  }
}

test('a serial or name holding a character the vault escapes is one computer, as the device sent it', () => {
  for (const serial of [
    'MXL~2041X7',
    'MXL#2041',
    'MXL$2041',
    'MXL^2041',
    'MXL[2041]',
    'MXL|2041',
    'MXL\\2041',
    'MXL%%2041',
    'MXL`2041`',
    'MXL<2041>'
  ]) {
    const pc: EnrolledDevice = { ...device, serial, hostname: `PC-${serial}` }
    const assets = note(
      DEFAULT_SETTINGS.assetNote,
      setBlock(
        '# Asset Inventory\n',
        'DEVICES',
        devicesBlock(null, [{ device: pc, facts: {} }], DEFAULT_CONTENT_OPTIONS)
      ).text
    )
    const rows = inventoryRows(assets)
    assert.deepEqual(
      [rows[0]?.cells['Serial'], rows[0]?.cells['Name']],
      [serial, pc.hostname],
      'read back as written'
    )
    const computers = buildComputers([pc], [], rows)
    assert.equal(
      computers.length,
      1,
      `${serial}: the device and its inventory row are one computer`
    )
    assert.equal(computers[0]!.inventory.length, 1)
    // the Change Log is the dashboard's table too: a row naming only the serial is found by it
    const changeLog = note(
      'ARH Change Log.md',
      setBlock(
        '# ARH Change Log\n',
        'CHANGES',
        [
          '| Timestamp (MT) | System / machine | What changed | Why | Reversible? | Rollback | By |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          `| 2026-10-20 14:05 | ${vaultText(serial)} | Firewall on | fix | Yes | n/a | Lisandro · run a_1 |`
        ].join('\n')
      ).text
    )
    const p = buildProfile({
      target: { deviceId: pc.id },
      computers,
      notes: [assets, changeLog],
      settings: DEFAULT_SETTINGS,
      connected: () => false
    })
    assert.deepEqual(
      p.changes.map((c) => c.cells['System / machine']),
      [serial]
    )
  }
})

test('a serial or name the vault writes respaced or cut short is still one computer', () => {
  // a cell turns tabs, zero-width characters and runs of spaces into one space and caps the
  // length at 400; the device's own row must still be found by the value the device sent
  for (const [serial, hostname] of [
    ['MXL  2041', 'PC-1'],
    ['MXL\t2041', 'PC-1'],
    ['MXL\u200b2041', 'PC-1'],
    ['x'.repeat(401), 'PC-1'],
    ['', 'FRONT  DESK']
  ] as const) {
    const pc: EnrolledDevice = { ...device, serial, hostname }
    const assets = note(
      DEFAULT_SETTINGS.assetNote,
      setBlock(
        '# Asset Inventory\n',
        'DEVICES',
        devicesBlock(null, [{ device: pc, facts: {} }], DEFAULT_CONTENT_OPTIONS)
      ).text
    )
    const rows = inventoryRows(assets)
    const what = `${JSON.stringify(serial || hostname).slice(0, 20)} (cell ${JSON.stringify(rows[0]?.cells[serial ? 'Serial' : 'Name']).slice(0, 20)})`
    const computers = buildComputers([pc], [], rows)
    assert.equal(computers.length, 1, `${what}: the device and its inventory row are one computer`)
    assert.equal(computers[0]!.inventory.length, 1)
    if (!serial) continue
    // a Change Log row that names only the serial, as a cell writes it, is found by it too
    const changeLog = note(
      'ARH Change Log.md',
      setBlock(
        '# ARH Change Log\n',
        'CHANGES',
        [
          '| Timestamp (MT) | System / machine | What changed | Why | Reversible? | Rollback | By |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          `| 2026-10-20 14:05 | ${vaultText(serial, 400)} | Firewall on | fix | Yes | n/a | Lisandro · run a_1 |`
        ].join('\n')
      ).text
    )
    const p = buildProfile({
      target: { deviceId: pc.id },
      computers,
      notes: [assets, changeLog],
      settings: DEFAULT_SETTINGS,
      connected: () => false
    })
    assert.equal(p.changes.length, 1, `${what}: the Change Log row is found by the serial`)
  }
})

function change(runId: string, at: string): ActionEntry {
  const measured = (value: string): Measurement => ({
    items: [{ item: 'Firewall Public', value }],
    exitCode: 0
  })
  return {
    record: {
      runId,
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
      reason: 'Fix: Firewall profile "Public" is disabled',
      technician: 'Lisandro',
      requestedAt: at,
      startedAt: at,
      appliedAt: at,
      endedAt: at,
      status: 'changed',
      checks: [],
      result: {
        runId,
        kind: 'action',
        dryRun: false,
        applied: true,
        startedAt: at,
        before: measured('off'),
        apply: { items: null, exitCode: 0 },
        after: measured('on')
      }
    }
  }
}

test('the computer page reads the Change Log note the dashboard writes to, and the root one', async () => {
  const { vault, done } = await copyVault()
  const appData = await mkdtemp(join(tmpdir(), 'arh-lookup-appdata-'))
  try {
    const writer = new VaultWriter({ appDataDir: appData, live: true })
    const write = async (settings: Settings, actions: ActionEntry[]): Promise<void> => {
      const plans = await buildWritePlans({ settings, devices: [device], runs: [], actions })
      const results = await writer.apply(plans)
      assert.ok(
        results.every((r) => !r.error),
        JSON.stringify(results)
      )
    }
    const page = async (settings: Settings): Promise<ComputerProfile> => {
      const notes = await new VaultIndex().notes(vault)
      const rows = inventoryRows(noteRoles(notes, settings).assets!)
      return buildProfile({
        target: { deviceId: device.id },
        computers: buildComputers([device], [], rows),
        notes,
        settings,
        connected: () => false
      })
    }
    const changes = (p: ComputerProfile): string[][] =>
      p.changes.map((c) => [c.file, c.cells['By'] ?? ''])
    // by default the dashboard's rows go to the root ARH Change Log, under the technician's own
    const root = { ...DEFAULT_SETTINGS, vaultPath: vault }
    await write(root, [change('a_1', '2026-10-14T16:00:00.000Z')])
    const before = await page(root)
    assert.deepEqual(changes(before), [
      ['ARH Change Log.md', 'L.P.'],
      ['ARH Change Log.md', 'Lisandro · run a_1']
    ])
    // Settings › Change Log note set to a note of the technician's (the dashboard creates none),
    // typed as notePaths reads it: trimmed, ".md" added
    await mkdir(join(vault, 'Logs'))
    await writeFile(join(vault, 'Logs', 'Device Changes.md'), '# Device changes\n')
    const moved = { ...root, changeLogNote: ' Logs/Device Changes ' }
    assert.equal(notePaths(moved).changeLog, join(vault, 'Logs', 'Device Changes.md'))
    // its first write puts every change on record there, a_1 again
    await write(moved, [
      change('a_1', '2026-10-14T16:00:00.000Z'),
      change('a_2', '2026-10-15T16:00:00.000Z')
    ])
    const p = await page(moved)
    const logs = join('Logs', 'Device Changes.md')
    assert.deepEqual(
      changes(p),
      [
        [logs, 'Lisandro · run a_1'],
        [logs, 'Lisandro · run a_2'],
        ['ARH Change Log.md', 'L.P.']
      ],
      "the dashboard's note first, then the root note's rows it does not hold"
    )
    assert.equal(p.timeline.filter((e) => e.kind === 'change').length, 3)
    // no Change Log note: the dashboard writes none, and the root note is still read
    assert.deepEqual(changes(await page({ ...root, changeLogNote: '' })), changes(before))
  } finally {
    await done()
    await rm(appData, { recursive: true, force: true })
  }
})

test('the Change Log note Settings names is found as the writer finds it, and only its block is the Change Log', async () => {
  const logs = join('Logs', 'Device Changes.md')
  const own = 'Swapped the power supply in ARH-T01; the old one is in the closet.'
  /** One write of change a_1 with the setting, then the computer page as the lookup builds it. */
  const pageAfterWrite = async (
    changeLogNote: string,
    prepare: (vault: string) => Promise<void> = async () => {}
  ): Promise<{ p: ComputerProfile; read?: string; written: string | null }> => {
    const { vault, done } = await copyVault()
    const appData = await mkdtemp(join(tmpdir(), 'arh-lookup-appdata-'))
    try {
      await prepare(vault)
      const settings = { ...DEFAULT_SETTINGS, vaultPath: vault, changeLogNote }
      const writer = new VaultWriter({ appDataDir: appData, live: true })
      const plans = await buildWritePlans({
        settings,
        devices: [device],
        runs: [],
        actions: [change('a_1', '2026-10-14T16:00:00.000Z')]
      })
      const results = await writer.apply(plans)
      assert.ok(
        results.every((r) => !r.error),
        JSON.stringify(results)
      )
      const notes = await new VaultIndex().notes(vault)
      const roles = noteRoles(notes, settings)
      const p = buildProfile({
        target: { deviceId: device.id },
        computers: buildComputers([device], [], inventoryRows(roles.assets!)),
        notes,
        settings,
        connected: () => false
      })
      const path = notePaths(settings).changeLog
      return { p, read: roles.changeLog?.rel, written: path && relative(vault, path) }
    } finally {
      await done()
      await rm(appData, { recursive: true, force: true })
    }
  }
  const changes = (p: ComputerProfile): string[][] =>
    p.changes.map((c) => [c.file, c.cells['By'] ?? ''])
  const logsNote = async (vault: string): Promise<void> => {
    await mkdir(join(vault, 'Logs'))
    await writeFile(join(vault, 'Logs', 'Device Changes.md'), `# Device changes\n\n${own}\n`)
  }
  // typed with "./", a leading separator ("\Logs\Device Changes" on Windows) or a ".." step,
  // notePaths writes to Logs/Device Changes.md, and the page reads its rows from there
  for (const typed of [
    './Logs/Device Changes.md',
    `${sep}Logs${sep}Device Changes`,
    'Assets/../Logs/Device Changes'
  ]) {
    const { p, read, written } = await pageAfterWrite(typed, logsNote)
    assert.equal(written, logs, `${typed}: the note the writer writes to`)
    assert.equal(read, logs, `${typed}: the note the lookup reads`)
    assert.deepEqual(
      changes(p),
      [
        [logs, 'Lisandro · run a_1'],
        ['ARH Change Log.md', 'L.P.']
      ],
      typed
    )
    assert.equal(p.timeline.filter((e) => e.kind === 'change').length, 2, typed)
    // the technician's own line in that note is still found, as a mention
    assert.deepEqual(
      p.mentions.filter((m) => m.file === logs).map((m) => m.text),
      [own],
      `${typed}: text outside the dashboard's block`
    )
  }
  // a change first written to the root as pending, then with its result, then once more after the
  // setting moved: the root's two rows for that run are the same change, so it shows once
  {
    const { vault, done } = await copyVault()
    const appData = await mkdtemp(join(tmpdir(), 'arh-lookup-appdata-'))
    try {
      await logsNote(vault)
      const writer = new VaultWriter({ appDataDir: appData, live: true })
      const at = '2026-10-14T16:00:00.000Z'
      const { endedAt: _e, result: _r, ...open } = change('a_1', at).record
      const steps: Array<[string, ActionEntry]> = [
        ['ARH Change Log', { record: { ...open, status: 'unknown' } }],
        ['ARH Change Log', change('a_1', at)],
        ['Logs/Device Changes', change('a_1', at)]
      ]
      let settings = DEFAULT_SETTINGS
      for (const [changeLogNote, entry] of steps) {
        settings = { ...DEFAULT_SETTINGS, vaultPath: vault, changeLogNote }
        const plans = await buildWritePlans({
          settings,
          devices: [device],
          runs: [],
          actions: [entry]
        })
        const results = await writer.apply(plans)
        assert.ok(
          results.every((r) => !r.error),
          JSON.stringify(results)
        )
      }
      const root = await readFile(join(vault, 'ARH Change Log.md'), 'utf8')
      assert.match(root, /run a_1 · result pending/, 'the root holds the pending row')
      assert.match(root, /result a_1/, 'and the result row')
      const notes = await new VaultIndex().notes(vault)
      const roles = noteRoles(notes, settings)
      const p = buildProfile({
        target: { deviceId: device.id },
        computers: buildComputers([device], [], inventoryRows(roles.assets!)),
        notes,
        settings,
        connected: () => false
      })
      assert.deepEqual(changes(p), [
        [logs, 'Lisandro · run a_1'],
        ['ARH Change Log.md', 'L.P.']
      ])
      assert.equal(p.timeline.filter((e) => e.kind === 'change').length, 2)
    } finally {
      await done()
      await rm(appData, { recursive: true, force: true })
    }
  }
  // a note that holds other tables naming the computer (the hub's health block, the inventory's
  // computers): only the rows of its CHANGES block are Change Log rows
  for (const typed of [DEFAULT_SETTINGS.hubNote, DEFAULT_SETTINGS.assetNote]) {
    const { p, written } = await pageAfterWrite(typed)
    assert.ok(written, typed)
    assert.deepEqual(
      changes(p),
      [
        [written, 'Lisandro · run a_1'],
        ['ARH Change Log.md', 'L.P.']
      ],
      typed
    )
  }
})

test('the computer page shows no comment: tickets, mentions, Change Log, Work Log, Open Loops, history', async () => {
  const { vault, done } = await copyVault()
  const appData = await mkdtemp(join(tmpdir(), 'arh-lookup-appdata-'))
  try {
    const edit = async (rel: string, from: string, to: string): Promise<void> => {
      const text = await readFile(join(vault, rel), 'utf8')
      assert.ok(text.includes(from), `${rel}: ${from}`)
      await writeFile(join(vault, rel), text.replace(from, to))
    }
    // a patient's details in each kind of comment: %% %%, <!-- -->, a %% block over lines and a
    // YAML comment after a property
    const ticket = join('Tickets', 'Ticket — ARH-T01 — battery — 2026-10-09.md')
    await edit(ticket, 'status: open', 'status: open # for patient Jane Roe, MRN 445566')
    await edit(ticket, '# TKT-2026-901', '%%\n# Patient Jane Roe MRN 445566\n%%\n# TKT-2026-901')
    await edit(
      ticket,
      '- [ ] Order the battery',
      '- [ ] Order the battery <!-- Jane Roe -->\n%%\n- [ ] Call Jane Roe, MRN 445566\n%%'
    )
    // a ticket that names the computer only in a comment is not its ticket
    await writeFile(
      join(vault, 'Tickets', 'T-0009 Scanner.md'),
      '# T-0009 Scanner\n\n%% ARH-T01 lent to Jane Roe %%\n'
    )
    const loaner = join('Reference', 'Loaner notes.md')
    await writeFile(
      join(vault, loaner),
      [
        '---',
        'owner: IT # ARH-T01 is with Jane Roe, MRN 445566',
        '---',
        '# Loaner notes %% for Jane Roe %%',
        '',
        '- ARH-T01 is the loaner when a front desk laptop is out. %% Jane Roe has it, MRN 445566 %%',
        '- Every computer gets a label.',
        '<!-- ARH-T01 lent to Jane Roe, MRN 445566 -->',
        '%%',
        'ARH-T01 was in room 4 with Jane Roe',
        '%%',
        '- ARH-T01 charger <!-- MRN 445566 --> is in the closet.'
      ].join('\n')
    )
    await edit(
      'ARH Change Log.md',
      '| Battery drain overnight |',
      '| Battery drain overnight %% Jane Roe asked %% |'
    )
    await edit('ARH Work Log.md', 'capacity is low.', 'capacity is low. %% Jane Roe, MRN 445566 %%')
    await edit(
      'ARH Work Log.md',
      '## 2026-10-13 (Tuesday)',
      '<!-- ARH-T01 back from Jane Roe -->\n%%\n### 11:00 MT — ARH-T01 lent to Jane Roe\n- MRN 445566\n%%\n\n## 2026-10-13 (Tuesday)'
    )
    await edit(
      'ARH Open Loops.md',
      'order a replacement battery.**',
      'order a replacement battery.** <!-- for Jane Roe, MRN 445566 -->'
    )
    await edit(
      'ARH Open Loops.md',
      '- [x] ~~**Reset',
      '%%\n- [ ] **ARH-T01 — call Jane Roe back, MRN 445566**\n%%\n- [x] ~~**Reset'
    )
    await edit(
      join('Assets', 'Asset Inventory.md'),
      '| synthetic row |',
      '| synthetic row %% Jane Roe %% |'
    )
    // the Change Log note Settings names: the dashboard's block, the technician's text around it
    const logs = join('Logs', 'Device Changes.md')
    await mkdir(join(vault, 'Logs'))
    await writeFile(
      join(vault, logs),
      '# Device changes\n\nARH-T01 PSU swapped %% for Jane Roe, MRN 445566 %%\n\n%%\nARH-T01 was in room 4 with Jane Roe\n%%\n'
    )
    const settings = { ...DEFAULT_SETTINGS, vaultPath: vault, changeLogNote: 'Logs/Device Changes' }
    const writer = new VaultWriter({ appDataDir: appData, live: true })
    const plans = await buildWritePlans({
      settings,
      devices: [device],
      runs: [],
      actions: [change('a_1', '2026-10-14T16:00:00.000Z')]
    })
    const results = await writer.apply(plans)
    assert.ok(
      results.every((r) => !r.error),
      JSON.stringify(results)
    )

    const notes = await new VaultIndex().notes(vault)
    const rows = inventoryRows(noteRoles(notes, settings).assets!)
    const computers = buildComputers([device], [], rows)
    const page = (target: LookupTarget): ComputerProfile =>
      buildProfile({ target, computers, notes, settings, connected: () => false })
    const p = page({ deviceId: device.id })
    assert.doesNotMatch(JSON.stringify(p), /Jane|MRN|445566/)

    // what the reader shows around the comments still shows, at its own line
    const raw = (file: string, line: number | undefined): string =>
      notes.find((n) => n.rel === file)!.lines[(line ?? 0) - 1] ?? ''
    const title = 'TKT-2026-901 — Dell Latitude 3510 (ARH-T01): battery will not hold a charge'
    assert.deepEqual(
      p.tickets.map((t) => [t.title, t.status, t.openTasks, t.doneTasks]),
      [[title, 'open', 1, 1]]
    )
    assert.deepEqual(
      [...p.mentions]
        .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
        .map((m) => [m.file, m.title, m.line, m.text]),
      [
        [logs, 'Device changes', 3, 'ARH-T01 PSU swapped'],
        [loaner, 'Loaner notes', 6, '- ARH-T01 is the loaner when a front desk laptop is out.'],
        [loaner, 'Loaner notes', 12, '- ARH-T01 charger  is in the closet.']
      ]
    )
    for (const m of p.mentions) assert.ok(raw(m.file, m.line).startsWith(m.text.slice(0, 15)))
    const root = p.changes.find((c) => c.cells['By'] === 'L.P.')!
    assert.equal(root.cells['Why'], 'Battery drain overnight')
    assert.match(raw(root.file, root.line), /Disabled wake timers/)
    assert.ok(p.changes.some((c) => c.file === logs && c.cells['By'] === 'Lisandro · run a_1'))
    const battery = p.worklog.find((w) => w.lines[0]?.includes('10:20 MT'))!
    assert.deepEqual(battery.lines, [
      '### 10:20 MT — ARH-T01 battery check',
      '- Battery report run; capacity is low.  → [[Ticket — ARH-T01 — battery — 2026-10-09]]'
    ])
    assert.equal(raw(battery.file, battery.line), '### 10:20 MT — ARH-T01 battery check')
    assert.deepEqual(
      p.loops.map((l) => [l.text, raw(l.file, l.line).includes('order a replacement battery')]),
      [
        [
          '**ARH-T01 — order a replacement battery.**  → [[Ticket — ARH-T01 — battery — 2026-10-09]]',
          true
        ]
      ]
    )
    assert.equal(p.inventory[0]?.cells['Notes'], 'synthetic row')
    assert.ok(p.timeline.some((e) => e.kind === 'ticket' && e.title === title))
    assert.ok(p.timeline.some((e) => e.title === '10:20 MT — ARH-T01 battery check'))

    // a name or serial only in a comment is no match: not on a page, nor in the lookup's count
    const jane = page({ term: 'Jane Roe' })
    assert.deepEqual(
      [jane.tickets, jane.mentions, jane.loops, jane.worklog, jane.changes, jane.inventory],
      [[], [], [], [], [], []]
    )
    assert.equal(lookup('Jane Roe', [], notes).vaultNotes, 0)
    assert.ok(lookup('ARH-T01', [], notes).vaultNotes > 0)
  } finally {
    await done()
    await rm(appData, { recursive: true, force: true })
  }
})
