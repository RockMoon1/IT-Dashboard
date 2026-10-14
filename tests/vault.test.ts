import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VaultError,
  appendToSection,
  appendUnderDateHeading,
  buildHubEntry,
  buildWorkLogEntry,
  checkVault,
  findSection,
  topInsertIndex,
  writeSessionToVault
} from '../src/main/services/vault/obsidian.ts'
import { DEFAULT_SETTINGS } from '../src/main/services/settings.ts'
import type { SessionSummary } from '../src/shared/types.ts'

const finished = new Date(2026, 9, 14, 14, 5) // local time, so date headings are predictable in any TZ

const summary: SessionSummary = {
  sessionId: 'abc123',
  deviceId: 'net:10.0.0.5',
  deviceName: 'LAPTOP-01',
  purpose: 'system-diagnostics',
  protocol: 'winrm',
  host: '10.0.0.5',
  targetOs: 'windows',
  startedAt: new Date(2026, 9, 14, 14, 0).toISOString(),
  finishedAt: finished.toISOString(),
  results: [],
  findings: ['Disk C: has only 8% free'],
  metrics: { OS: 'Windows 11 Pro', 'Disk C:': '8% free | pipe' },
  ok: true
}

test('appendToSection inserts at the end of an existing section, before the next heading', () => {
  const md =
    '# ARH IT Hub\n\n## Open Items\n- a\n\n## Device Scans\n\n> old entry\n\n## Links\n- x\n'
  const { text, created } = appendToSection(md, 'Device Scans', ['> new'])
  assert.equal(created, false)
  assert.equal(
    text,
    '# ARH IT Hub\n\n## Open Items\n- a\n\n## Device Scans\n\n> old entry\n\n> new\n\n## Links\n- x\n'
  )
})

test('appendToSection creates the section at the end of the note when missing', () => {
  const { text, created } = appendToSection('# Hub\n\nIntro\n', 'Device Scans', ['> new'])
  assert.equal(created, true)
  assert.equal(text, '# Hub\n\nIntro\n\n## Device Scans\n\n> new\n')
})

test('appendToSection keeps CRLF line endings and a single trailing newline', () => {
  const md = '# Hub\r\n\r\n## Device Scans\r\n\r\n> old\r\n'
  const { text } = appendToSection(md, 'Device Scans', ['> new'])
  assert.equal(text, '# Hub\r\n\r\n## Device Scans\r\n\r\n> old\r\n\r\n> new\r\n')
})

test('a section runs until the next heading of the same or higher level; subheadings stay inside', () => {
  const md = '## Device Scans\n\n### Sub\n- s\n\n## Next\n'
  const { text } = appendToSection(md, 'Device Scans', ['> new'])
  assert.equal(text, '## Device Scans\n\n### Sub\n- s\n\n> new\n\n## Next\n')
})

test('headings inside fenced code blocks do not end a section', () => {
  const md = '## Device Scans\n```\n## not a heading\n```\n\n## Next\n'
  const lines = md.split('\n')
  const s = findSection(lines, 'device scans')
  assert.deepEqual(s, { start: 0, end: 5 })
})

test('appendUnderDateHeading appends to the day matched by prefix and keeps list items together', () => {
  const md = '# Work Log\n\n## 2026-10-13\n- 09:00 · x\n\n## 2026-10-14 (Tue)\n- 10:00 · y\n'
  const { text, created } = appendUnderDateHeading(md, '2026-10-14', ['- 14:05 · z'])
  assert.equal(created, false)
  assert.equal(
    text,
    '# Work Log\n\n## 2026-10-13\n- 09:00 · x\n\n## 2026-10-14 (Tue)\n- 10:00 · y\n- 14:05 · z\n'
  )
})

test('appendUnderDateHeading creates a new day at the bottom by default', () => {
  const md = '---\ntags: log\n---\n# Work Log\n\n## 2026-10-13\n- a\n'
  const { text, created } = appendUnderDateHeading(md, '2026-10-14', ['- z'])
  assert.equal(created, true)
  assert.equal(
    text,
    '---\ntags: log\n---\n# Work Log\n\n## 2026-10-13\n- a\n\n## 2026-10-14\n\n- z\n'
  )
})

test('appendUnderDateHeading can put the new day right under the title when newestFirst is set', () => {
  const md = '---\ntags: log\n---\n# Work Log\n\n## 2026-10-13\n- a\n'
  assert.equal(topInsertIndex(md.split('\n')), 4)
  const { text } = appendUnderDateHeading(md, '2026-10-14', ['- z'], { newestFirst: true })
  assert.equal(
    text,
    '---\ntags: log\n---\n# Work Log\n\n## 2026-10-14\n\n- z\n\n## 2026-10-13\n- a\n'
  )
})

test('buildHubEntry is a foldable callout with escaped table cells', () => {
  const lines = buildHubEntry(summary, DEFAULT_SETTINGS, finished)
  assert.equal(lines[0], '> [!info]- 2026-10-14 14:05 · LAPTOP-01 · System Diagnostics')
  assert.ok(
    lines.every((l) => l.startsWith('>')),
    'every line stays inside the callout'
  )
  assert.ok(lines.includes('> - Disk C: has only 8% free'))
  assert.ok(lines.includes('> | Disk C: | 8% free \\| pipe |'))
  assert.ok(lines.some((l) => l.includes('[[ARH Work Log]]')))
})

test('buildWorkLogEntry is a single list item linking back to the hub section', () => {
  const lines = buildWorkLogEntry(summary, DEFAULT_SETTINGS, finished)
  assert.equal(lines.length, 1)
  const line = lines[0] ?? ''
  assert.ok(
    line.startsWith(
      '- 14:05 · Device scan · **LAPTOP-01** · System Diagnostics via WinRM (10.0.0.5)'
    )
  )
  assert.ok(line.includes('1 finding(s): Disk C: has only 8% free'))
  assert.ok(line.endsWith('see [[ARH IT Hub#Device Scans]]'))
})

test('writeSessionToVault never creates notes and appends to both when they exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-vault-'))
  try {
    const settings = { ...DEFAULT_SETTINGS, vaultPath: dir }
    const hubPath = join(dir, 'ARH IT Hub.md')
    const workLogPath = join(dir, 'ARH Work Log.md')

    await writeFile(hubPath, '# ARH IT Hub\n\n## Open Loops\n- none\n', 'utf8')
    await assert.rejects(
      writeSessionToVault(settings, summary),
      (err: unknown) => err instanceof VaultError && err.code === 'note-missing'
    )
    const check = await checkVault(settings)
    assert.equal(check.hubExists, true)
    assert.equal(check.workLogExists, false)
    assert.equal(check.hubSectionExists, false)
    assert.equal(check.problems.length, 1)

    await writeFile(workLogPath, '# ARH Work Log\n\n## 2026-10-13\n- 09:00 · earlier\n', 'utf8')
    const result = await writeSessionToVault(settings, summary)
    assert.equal(result.hubPath, hubPath)
    assert.ok(result.hubEntryLines > 3)
    assert.equal(result.workLogEntryLines, 1)

    const hub = await readFile(hubPath, 'utf8')
    assert.ok(
      hub.includes(
        '## Open Loops\n- none\n\n## Device Scans\n\n> [!info]- 2026-10-14 14:05 · LAPTOP-01'
      )
    )
    const log = await readFile(workLogPath, 'utf8')
    assert.ok(
      log.endsWith(
        '## 2026-10-14\n\n- 14:05 · Device scan · **LAPTOP-01** · System Diagnostics via WinRM (10.0.0.5) → 1 finding(s): Disk C: has only 8% free · see [[ARH IT Hub#Device Scans]]\n'
      )
    )

    // Second run on the same day joins the existing list instead of adding a blank line.
    await writeSessionToVault(settings, { ...summary, sessionId: 'def456', findings: [] })
    const log2 = await readFile(workLogPath, 'utf8')
    assert.ok(
      log2.includes(
        'see [[ARH IT Hub#Device Scans]]\n- 14:05 · Device scan · **LAPTOP-01** · System Diagnostics via WinRM (10.0.0.5) → no findings flagged'
      )
    )
    assert.equal((await checkVault(settings)).hubSectionExists, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeSessionToVault reports a missing vault folder', async () => {
  await assert.rejects(
    writeSessionToVault(
      { ...DEFAULT_SETTINGS, vaultPath: join(tmpdir(), 'arh-does-not-exist-' + Date.now()) },
      summary
    ),
    (err: unknown) => err instanceof VaultError && err.code === 'vault-missing'
  )
})
