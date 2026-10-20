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
  seriesDef,
  summarize,
  termRegex,
  zonedToIso
} from '../src/main/services/lookup/computers.ts'
import { seriesBreach } from '../src/shared/types.ts'
import {
  currentRuns,
  mergeLoops,
  DEFAULT_CONTENT_OPTIONS
} from '../src/main/services/vault/content.ts'
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
