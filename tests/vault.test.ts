import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findBlock,
  getBlock,
  setBlock,
  startMarker,
  endMarker
} from '../src/main/services/vault/markers.ts'
import { unifiedDiff } from '../src/main/services/vault/diff.ts'
import { VaultWriter, isConflictCopy } from '../src/main/services/vault/writer.ts'
import {
  parseTasks,
  parseDatedEntries,
  searchVault,
  parseDue
} from '../src/main/services/vault/reader.ts'
import {
  mergeLoops,
  mergeLog,
  devicesBlock,
  healthBlock,
  deviceFacts,
  lanAddress,
  readTable,
  zoned,
  DEFAULT_CONTENT_OPTIONS,
  countOpenLoops
} from '../src/main/services/vault/content.ts'
import type { ScanRun } from '../src/shared/types.ts'

const KEY = 'DEVICE-SCANS'

test('setBlock appends markers once at the end when they are missing and never touches other text', () => {
  const note = '# ARH IT Hub\n\n## Open Items\n- a\n'
  const r1 = setBlock(note, KEY, 'first body')
  assert.equal(r1.created, true)
  assert.equal(
    r1.text,
    `# ARH IT Hub\n\n## Open Items\n- a\n\n${startMarker(KEY)}\nfirst body\n${endMarker(KEY)}\n`
  )
  const r2 = setBlock(r1.text, KEY, 'second body\nline 2')
  assert.equal(r2.created, false)
  assert.equal(
    r2.text,
    `# ARH IT Hub\n\n## Open Items\n- a\n\n${startMarker(KEY)}\nsecond body\nline 2\n${endMarker(KEY)}\n`
  )
  assert.equal(getBlock(r2.text, KEY), 'second body\nline 2')
})

test('markers in the middle of a note replace only their body and keep CRLF', () => {
  const note = `# Hub\r\n\r\n${startMarker(KEY)}\r\nold\r\n${endMarker(KEY)}\r\n\r\n## After\r\n- keep me\r\n`
  const r = setBlock(note, KEY, 'new\nbody')
  assert.equal(
    r.text,
    `# Hub\r\n\r\n${startMarker(KEY)}\r\nnew\r\nbody\r\n${endMarker(KEY)}\r\n\r\n## After\r\n- keep me\r\n`
  )
  assert.equal(findBlock(r.text, KEY)?.body, 'new\r\nbody')
})

test('malformed markers are refused instead of guessed', () => {
  assert.throws(() => findBlock(`${startMarker(KEY)}\nx\n`, KEY), /1 start and 0 end/)
  assert.throws(
    () => findBlock(`${endMarker(KEY)}\n${startMarker(KEY)}\n`, KEY),
    /before its start/
  )
  assert.throws(() => findBlock('x', 'lower case'), /invalid marker key/)
  assert.equal(findBlock('no markers here', KEY), null)
})

test('unifiedDiff reports only the changed region', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\n'
  const after = 'a\nb\nc\nX\ne\nf\ng\n'
  const d = unifiedDiff(before, after, 'note.md')
  assert.deepEqual(d.stats, { added: 1, removed: 1 })
  assert.ok(d.text.includes('-d\n+X\n'))
  assert.ok(d.text.startsWith('--- note.md\n+++ note.md\n@@'))
  assert.equal(unifiedDiff('same\n', 'same\n', 'n').text, '')
})

test('writer: dry-run preview, refusal to write, live write with backup, atomic replace and conflict copies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-vault-'))
  const appData = await mkdtemp(join(tmpdir(), 'arh-app-'))
  try {
    const hub = join(dir, 'ARH IT Hub.md')
    const missing = join(dir, 'Does Not Exist.md')
    await writeFile(hub, '# ARH IT Hub\n\nIntro text.\n', 'utf8')
    const writer = new VaultWriter({ appDataDir: appData, live: false })

    const preview = await writer.preview([
      { notePath: hub, key: KEY, body: '> [!info]- scan' },
      { notePath: missing, key: KEY, body: 'x' }
    ])
    assert.equal(preview.length, 2)
    assert.equal(preview[0]?.changed, true)
    assert.deepEqual(preview[0]?.markersCreated, [KEY])
    assert.ok(preview[0]?.diff.includes(`+${startMarker(KEY)}`))
    assert.equal(preview[1]?.exists, false)
    assert.match(preview[1]?.error ?? '', /never creates notes/)
    assert.equal(
      await readFile(hub, 'utf8'),
      '# ARH IT Hub\n\nIntro text.\n',
      'preview must not write'
    )

    await assert.rejects(writer.apply([{ notePath: hub, key: KEY, body: 'x' }]), /dry-run/)
    assert.deepEqual(await readdir(dir), ['ARH IT Hub.md'])

    writer.setLive(true)
    const r1 = await writer.apply([{ notePath: hub, key: KEY, body: 'first' }])
    assert.equal(r1[0]?.written, true)
    assert.ok(r1[0]?.backupPath?.includes('vault-backups'))
    assert.equal(
      await readFile(r1[0]!.backupPath!, 'utf8'),
      '# ARH IT Hub\n\nIntro text.\n',
      'backup is the pre-write content'
    )
    assert.equal(
      await readFile(hub, 'utf8'),
      `# ARH IT Hub\n\nIntro text.\n\n${startMarker(KEY)}\nfirst\n${endMarker(KEY)}\n`
    )

    const r2 = await writer.apply([{ notePath: hub, key: KEY, body: 'second' }])
    assert.equal(r2[0]?.backupPath, r1[0]?.backupPath, 'backup is taken once')
    assert.equal(
      await readFile(r1[0]!.backupPath!, 'utf8'),
      '# ARH IT Hub\n\nIntro text.\n',
      'later writes do not overwrite the backup'
    )
    assert.ok((await readFile(hub, 'utf8')).includes('\nsecond\n'))
    assert.deepEqual(await readdir(join(appData, 'vault-tmp')), [], 'no temp files left behind')

    await writeFile(
      join(dir, 'ARH IT Hub-DESKTOP-ABC (conflicted copy 2026-10-14).md'),
      'x',
      'utf8'
    )
    const r3 = await writer.apply([{ notePath: hub, key: KEY, body: 'third' }])
    assert.equal(r3[0]?.conflictCopies.length, 1)
    assert.ok(
      isConflictCopy('Note (conflict).md') &&
        isConflictCopy('Note-conflict.md') &&
        !isConflictCopy('Note.md')
    )
    assert.equal((await VaultWriter.scanConflicts(dir)).length, 1)

    const r4 = await writer.apply([{ notePath: missing, key: KEY, body: 'x' }])
    assert.equal(r4[0]?.written, false)
    assert.match(r4[0]?.error ?? '', /never creates notes/)
    assert.deepEqual(
      (await readdir(dir)).filter((n) => n.startsWith('Does')),
      []
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(appData, { recursive: true, force: true })
  }
})

test('reader parses tasks with several due-date conventions and dated log entries', () => {
  const text = [
    '# Open Loops',
    '- [ ] Replace toner 📅 2026-10-10',
    '- [x] Done thing [due:: 2026-10-01]',
    '- [/] In progress (due: 2026-10-16) ⏫',
    '1. [ ] numbered @2026-10-20',
    '- [ ] no date at all',
    '```',
    '- [ ] inside a code block',
    '```'
  ].join('\n')
  const tasks = parseTasks(text, 'ARH Open Loops.md', '2026-10-14', 3)
  assert.equal(tasks.length, 5)
  assert.deepEqual(
    tasks.map((t) => t.due),
    ['2026-10-10', '2026-10-01', '2026-10-16', '2026-10-20', undefined]
  )
  assert.deepEqual(
    tasks.map((t) => t.overdue),
    [true, false, false, false, false]
  )
  assert.deepEqual(
    tasks.map((t) => t.dueSoon),
    [false, false, true, false, false]
  )
  assert.equal(tasks[2]?.priority, '⏫')
  assert.equal(tasks[0]?.text, 'Replace toner')
  assert.equal(parseDue('by 2026-12-01 please'), '2026-12-01')

  const log = parseDatedEntries(
    '# Work Log\n\n## 2026-10-13\n- a\n\n## Notes\n- not dated\n\n## 2026-10-14 (Tue)\n- b\n- c\n',
    'ARH Work Log.md'
  )
  assert.deepEqual(
    log.map((e) => [e.date, e.lines.length]),
    [
      ['2026-10-14', 2],
      ['2026-10-13', 1]
    ],
    'newest first whatever the note order'
  )
})

test('reader follows the ARH vault: priority from the line or its section, sub-headings stay in the day', () => {
  // Shapes taken from the 2026-10-15 inspection of the real vault (text is synthetic).
  const loops = [
    '# ARH Open Loops',
    '## 🔴 Now — live incident',
    '- [ ] **Confirm which account was compromised.** Check from a clean device.',
    '## 🟠 This week',
    '- [ ] 🔴 **Ask whether the link was clicked.** → [[Incident note]]',
    '- [x] ~~**Old item**~~ ✅ 2026-10-01',
    '## ⚪ Waiting on vendor',
    '- [ ] **Vendor to confirm the BAA.**',
    '## 🎫 Ticketing',
    '- [ ] **Pick a ticketing tool** ⏫'
  ].join('\n')
  const tasks = parseTasks(loops, 'ARH Open Loops.md', '2026-10-15')
  assert.deepEqual(
    tasks.map((t) => [t.priority, [...(t.section ?? '')][0]]),
    [
      ['🔴', '🔴'],
      ['🔴', '🟠'],
      ['🟠', '🟠'],
      ['⚪', '⚪'],
      ['⏫', '🎫']
    ]
  )
  assert.equal(tasks[2]?.done, true)
  assert.ok(tasks.every((t) => t.due === undefined && !t.overdue))

  const work = [
    '# ARH Work Log',
    '## 2026-10-13 (Tuesday)',
    '### Documentation — phone work written up',
    '- wrote it up',
    '## 2026-10-09 (Friday)',
    '### 08:14 MT — Training packets',
    '- assembled packets',
    '### ~(time approx) — Handsets registered',
    '- two handsets'
  ].join('\n')
  const days = parseDatedEntries(work, 'ARH Work Log.md')
  assert.deepEqual(
    days.map((d) => [d.date, d.lines.length]),
    [
      ['2026-10-13', 2],
      ['2026-10-09', 4]
    ]
  )
  assert.equal(days[1]?.lines[0], '### 08:14 MT — Training packets')
})

test('searchVault finds lines with context and skips hidden folders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-search-'))
  try {
    await mkdir(join(dir, 'Reference'))
    await mkdir(join(dir, '.obsidian'))
    await writeFile(
      join(dir, 'Reference', 'Printers.md'),
      'line1\nThe LAPTOP-01 printer\nline3\n',
      'utf8'
    )
    await writeFile(join(dir, '.obsidian', 'x.md'), 'LAPTOP-01\n', 'utf8')
    const hits = await searchVault(dir, 'laptop-01')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.file, join('Reference', 'Printers.md'))
    assert.deepEqual(hits[0]?.before, ['line1'])
    assert.deepEqual(hits[0]?.after, ['line3'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function run(overrides: Partial<ScanRun> = {}): ScanRun {
  return {
    runId: 'r_1',
    deviceId: 'abc',
    serial: 'SER1',
    hostname: 'LAPTOP-01',
    os: 'windows',
    purpose: 'security-check',
    profile: 'windows-security-check',
    version: 1,
    title: 'Security Check',
    technician: 'Lisandro',
    startedAt: '2026-10-14T14:00:00.000Z',
    finishedAt: '2026-10-14T14:05:00.000Z',
    status: 'ok',
    checks: [],
    durationMs: 300000,
    health: {
      score: 'critical',
      metrics: { OS: 'Windows 11' },
      findings: [
        {
          id: 'antivirus:defender-off',
          severity: 'critical',
          category: 'Antivirus',
          message: 'Microsoft Defender antivirus is disabled',
          loop: true
        },
        {
          id: 'storage:disk-c',
          severity: 'warning',
          category: 'Storage',
          message: 'Disk C: has 9% free',
          loop: true
        },
        {
          id: 'perf:procs',
          severity: 'info',
          category: 'Performance',
          message: '310 processes running',
          loop: false
        }
      ]
    },
    ...overrides
  }
}

test('times are written in Mountain Time like the vault (MDT in October, MST in January)', () => {
  assert.deepEqual(zoned(new Date('2026-10-14T14:05:00Z'), 'America/Denver'), {
    date: '2026-10-14',
    time: '08:05'
  })
  assert.deepEqual(zoned(new Date('2026-01-10T05:30:00Z'), 'America/Denver'), {
    date: '2026-01-09',
    time: '22:30'
  })
})

test('content: open loops in vault style, no due dates, never duplicated, recurrence after a tick', () => {
  const today = new Date('2026-10-14T18:00:00Z')
  const first = mergeLoops(null, [run()], DEFAULT_CONTENT_OPTIONS, today)
  assert.equal(first.added, 2, 'info findings are not loops')
  const lines = first.body.split('\n')
  assert.equal(lines[0], '## 🩺 Device health findings — ARH IT Dashboard')
  const tasks = lines.filter((l) => l.startsWith('- ['))
  assert.match(
    tasks[0] ?? '',
    /^- \[ \] 🔴 \*\*LAPTOP-01 — Microsoft Defender antivirus is disabled\.\*\* Antivirus · Security Check scan 2026-10-14 08:05 MT · run r_1\. \^loop-[0-9a-f]{8}$/
  )
  assert.match(tasks[1] ?? '', /^- \[ \] 🟠 \*\*LAPTOP-01 — Disk C: has 9% free\.\*\*/)
  assert.ok(!first.body.includes('📅'), 'the vault uses no due dates')

  // a newer scan with a different number is the same finding: no duplicate while it is open
  const again = mergeLoops(
    first.body,
    [
      run(),
      run({
        runId: 'r_2',
        finishedAt: '2026-10-15T14:00:00.000Z',
        health: {
          ...run().health!,
          findings: run().health!.findings.map((f) =>
            f.category === 'Storage' ? { ...f, message: 'Disk C: has 7% free' } : f
          )
        }
      })
    ],
    DEFAULT_CONTENT_OPTIONS,
    today
  )
  assert.equal(again.added, 0)
  assert.equal(again.body, first.body)

  // ticked, then reported by the same scan again: nothing; by a later scan: a new line
  const ticked = first.body.replace('- [ ] 🔴 **LAPTOP-01', '- [x] 🔴 **LAPTOP-01')
  const same = mergeLoops(ticked, [run()], DEFAULT_CONTENT_OPTIONS, today)
  assert.equal(same.added, 0)
  assert.ok(same.body.includes('- [x] 🔴 **LAPTOP-01'), 'technician progress is preserved')
  assert.deepEqual(countOpenLoops(same.body), { open: 1, done: 1 })
  const later = mergeLoops(
    ticked,
    [run(), run({ runId: 'r_3', finishedAt: '2026-10-20T15:00:00.000Z' })],
    DEFAULT_CONTENT_OPTIONS,
    today
  )
  assert.equal(later.added, 1, 'only the ticked finding comes back; the open one is not doubled')
  const back = later.body.split('\n').at(-1) ?? ''
  assert.match(
    back,
    /^- \[ \] 🔴 \*\*LAPTOP-01 — Microsoft Defender.*run r_3\. Back after being ticked \(occurrence 2\)\. \^loop-[0-9a-f]{8}-2$/
  )

  // an older scan of the same profile no longer counts once a newer one exists
  const fixed = run({
    runId: 'r_4',
    finishedAt: '2026-10-21T15:00:00.000Z',
    health: { score: 'healthy', metrics: {}, findings: [] }
  })
  assert.equal(mergeLoops(null, [run(), fixed], DEFAULT_CONTENT_OPTIONS, today).added, 0)

  // other due styles remain available
  const withDue = mergeLoops(
    null,
    [run()],
    { ...DEFAULT_CONTENT_OPTIONS, dueStyle: 'tasks-emoji' },
    today
  )
  assert.match(withDue.body, /run r_1\. 📅 2026-10-15 \^loop-/)
})

test('content: work log entries newest first, MT times, duration, findings as sub-bullets, append-only', () => {
  const log1 = mergeLog(null, [run()])
  assert.equal(log1.added, 1)
  const l1 = log1.body.split('\n')
  assert.equal(l1[0], '## 🖥️ Device scans — ARH IT Dashboard')
  assert.equal(
    l1[4],
    '- 2026-10-14 08:05 MT · **LAPTOP-01** · serial SER1 · Security Check · windows-security-check v1 · ok · 5 min 0 s · 3 findings · Lisandro · run r_1'
  )
  assert.deepEqual(l1.slice(5), [
    '    - 🔴 Microsoft Defender antivirus is disabled',
    '    - 🟠 Disk C: has 9% free'
  ])
  const failed = run({
    runId: 'r_2',
    finishedAt: '2026-10-14T15:10:00.000Z',
    status: 'failed',
    error: 'link lost during check sec-logins',
    durationMs: 42000,
    health: { score: 'attention', metrics: {}, findings: [] }
  })
  const log2 = mergeLog(log1.body, [run(), failed])
  assert.equal(log2.added, 1)
  const entries = log2.body.split('\n').filter((l) => l.startsWith('- '))
  assert.equal(entries.length, 2)
  assert.ok(
    entries[0]?.includes('09:10 MT') &&
      entries[0].includes('failed: link lost during check sec-logins · 42 s · 0 findings')
  )
  assert.ok(entries[1]?.includes('run r_1'), 'older entry stays below')
  assert.equal(mergeLog(log2.body, [run(), failed]).added, 0)
  assert.equal(mergeLog(log2.body, [run(), failed]).body, log2.body)
})

const device = {
  id: 'abc',
  serial: 'SER1',
  hostname: 'LAPTOP-01',
  os: 'windows' as const,
  displayName: 'Front desk',
  enrolledAt: '2026-10-01T00:00:00Z',
  lastSeen: '2026-10-14T13:59:00Z',
  agentVersion: '0.2.0',
  profiles: []
}

test('content: Asset Inventory computers table keeps the technician columns and unknown rows', () => {
  const diag = run({
    runId: 'r_d',
    purpose: 'system-diagnostics',
    profile: 'windows-system-diagnostics',
    finishedAt: '2026-10-13T16:00:00.000Z',
    health: {
      score: 'healthy',
      metrics: {
        Model: 'Dell Inc. Latitude 3510',
        OS: 'Microsoft Windows 11 Pro 10.0.22631 (64-bit)'
      },
      findings: []
    },
    checks: [
      {
        id: 'net-adapters',
        title: 'Network adapters',
        category: 'Network',
        format: 'json',
        optional: false,
        status: 'ok',
        exitCode: 0,
        stdout: JSON.stringify([
          {
            name: 'USB link',
            status: 'Up',
            mac: '02-00-00-00-00-01',
            ipv4: ['169.254.10.2/16'],
            gateways: []
          },
          {
            name: 'Wi-Fi',
            status: 'Up',
            mac: 'AA-BB-CC-DD-EE-FF',
            ipv4: ['10.1.20.45/24'],
            gateways: ['10.1.20.1']
          }
        ]),
        stderr: '',
        timedOut: false,
        truncated: false,
        durationMs: 900
      }
    ]
  })
  const facts = deviceFacts([run(), diag], DEFAULT_CONTENT_OPTIONS)
  assert.deepEqual(facts, {
    lastScan: '2026-10-14 08:05 MT · Security Check · ok',
    health: '🔴 critical',
    model: 'Dell Inc. Latitude 3510',
    os: 'Windows 11',
    mac: 'AA-BB-CC-DD-EE-FF',
    ip: '10.1.20.45'
  })
  assert.deepEqual(lanAddress('not json'), {})

  const first = devicesBlock(null, [{ device, facts }], DEFAULT_CONTENT_OPTIONS)
  const t1 = readTable(first)
  assert.deepEqual(t1.header.slice(0, 12), [
    'Name',
    'Location',
    'Room / role',
    'Model',
    'Serial',
    'MAC',
    'IP',
    'OS',
    'Age',
    'Warranty',
    'PHI?',
    'Notes'
  ])
  assert.equal(t1.rows[0]?.['Room / role'], 'Front desk', 'enrollment label seeds the room')
  assert.equal(t1.rows[0]?.['PHI?'], '', 'PHI is never guessed')

  // the technician fills their columns and adds a row by hand
  const edited = first
    .replace('| LAPTOP-01 |  | Front desk |', '| LAPTOP-01 | Centennial | Front desk 2 |')
    .replace(
      /(\| Windows 11 \|) {2}\| {2}\| {2}\| {2}\|/,
      '$1 2021 | 2027-03 | yes | battery swapped |'
    )
    .concat(
      '\n| PRINTER-PC | Thornton | Back office |  |  |  |  |  |  |  |  | typed by hand |  |  |'
    )
  const second = devicesBlock(
    edited,
    [
      {
        device: { ...device, hostname: 'ARH-CEN-FD2' },
        facts: { ...facts, ip: '10.1.20.46', mac: undefined }
      }
    ],
    DEFAULT_CONTENT_OPTIONS
  )
  const t2 = readTable(second)
  assert.equal(t2.rows.length, 2)
  const row = t2.rows[0]!
  assert.equal(row['Name'], 'ARH-CEN-FD2', 'renamed computer matched by serial')
  assert.equal(row['Location'], 'Centennial')
  assert.equal(row['Room / role'], 'Front desk 2')
  assert.equal(row['Age'], '2021')
  assert.equal(row['Warranty'], '2027-03')
  assert.equal(row['PHI?'], 'yes')
  assert.equal(row['Notes'], 'battery swapped')
  assert.equal(row['IP'], '10.1.20.46', 'scan values refresh')
  assert.equal(row['MAC'], 'AA-BB-CC-DD-EE-FF', 'kept when the latest scans do not supply it')
  assert.equal(t2.rows[1]?.['Name'], 'PRINTER-PC', 'rows the dashboard does not know are kept')
  assert.equal(t2.rows[1]?.['Notes'], 'typed by hand')
  assert.equal(
    devicesBlock(
      second,
      [
        {
          device: { ...device, hostname: 'ARH-CEN-FD2' },
          facts: { ...facts, ip: '10.1.20.46', mac: undefined }
        }
      ],
      DEFAULT_CONTENT_OPTIONS
    ),
    second,
    'stable on rerun'
  )

  const pipes = devicesBlock(
    null,
    [{ device: { ...device, displayName: 'Exam | 2' }, facts }],
    DEFAULT_CONTENT_OPTIONS
  )
  assert.equal(
    readTable(pipes).rows[0]?.['Room / role'],
    'Exam \\| 2',
    'pipes are escaped, not column breaks'
  )

  const hub = healthBlock(
    [{ device, facts }],
    mergeLoops(null, [run()], DEFAULT_CONTENT_OPTIONS).body,
    DEFAULT_CONTENT_OPTIONS
  )
  assert.ok(
    hub.includes('| LAPTOP-01 | 🔴 critical | 2026-10-14 08:05 MT · Security Check · ok | 2 |')
  )
  assert.ok(hub.includes('[[Asset Inventory]]'))
})
