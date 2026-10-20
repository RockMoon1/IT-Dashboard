import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultIndex } from '../src/main/services/lookup/vaultindex.ts'
import { backlinks, noteView, resolveLink } from '../src/main/services/lookup/notes.ts'

const SOURCE = join(import.meta.dirname, 'fixtures', 'vault', 'ARH IT')

test('the viewer resolves [[links]] like Obsidian and lists what links back', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-notes-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    // two notes with the same name in different folders
    await writeFile(join(vault, 'Reference', 'Checklist.md'), '# Reference checklist\n')
    await writeFile(join(vault, 'Runbooks', 'Checklist.md'), '# Runbook checklist\n')
    await writeFile(
      join(vault, 'Runbooks', 'Uses checklist.md'),
      '# Uses\n\nSee [[Checklist]] and [[Reference/Checklist|the other one]].\n'
    )
    const notes = await new VaultIndex().notes(vault)
    const byName = (n: string) => notes.find((x) => x.name === n)!
    const loops = byName('ARH Open Loops')

    assert.equal(
      resolveLink('Asset Inventory', loops, notes)?.rel,
      join('Assets', 'Asset Inventory.md')
    )
    assert.equal(resolveLink('assets/asset inventory.md', loops, notes)?.name, 'Asset Inventory')
    assert.equal(resolveLink('No Such Note', loops, notes), null)
    const user = byName('Uses checklist')
    assert.equal(
      resolveLink('Checklist', user, notes)?.rel,
      join('Runbooks', 'Checklist.md'),
      'same folder wins'
    )
    assert.equal(
      resolveLink('Reference/Checklist', user, notes)?.rel,
      join('Reference', 'Checklist.md')
    )

    const view = noteView(loops, notes)
    assert.equal(view.title, 'ARH Open Loops')
    assert.deepEqual(view.frontmatter[0], ['tags', '[arh, openloops]'])
    assert.equal(view.links['ARH Work Log']?.file, 'ARH Work Log.md')
    assert.equal(
      view.links['Ticket — ARH-T01 — battery — 2026-10-09']?.title.startsWith('TKT-2026-901'),
      true
    )
    assert.ok(view.blocks.some((b) => b.t === 'list'))

    const inventory = byName('Asset Inventory')
    const back = backlinks(inventory, notes).map((b) => [b.title, b.line])
    assert.ok(back.some(([t]) => t === 'ARH Open Loops'))
    assert.ok(back.some(([t]) => t === 'ARH IT Hub'))
    assert.ok(
      back.every(([t]) => t !== 'Asset Inventory'),
      'a note is not its own backlink'
    )
    // a link to a different note with the same name is not a backlink
    const refList = backlinks(byName('Checklist'), notes)
    const other = notes.find((n) => n.rel === join('Reference', 'Checklist.md'))!
    assert.equal(backlinks(other, notes).length, 1, 'only the [[Reference/Checklist]] link')
    assert.ok(refList.length >= 1)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
