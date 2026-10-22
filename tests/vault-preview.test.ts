import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultWriter } from '../src/main/services/vault/writer.ts'
import { buildWritePlans, notePaths } from '../src/main/services/vault/plans.ts'
import { BLOCK_KEYS } from '../src/main/services/vault/content.ts'
import { unifiedDiff } from '../src/main/services/vault/diff.ts'
import { findBlock } from '../src/main/services/vault/markers.ts'
import { DEFAULT_SETTINGS } from '../src/main/services/settings.ts'
import type { HealthFinding, ScanRun } from '../src/shared/types.ts'
import type { EnrolledDevice } from '../src/main/services/link/devices.ts'

const FIXTURE = join(import.meta.dirname, 'fixtures', 'vault', 'ARH IT')

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

function run(id: string, at: string, findings: HealthFinding[] = []): ScanRun {
  return {
    runId: id,
    deviceId: 'dev1',
    serial: 'SN-TEST-01',
    hostname: 'EXAM2-LT',
    os: 'windows',
    purpose: 'security-check',
    profile: 'windows-security-check',
    version: 1,
    title: 'Security Check',
    technician: 'Lisandro',
    startedAt: at,
    finishedAt: at,
    status: 'ok',
    checks: [],
    durationMs: 42000,
    health: {
      score: findings.length ? 'critical' : 'healthy',
      metrics: { OS: 'Windows 11' },
      findings
    }
  }
}

const defenderOff: HealthFinding = {
  id: 'av',
  severity: 'critical',
  category: 'Antivirus',
  message: 'Defender is off',
  loop: true
}

/** A copy of the fixture vault and a live writer for it, removed when `use` ends. */
async function withVault(
  use: (
    vault: string,
    writer: VaultWriter,
    write: (runs: ScanRun[]) => Promise<void>
  ) => Promise<void>
): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-preview-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(FIXTURE, vault, { recursive: true })
    const writer = new VaultWriter({ appDataDir: join(tmp, 'appdata'), live: true })
    const settings = { ...DEFAULT_SETTINGS, vaultPath: vault }
    const write = async (runs: ScanRun[]): Promise<void> => {
      const results = await writer.apply(
        await buildWritePlans({ settings, devices: [device], runs, actions: [] })
      )
      assert.ok(
        results.every((r) => !r.error),
        JSON.stringify(results)
      )
    }
    await use(vault, writer, write)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function previewText(vault: string, writer: VaultWriter, runs: ScanRun[]): Promise<string> {
  const settings = { ...DEFAULT_SETTINGS, vaultPath: vault }
  const preview = await writer.preview(
    await buildWritePlans({ settings, devices: [device], runs, actions: [] })
  )
  return preview.map((p) => p.diff).join('\n')
}

test('the vault write preview shows no comment: context lines, typed lines and kept cells', async () => {
  // first write: the markers go at the end of a note, so its last lines are context
  await withVault(async (vault, writer) => {
    const loops = join(vault, 'ARH Open Loops.md')
    await writeFile(
      loops,
      (await readFile(loops, 'utf8')) + '%% asked by Jane Roe, MRN 445566 %%\n'
    )
    const log = join(vault, 'ARH Work Log.md')
    const text = await readFile(log, 'utf8')
    await writeFile(
      log,
      text.replace('# ARH Work Log\n', '# ARH Work Log\n<!-- John Doe DOB 1970-01-02 -->\n')
    )
    const shown = await previewText(vault, writer, [run('r_1', '2026-10-14T14:00:00Z')])
    assert.match(shown, /DASH:SCAN-LOG:START/)
    assert.doesNotMatch(shown, /Jane|John|445566|1970/)
  })
  // a line the technician typed in the Work Log block, shown as context of the next entry
  await withVault(async (vault, writer, write) => {
    await write([run('r_1', '2026-10-14T14:00:00Z')])
    const log = join(vault, 'ARH Work Log.md')
    const lines = (await readFile(log, 'utf8')).split('\n')
    lines.splice(
      lines.findIndex((l) => l.includes('run r_1')) + 1,
      0,
      '- called back %% Jane Roe MRN 445566 %%'
    )
    await writeFile(log, lines.join('\n'))
    const shown = await previewText(vault, writer, [
      run('r_1', '2026-10-14T14:00:00Z'),
      run('r_2', '2026-10-15T14:00:00Z')
    ])
    assert.match(shown, /run r_2/)
    assert.match(shown, /called back/)
    assert.doesNotMatch(shown, /Jane|445566/)
  })
  // the technician's Notes cell in the dashboard's computers row, rewritten on every scan
  await withVault(async (vault, writer, write) => {
    await write([run('r_1', '2026-10-14T14:00:00Z')])
    const inv = join(vault, 'Assets', 'Asset Inventory.md')
    const text = await readFile(inv, 'utf8')
    const row = text.split('\n').find((l) => l.startsWith('| EXAM2-LT '))
    assert.ok(row, 'the computers row')
    const cells = row.split(' | ')
    cells[11] = 'loaner %% for patient Jane Roe, MRN 445566 %%'
    await writeFile(inv, text.replace(row, cells.join(' | ')))
    const runs = [run('r_1', '2026-10-14T14:00:00Z'), run('r_2', '2026-10-15T14:00:00Z')]
    const shown = await previewText(vault, writer, runs)
    assert.match(shown, /2026-10-15 08:00 MT/, 'the changed Last scan cell still shows')
    assert.match(shown, /DASH:DEVICES:END/, 'and the markers')
    assert.doesNotMatch(shown, /Jane|445566/)
    // the preview hides it; the write keeps it as typed
    await write(runs)
    assert.match(
      await readFile(inv, 'utf8'),
      /loaner %% for patient Jane Roe, MRN 445566 %% \| 2026-10-15/
    )
  })
})

test('unifiedDiff counts the lines of a hunk at the end of a note from where they are', () => {
  assert.match(unifiedDiff('x', '', 'n').text, /^@@ -1,1 \+1,1 @@$/m)
  assert.match(unifiedDiff('a\nb', 'a\nb\nc\nd', 'n').text, /^@@ -1,2 \+1,4 @@$/m)
})

/** "Copy link to block" on the empty list's intro, or an id typed on the line under it. */
async function linkedIntro(link: (intro: string) => string, id: string): Promise<void> {
  await withVault(async (vault, _writer, write) => {
    const paths = notePaths({ ...DEFAULT_SETTINGS, vaultPath: vault })
    await write([])
    const lists = [
      [paths.workLog, BLOCK_KEYS.log],
      [paths.openLoops, BLOCK_KEYS.loops]
    ] as const
    const intros: string[] = []
    for (const [note, key] of lists) {
      const text = await readFile(note, 'utf8')
      const intro = (findBlock(text, key)?.body ?? '').split('\n')[2] ?? ''
      assert.match(intro, /^_.*_$/, `${note}: the intro`)
      intros.push(intro)
      await writeFile(note, text.replace(intro, link(intro)))
    }
    const linked = await Promise.all(lists.map(([n]) => readFile(n, 'utf8')))
    await write([])
    for (const [i, [note]] of lists.entries())
      assert.equal(await readFile(note, 'utf8'), linked[i], `${note}: nothing new, nothing written`)
    await write([run('r_1', '2026-10-14T14:05:00.000Z', [defenderOff])])
    for (const [i, [note, key]] of lists.entries()) {
      const body = (findBlock(await readFile(note, 'utf8'), key)?.body ?? '').split(/\r?\n/)
      const head = intros[i]!.slice(0, 40)
      assert.equal(body.filter((l) => l.startsWith(head)).length, 1, `${note}: one intro`)
      assert.equal(body.filter((l) => l.includes(id)).length, 1, `${note}: the id once`)
      const at = body.findIndex((l) => l.startsWith(head))
      assert.ok(
        body[at]!.endsWith(id) || body[at + 1]?.trim() === id,
        `${note}: the id with the intro`
      )
    }
  })
}

test('"Copy link to block" on the empty Work Log or Open Loops intro keeps the id on the intro', () =>
  linkedIntro((intro) => `${intro} ^intro1`, '^intro1'))

test("an id typed right under the empty Work Log or Open Loops intro stays the intro's", () =>
  linkedIntro((intro) => `${intro}\n^intro1`, '^intro1'))

/** Ids the technician typed with the empty list's intro: every one is kept by a write. */
async function introIds(
  link: (intro: string) => string,
  ids: string[],
  same: boolean
): Promise<void> {
  await withVault(async (vault, _writer, write) => {
    const paths = notePaths({ ...DEFAULT_SETTINGS, vaultPath: vault })
    await write([])
    for (const [note, key] of [
      [paths.workLog, BLOCK_KEYS.log],
      [paths.openLoops, BLOCK_KEYS.loops]
    ] as const) {
      const text = await readFile(note, 'utf8')
      const intro = (findBlock(text, key)?.body ?? '').split('\n')[2] ?? ''
      const typed = text.replace(intro, link(intro))
      await writeFile(note, typed)
      await write([])
      const after = await readFile(note, 'utf8')
      for (const id of ids) assert.ok(after.includes(id), `${note}: ${id} kept`)
      if (same) assert.equal(after, typed, `${note}: nothing new, nothing written`)
    }
  })
}

test('every id typed with the empty list intro is kept: at its end and on the lines under it', async () => {
  await introIds((i) => `${i} ^a1\n^b1`, ['^a1', '^b1'], true)
  await introIds((i) => `${i}\n^a1\n^b1`, ['^a1', '^b1'], true)
  // a build before this one kept a second copy of a linked intro, each with its own id
  await introIds((i) => `${i} ^a1\n\n${i} ^b1`, ['^a1', '^b1'], false)
})
