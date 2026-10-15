import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultWriter } from '../src/main/services/vault/writer.ts'
import { buildWritePlans, notePaths } from '../src/main/services/vault/plans.ts'
import { BLOCK_KEYS } from '../src/main/services/vault/content.ts'
import { findBlock } from '../src/main/services/vault/markers.ts'
import { parseTasks } from '../src/main/services/vault/reader.ts'
import { DEFAULT_SETTINGS } from '../src/main/services/settings.ts'
import type { ScanRun } from '../src/shared/types.ts'
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
  at: string
): ScanRun {
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
    // a scan that failed part way still gets logged and its partial findings recorded
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
      '2026-10-14T15:10:00.000Z'
    )
    const plans = await buildWritePlans({
      settings,
      devices: [device],
      connected: () => true,
      runs: [partial, first],
      now: new Date(2026, 9, 14)
    })

    const writer = new VaultWriter({ appDataDir: appData, live: false })
    const preview = await writer.preview(plans)
    assert.equal(preview.length, 3)
    for (const n of preview) {
      assert.equal(n.exists, true, `${n.notePath} should exist in the fixture`)
      assert.equal(n.changed, true)
      assert.ok(n.markersCreated.length >= 1, 'fixture notes have no markers yet')
      assert.ok(n.diff.length > 0)
      assert.equal(n.removed, 0, 'first write only adds lines')
    }
    for (const [f, text] of before)
      assert.equal(await readFile(join(vault, f), 'utf8'), text, `dry-run changed ${f}`)

    writer.setLive(true)
    const results = await writer.apply(plans)
    assert.ok(
      results.every((r) => r.written && !r.error),
      JSON.stringify(results)
    )
    assert.deepEqual(await listFiles(vault), filesBefore, 'no file created or removed in the vault')

    for (const [f, original] of before) {
      const now = await readFile(join(vault, f), 'utf8')
      if (![paths.hub, paths.workLog, paths.openLoops].includes(join(vault, f))) {
        assert.equal(now, original, `${f} must not change`)
        continue
      }
      assert.equal(stripBlocks(now), original, `${f}: text outside markers changed`)
    }

    const loopsText = await readFile(paths.openLoops, 'utf8')
    const tasks = parseTasks(loopsText, 'ARH Open Loops.md', '2026-10-14')
    const generated = tasks.filter((t) => t.text.startsWith('EXAM2-LT:'))
    assert.equal(generated.length, 2, 'two loop findings become tasks; the scan error does not')
    assert.equal(generated[0]?.due, '2026-10-15', 'critical: due next day')
    assert.equal(generated[1]?.due, '2026-10-21', 'warning: due in 7 days')
    const logBlock = findBlock(await readFile(paths.workLog, 'utf8'), BLOCK_KEYS.log)!.body
    assert.equal(logBlock.split(/\r?\n/).length, 2)
    assert.ok(logBlock.includes('· failed ·') && logBlock.includes('r_2'))
    const hubText = await readFile(paths.hub, 'utf8')
    assert.ok(hubText.includes('| Exam room 2 laptop 🟢 | SN-TEST-01 | windows |'))

    // the technician ticks a generated task; a rerun keeps it ticked and adds nothing twice
    await writeFile(
      paths.openLoops,
      loopsText.replace('- [ ] EXAM2-LT: Microsoft Defender', '- [x] EXAM2-LT: Microsoft Defender'),
      'utf8'
    )
    const again = await buildWritePlans({
      settings,
      devices: [device],
      connected: () => false,
      runs: [partial, first],
      now: new Date(2026, 9, 14)
    })
    const second = await writer.apply(again)
    const loops2 = await readFile(paths.openLoops, 'utf8')
    assert.ok(loops2.includes('- [x] EXAM2-LT: Microsoft Defender'))
    assert.equal(parseTasks(loops2, 'x').filter((t) => t.text.startsWith('EXAM2-LT:')).length, 2)
    assert.equal(
      second.find((r) => r.notePath === paths.workLog)?.written,
      false,
      'work log unchanged on rerun'
    )
    assert.ok(
      results.every((r) => r.backupPath && r.backupPath.startsWith(appData)),
      'backups live in app data'
    )

    // a OneDrive conflict copy appearing next to a note is reported after the write
    await writeFile(
      join(vault, 'ARH IT Hub-DESKTOP-ARH (conflicted copy 2026-10-14).md'),
      'x',
      'utf8'
    )
    const third = await writer.apply(
      await buildWritePlans({
        settings,
        devices: [device],
        connected: () => true,
        runs: [first],
        now: new Date(2026, 9, 15)
      })
    )
    assert.equal(third.find((r) => r.notePath === paths.hub)?.conflictCopies.length, 1)
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
      files.includes('ARH Open Loops.md')
  )
  for (const f of files.filter((x) => x.endsWith('.md'))) {
    const text = await readFile(join(SOURCE, f), 'utf8')
    assert.ok(
      !text.includes('<!-- DASH:'),
      `${f} in the fixture source has dashboard markers; a test wrote to the source`
    )
  }
})
