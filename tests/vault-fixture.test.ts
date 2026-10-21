import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultWriter } from '../src/main/services/vault/writer.ts'
import { buildWritePlans, notePaths } from '../src/main/services/vault/plans.ts'
import { BLOCK_KEYS, type ActionEntry } from '../src/main/services/vault/content.ts'
import { findBlock } from '../src/main/services/vault/markers.ts'
import { parseTasks } from '../src/main/services/vault/reader.ts'
import { DEFAULT_SETTINGS } from '../src/main/services/settings.ts'
import type { Measurement } from '../src/shared/actions.ts'
import type { HealthFinding, ScanRun } from '../src/shared/types.ts'
import type { EnrolledDevice } from '../src/main/services/link/devices.ts'

/**
 * Runs the writer against a COPY of a vault in a temp folder. By default the copy is made from
 * the synthetic fixture; set ARH_VAULT_FIXTURE to a sanitised copy of the real ARH IT vault to
 * exercise real notes. The source folder is never written to.
 */
const SOURCE =
  process.env['ARH_VAULT_FIXTURE'] ?? join(import.meta.dirname, 'fixtures', 'vault', 'ARH IT')

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFiles(p, base)))
    else out.push(p.slice(base.length + 1))
  }
  return out.sort()
}

/** Removes every managed block (and the blank line added before an appended block). */
function stripBlocks(text: string): string {
  let out = text
  for (const key of Object.values(BLOCK_KEYS)) {
    const b = findBlock(out, key)
    if (b) {
      // drop the block and the blank line the writer put before it, keeping the note's own EOL
      out =
        out.slice(0, b.start).replace(/(\r?\n)\r?\n$/, '$1') +
        out.slice(b.end).replace(/^\r?\n/, '')
    }
  }
  return out
}

const device: EnrolledDevice = {
  id: 'dev1',
  serial: 'SN-TEST-01',
  hostname: 'EXAM2-LT',
  os: 'windows',
  displayName: 'Exam room 2 laptop',
  enrolledAt: '2026-10-14T08:00:00Z',
  lastSeen: '2026-10-14T14:00:00Z',
  agentVersion: '0.2.0',
  profiles: []
}

function run(
  id: string,
  status: ScanRun['status'],
  findings: NonNullable<ScanRun['health']>['findings'],
  at: string,
  profile = 'windows-security-check'
): ScanRun {
  return {
    runId: id,
    deviceId: 'dev1',
    serial: 'SN-TEST-01',
    hostname: 'EXAM2-LT',
    os: 'windows',
    purpose: profile === 'windows-security-check' ? 'security-check' : 'slow-performance',
    profile,
    version: 1,
    title: 'Security Check',
    technician: 'Lisandro',
    startedAt: at,
    finishedAt: at,
    status,
    error: status === 'failed' ? 'check sec-logins failed' : undefined,
    checks: [],
    durationMs: 42000,
    health: {
      score: findings.some((f) => f.severity === 'critical') ? 'critical' : 'attention',
      metrics: { 'Defender AV': 'DISABLED' },
      findings
    }
  }
}

test('writer against a copy of the vault: dry-run first, then live writes touch only managed blocks', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-vault-copy-'))
  const appData = await mkdtemp(join(tmpdir(), 'arh-appdata-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    const before = new Map<string, string>()
    for (const f of await listFiles(vault))
      if (f.endsWith('.md')) before.set(f, await readFile(join(vault, f), 'utf8'))
    const filesBefore = await listFiles(vault)

    const settings = {
      ...DEFAULT_SETTINGS,
      vaultPath: vault,
      schemaApproved: true,
      vaultLive: true
    }
    const paths = notePaths(settings)
    const targets = [paths.assets, paths.openLoops, paths.workLog, paths.hub]
    const first = run(
      'r_1',
      'ok',
      [
        {
          id: 'av',
          severity: 'critical',
          category: 'Antivirus',
          message: 'Microsoft Defender antivirus is disabled',
          loop: true
        },
        {
          id: 'disk',
          severity: 'warning',
          category: 'Storage',
          message: 'Disk C: has 12% free (28 GB)',
          loop: true
        }
      ],
      '2026-10-14T14:05:00.000Z'
    )
    // a scan that failed part way still gets logged; its scan error is not an open loop
    const partial = run(
      'r_2',
      'failed',
      [
        {
          id: 'logins',
          severity: 'warning',
          category: 'Scan',
          message: 'Check "Failed sign-ins" failed (exit 1)',
          loop: false
        }
      ],
      '2026-10-14T15:10:00.000Z',
      'windows-slow-performance'
    )
    const plan = (runs: ScanRun[]): ReturnType<typeof buildWritePlans> =>
      buildWritePlans({ settings, devices: [device], runs, now: new Date('2026-10-14T18:00:00Z') })

    const writer = new VaultWriter({ appDataDir: appData, live: false })
    const preview = await writer.preview(await plan([partial, first]))
    assert.equal(preview.length, 4, 'Asset Inventory, Open Loops, Work Log and the hub')
    for (const n of preview) {
      assert.equal(n.exists, true, `${n.notePath} should exist in the fixture`)
      assert.equal(n.changed, true)
      assert.equal(n.markersCreated.length, 1, 'fixture notes have no markers yet')
      assert.ok(n.diff.length > 0)
      assert.equal(n.removed, 0, 'first write only adds lines')
    }
    for (const [f, text] of before)
      assert.equal(await readFile(join(vault, f), 'utf8'), text, `dry-run changed ${f}`)

    writer.setLive(true)
    const results = await writer.apply(await plan([partial, first]))
    assert.ok(
      results.every((r) => r.written && !r.error),
      JSON.stringify(results)
    )
    assert.deepEqual(await listFiles(vault), filesBefore, 'no file created or removed in the vault')

    for (const [f, original] of before) {
      const now = await readFile(join(vault, f), 'utf8')
      if (!targets.includes(join(vault, f))) {
        assert.equal(now, original, `${f} must not change`)
        continue
      }
      assert.equal(stripBlocks(now), original, `${f}: text outside markers changed`)
    }
    const hubText = await readFile(paths.hub!, 'utf8')
    assert.ok(!/[^\r]\n/.test(hubText), 'the hub keeps its CRLF line endings')
    assert.ok(
      hubText.includes(
        '| EXAM2-LT | 🔴 critical | 2026-10-14 09:10 MT · Slow Performance · failed | 2 |'
      )
    )

    const loopsText = await readFile(paths.openLoops, 'utf8')
    const tasks = parseTasks(loopsText, 'ARH Open Loops.md', '2026-10-14')
    const generated = tasks.filter((t) => t.raw.includes('**EXAM2-LT — '))
    assert.equal(generated.length, 2, 'two loop findings become tasks; the scan error does not')
    assert.deepEqual(
      generated.map((t) => [t.priority, t.due]),
      [
        ['🔴', undefined],
        ['🟠', undefined]
      ]
    )
    assert.deepEqual(
      tasks.filter((t) => !t.raw.includes('EXAM2-LT')).map((t) => t.raw),
      parseTasks(before.get('ARH Open Loops.md') ?? '', 'x').map((t) => t.raw),
      "Lisandro's own tasks are untouched"
    )

    const logBlock = findBlock(await readFile(paths.workLog, 'utf8'), BLOCK_KEYS.log)!.body
    const entries = logBlock.split(/\r?\n/).filter((l) => l.startsWith('- '))
    assert.equal(entries.length, 2)
    assert.ok(
      entries[0]?.startsWith('- 2026-10-14 09:10 MT · **EXAM2-LT**') &&
        entries[0].includes('· failed: ')
    )
    assert.ok(entries[1]?.includes('run r_1') && entries[1].includes('42 s'))

    const assets = findBlock(await readFile(paths.assets, 'utf8'), BLOCK_KEYS.devices)!.body
    assert.ok(assets.includes('| EXAM2-LT |  | Exam room 2 laptop |'))
    assert.ok(assets.includes('| SN-TEST-01 |'))

    // the technician fills a column in the table and ticks a loop; a rerun keeps both
    const stale = await plan([partial, first])
    await writeFile(
      paths.assets,
      (await readFile(paths.assets, 'utf8')).replace('| EXAM2-LT |  |', '| EXAM2-LT | Site A |'),
      'utf8'
    )
    await writeFile(
      paths.openLoops,
      loopsText.replace(
        '- [ ] 🔴 **EXAM2-LT — Microsoft Defender',
        '- [x] 🔴 **EXAM2-LT — Microsoft Defender'
      ),
      'utf8'
    )
    const refused = await writer.apply(stale)
    for (const note of [paths.assets, paths.openLoops])
      assert.match(
        refused.find((r) => r.notePath === note)?.error ?? '',
        /changed after the preview/,
        'a plan built before the edit is refused instead of overwriting it'
      )
    assert.ok((await readFile(paths.openLoops, 'utf8')).includes('- [x] 🔴 **EXAM2-LT'))
    const second = await writer.apply(await plan([partial, first]))
    const loops2 = await readFile(paths.openLoops, 'utf8')
    assert.ok(loops2.includes('- [x] 🔴 **EXAM2-LT — Microsoft Defender'))
    assert.equal(parseTasks(loops2, 'x').filter((t) => t.raw.includes('**EXAM2-LT — ')).length, 2)
    assert.ok((await readFile(paths.assets, 'utf8')).includes('| EXAM2-LT | Site A |'))
    for (const note of [paths.workLog, paths.assets, paths.openLoops])
      assert.equal(
        second.find((r) => r.notePath === note)?.written,
        false,
        `${note} unchanged on rerun`
      )
    assert.ok(
      results.every((r) => r.backupPath && r.backupPath.startsWith(appData)),
      'backups live in app data'
    )

    // the problem shows up again on a later scan: a new line, the ticked one stays
    const later = run(
      'r_3',
      'ok',
      [
        { ...first.health!.findings[0]! },
        { ...first.health!.findings[1]!, message: 'Disk C: has 10% free (23 GB)' }
      ],
      '2026-10-20T16:00:00.000Z'
    )
    await writer.apply(await plan([partial, first, later]))
    const loops3 = parseTasks(await readFile(paths.openLoops, 'utf8'), 'x').filter((t) =>
      t.raw.includes('**EXAM2-LT — ')
    )
    assert.deepEqual(
      loops3.map((t) => [t.done, /occurrence 2/.test(t.raw)]),
      [
        [true, false],
        [false, false],
        [false, true]
      ],
      'Defender comes back once; the open disk loop is not doubled'
    )

    // an edit landing between read and replace is never overwritten
    const current = await readFile(paths.workLog, 'utf8')
    await assert.rejects(
      writer.atomicWrite(paths.workLog, 'replacement', `${current}stale`),
      /changed while/
    )
    assert.equal(await readFile(paths.workLog, 'utf8'), current)
    assert.deepEqual(await readdir(join(appData, 'vault-tmp')), [], 'no temp file left behind')

    // a OneDrive conflict copy appearing next to a note is reported after the write
    await writeFile(
      join(vault, 'ARH IT Hub-DESKTOP-ARH (conflicted copy 2026-10-14).md'),
      'x',
      'utf8'
    )
    const third = await writer.apply(
      await plan([first, run('r_4', 'ok', [], '2026-10-21T16:00:00.000Z')])
    )
    assert.equal(third.find((r) => r.notePath === paths.hub)?.conflictCopies.length, 1)

    // an empty hub setting leaves the hub alone
    const noHub = await buildWritePlans({
      settings: { ...settings, hubNote: '' },
      devices: [device],
      runs: [first]
    })
    assert.equal(noHub.length, 3)
    assert.ok(noHub.every((p) => !p.notePath.endsWith('ARH IT Hub.md')))
  } finally {
    await rm(tmp, { recursive: true, force: true })
    await rm(appData, { recursive: true, force: true })
  }
})

function change(runId: string): ActionEntry {
  const when = '2026-10-14T16:00:00.000Z'
  const measured = (value: string): Measurement => ({
    items: [{ item: 'Firewall Public', value }],
    exitCode: 0
  })
  return {
    record: {
      runId,
      kind: 'action',
      mode: 'apply',
      deviceId: 'dev1',
      serial: 'SN-TEST-01',
      hostname: 'EXAM2-LT',
      displayName: 'Exam room 2 laptop',
      os: 'windows',
      link: 'cable',
      action: 'windows-firewall-on',
      version: 1,
      title: 'Turn on firewall profiles that are off',
      access: 'write',
      reason: 'Fix: Firewall profile "Public" is disabled',
      technician: 'Lisandro',
      requestedAt: when,
      startedAt: when,
      appliedAt: when,
      endedAt: when,
      status: 'changed',
      checks: [],
      result: {
        runId,
        kind: 'action',
        dryRun: false,
        applied: true,
        startedAt: when,
        before: measured('off'),
        apply: { items: null, exitCode: 0 },
        after: measured('on')
      }
    }
  }
}

test('a block id the technician linked a table or list by stays after it on every write', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-vault-ids-'))
  const appData = await mkdtemp(join(tmpdir(), 'arh-appdata-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    const settings = { ...DEFAULT_SETTINGS, vaultPath: vault, schemaApproved: true }
    const paths = notePaths(settings)
    const writer = new VaultWriter({ appDataDir: appData, live: true })
    const finding = (id: string, message: string): HealthFinding => ({
      id,
      severity: 'warning',
      category: 'Storage',
      message,
      loop: true
    })
    const disk = finding('disk', 'Disk C: has 12% free (28 GB)')
    const write = async (runs: ScanRun[], actions: ActionEntry[]): Promise<void> => {
      const plans = await buildWritePlans({ settings, devices: [device], runs, actions })
      const results = await writer.apply(plans)
      assert.ok(
        results.every((r) => !r.error),
        JSON.stringify(results)
      )
    }
    await write([run('r_1', 'ok', [disk], '2026-10-14T14:05:00.000Z')], [change('a_1')])
    // "Copy link to block" on a table puts the id on its own line after the table, a blank line
    // before it; a list is linked the same way. The END marker right under the last row or item
    // ends the table or list, so the id lands inside the markers (in the hub, before the
    // "Inventory:" line under the table)
    const table = (l: string): boolean => l.startsWith('|')
    const item = (l: string): boolean => /^\s*- /.test(l)
    const lastOf = (lines: string[], part: (l: string) => boolean): number =>
      lines.map(part).lastIndexOf(true)
    const blocks = [
      [paths.changeLog!, BLOCK_KEYS.changes, '^chg-table', table],
      [paths.assets, BLOCK_KEYS.devices, '^computers', table],
      [paths.hub!, BLOCK_KEYS.health, '^hub-table', table],
      [paths.workLog, BLOCK_KEYS.log, '^log-list', item],
      [paths.openLoops, BLOCK_KEYS.loops, '^loops-list', item]
    ] as const
    const bodyOf = async (note: string, key: string): Promise<string[]> =>
      findBlock(await readFile(note, 'utf8'), key)!.body.split(/\r?\n/)
    // a new scan finding and a new change
    const again = [
      run('r_2', 'ok', [disk, finding('temp', 'Temp folder is 9 GB')], '2026-10-15T14:05:00.000Z'),
      run('r_1', 'ok', [disk], '2026-10-14T14:05:00.000Z')
    ]
    const changes = [change('a_1'), change('a_2')]
    const stale = await buildWritePlans({
      settings,
      devices: [device],
      runs: again,
      actions: changes
    })
    for (const [note, key, id, part] of blocks) {
      const text = await readFile(note, 'utf8')
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      const body = findBlock(text, key)!.body
      const lines = body.split(/\r?\n/)
      lines.splice(lastOf(lines, part) + 1, 0, '', id)
      await writeFile(note, text.replace(body, lines.join(eol)), 'utf8')
    }
    // a plan built before the id was added is refused, not written over it
    const refused = await writer.apply(stale)
    for (const [note, key, id] of blocks) {
      assert.match(refused.find((r) => r.notePath === note)?.error ?? '', /changed after/, note)
      assert.ok((await bodyOf(note, key)).includes(id))
    }
    // a write with the new finding and change, then one with nothing new
    for (const pass of [1, 2]) {
      await write(again, changes)
      for (const [note, key, id, part] of blocks) {
        const body = await bodyOf(note, key)
        const at = body.indexOf(id)
        const where = `${id} in ${note}, write ${pass}`
        assert.equal(body.filter((l) => l === id).length, 1, where)
        assert.equal(body[at - 1], '', `${where}: a blank line before it`)
        assert.equal(at - 2, lastOf(body, part), `${where}: right after the last row or item`)
        if (key === BLOCK_KEYS.health) assert.match(body[at + 2] ?? '', /^Inventory: /, where)
        else assert.equal(at, body.length - 1, `${where}: last in the block`)
      }
      const rows = (await bodyOf(paths.changeLog!, BLOCK_KEYS.changes))
        .map((l) => / · run (a_\d) \|$/.exec(l)?.[1])
        .filter(Boolean)
      assert.deepEqual(rows, ['a_1', 'a_2'], 'one row per change')
      const loops = (await bodyOf(paths.openLoops, BLOCK_KEYS.loops)).filter(item)
      assert.deepEqual(
        loops.map((l) => /\*\*EXAM2-LT — (\w+)/.exec(l)?.[1]),
        ['Disk', 'Temp'],
        'the new finding joins the list, above its id'
      )
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
    await rm(appData, { recursive: true, force: true })
  }
})

test('two block ids after a table, a blank line before each, stay two ids on every write', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-vault-ids-'))
  const appData = await mkdtemp(join(tmpdir(), 'arh-appdata-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    const settings = { ...DEFAULT_SETTINGS, vaultPath: vault, schemaApproved: true }
    const paths = notePaths(settings)
    const writer = new VaultWriter({ appDataDir: appData, live: true })
    const first = run('r_1', 'ok', [], '2026-10-14T14:05:00.000Z')
    const write = async (runs: ScanRun[], actions: ActionEntry[]) => {
      const results = await writer.apply(
        await buildWritePlans({ settings, devices: [device], runs, actions })
      )
      assert.ok(
        results.every((r) => !r.error),
        JSON.stringify(results)
      )
      return results
    }
    await write([first], [change('a_1')])
    // an id Obsidian made and one typed by hand: "^a1b2c3" is one block, "^table" another
    const tables = [
      [paths.changeLog!, BLOCK_KEYS.changes],
      [paths.assets, BLOCK_KEYS.devices],
      [paths.hub!, BLOCK_KEYS.health]
    ] as const
    const ids = ['', '^a1b2c3', '', '^table']
    const lastRow = (lines: string[]): number =>
      lines.map((l) => l.startsWith('|')).lastIndexOf(true)
    for (const [note, key] of tables) {
      const text = await readFile(note, 'utf8')
      const body = findBlock(text, key)!.body
      const lines = body.split(/\r?\n/)
      lines.splice(lastRow(lines) + 1, 0, ...ids)
      await writeFile(note, text.replace(body, lines.join(text.includes('\r\n') ? '\r\n' : '\n')))
    }
    // nothing new, then a new scan and change
    const passes = [
      [[first], [change('a_1')], false],
      [
        [run('r_2', 'ok', [], '2026-10-15T14:05:00.000Z'), first],
        [change('a_1'), change('a_2')],
        true
      ]
    ] as const
    for (const [runs, actions, written] of passes) {
      const results = await write([...runs], [...actions])
      for (const [note, key] of tables) {
        const where = `${note}, ${written ? 'something new' : 'nothing new'}`
        assert.equal(results.find((r) => r.notePath === note)?.written, written, where)
        const lines = findBlock(await readFile(note, 'utf8'), key)!.body.split(/\r?\n/)
        const at = lastRow(lines) + 1
        assert.deepEqual(lines.slice(at, at + ids.length), ids, where)
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
    await rm(appData, { recursive: true, force: true })
  }
})

test('the fixture source itself is never modified', async () => {
  const files = await listFiles(SOURCE)
  assert.ok(
    files.includes('ARH IT Hub.md') &&
      files.includes('ARH Work Log.md') &&
      files.includes('ARH Open Loops.md') &&
      files.includes(join('Assets', 'Asset Inventory.md'))
  )
  for (const f of files.filter((x) => x.endsWith('.md'))) {
    const text = await readFile(join(SOURCE, f), 'utf8')
    assert.ok(
      !text.includes('<!-- DASH:'),
      `${f} in the fixture source has dashboard markers; a test wrote to the source`
    )
  }
})
