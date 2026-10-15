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
  devicesTable,
  scansBlock,
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
      ['2026-10-13', 1],
      ['2026-10-14', 2]
    ]
  )
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

test('content: loops merge keeps ticked lines and only appends new findings; log is append-only', () => {
  const today = new Date(2026, 9, 14)
  const first = mergeLoops(null, [run()], DEFAULT_CONTENT_OPTIONS, today)
  assert.equal(first.added, 2, 'info findings are not loops')
  const lines = first.body.split('\n')
  assert.match(
    lines[0] ?? '',
    /^- \[ \] LAPTOP-01: Microsoft Defender antivirus is disabled .* ⏫ 📅 2026-10-15 \^loop-[a-z0-9]+$/
  )
  assert.match(lines[1] ?? '', /📅 2026-10-21 \^loop-/)

  const ticked = first.body.replace(
    '- [ ] LAPTOP-01: Microsoft Defender',
    '- [x] LAPTOP-01: Microsoft Defender'
  )
  const second = mergeLoops(ticked, [run({ runId: 'r_2' })], DEFAULT_CONTENT_OPTIONS, today)
  assert.equal(second.added, 0, 'same findings are not duplicated')
  assert.ok(
    second.body.startsWith('- [x] LAPTOP-01: Microsoft Defender'),
    'technician progress is preserved'
  )
  assert.deepEqual(countOpenLoops(second.body), { open: 1, done: 1 })

  const log1 = mergeLog(null, [run()])
  assert.equal(log1.added, 1)
  assert.match(
    log1.body,
    /^- 2026-10-14 \d{2}:\d{2} · LAPTOP-01 \(SER1\) · Security Check · windows-security-check v1 · ok · 3 finding\(s\) · Lisandro · r_1$/
  )
  const log2 = mergeLog(log1.body, [run(), run({ runId: 'r_2' })])
  assert.equal(log2.added, 1)
  assert.equal(log2.body.split('\n').length, 2)

  const table = devicesTable([
    {
      device: {
        id: 'abc',
        serial: 'SER1',
        hostname: 'LAPTOP-01',
        os: 'windows',
        displayName: 'Front desk',
        enrolledAt: '2026-10-01T00:00:00Z',
        lastSeen: '2026-10-14T13:59:00Z',
        agentVersion: '0.2.0',
        profiles: []
      },
      connected: true,
      lastScan: {
        purpose: 'security-check',
        at: '2026-10-14T14:05:00Z',
        status: 'ok',
        score: 'critical'
      }
    }
  ])
  assert.ok(
    table.includes(
      '| Front desk 🟢 | SER1 | windows | 0.2.0 | 2026-10-14 13:59 | 2026-10-14 · Security Check · ok | critical |'
    )
  )
  const scans = scansBlock([run()], DEFAULT_CONTENT_OPTIONS)
  assert.ok(scans.startsWith('> [!info]- 2026-10-14 '))
  assert.ok(scans.includes('> - 🔴 Microsoft Defender antivirus is disabled'))
})
