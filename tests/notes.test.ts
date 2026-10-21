import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('backlinks are the links the reader shows: tables, Markdown links, not code or comments', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-notes-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    const files: Record<string, string> = {
      'In code.md': '# A\n\n```\nExample: [[T-0001 Front desk printer]]\n```\n',
      'In comments.md':
        '# B\n\n%% old link [[T-0001 Front desk printer]] %%\n<!-- [[T-0001 Front desk printer]] -->\n',
      'In code span.md': '# C\n\nWrite `[[T-0001 Front desk printer]]` to link it.\n',
      'Markdown link.md':
        '# D\n\nSee\n[the printer ticket](Tickets/T-0001%20Front%20desk%20printer.md).\n',
      'Table.md':
        '# E\n\n| Asset | Ticket |\n| --- | --- |\n| ARH-P01 | [[T-0001 Front desk printer\\|T-0001]] |\n',
      'Property.md': '---\nrelated: "[[T-0001 Front desk printer]]"\n---\n# F\n'
    }
    for (const [name, text] of Object.entries(files)) await writeFile(join(vault, name), text)
    const notes = await new VaultIndex().notes(vault)
    const ticket = notes.find((n) => n.name === 'T-0001 Front desk printer')!
    const back = backlinks(ticket, notes)
      .filter((b) => b.title.length === 1)
      .map((b) => [b.title, b.line])
    assert.deepEqual(back.sort(), [
      ['D', 4],
      ['E', 5],
      ['F', 2]
    ])
    const table = noteView(notes.find((n) => n.name === 'Table')!, notes)
    assert.equal(table.links['T-0001 Front desk printer']?.file, ticket.rel)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("a backlink shows its line as the reader does: none of the line's comments", async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-notes-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    const link = '[[T-0001 Front desk printer]]'
    await writeFile(
      join(vault, 'Visit.md'),
      [
        '---',
        `related: "${link}" # Jane Roe, room 4`,
        '---',
        '# Visit',
        '',
        `Fixed ${link} %% patient Jane Roe, DOB 1970-01-02 %%`,
        `Also ${link} <!-- MRN 445566 -->`,
        '',
        'Called back %% patient Jane',
        `Roe, MRN 445566 %% re ${link}`,
        '',
        `Ran \`%% kept %%\` for ${link}`
      ].join('\n')
    )
    const notes = await new VaultIndex().notes(vault)
    const ticket = notes.find((n) => n.name === 'T-0001 Front desk printer')!
    const back = backlinks(ticket, notes)
      .filter((b) => b.title === 'Visit')
      .map((b) => [b.line, b.text])
    assert.deepEqual(back, [
      [2, `related: "${link}"`],
      [6, `Fixed ${link}`],
      [7, `Also ${link}`],
      [10, `re ${link}`],
      // a %% in code is code, and shows
      [12, `Ran \`%% kept %%\` for ${link}`]
    ])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test("a note's title in the viewer and its backlinks is the heading the reader shows", async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-notes-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    const link = 'Fixed [[T-0001 Front desk printer]]'
    const files: Record<string, string[]> = {
      // a heading in a comment, one with a comment, and a YAML comment in the properties
      'Visit.md': ['%% about', '# Patient Jane Roe MRN 445566', '%%', '# Visit', '', link],
      'Visit2.md': ['# Visit2 %% Jane Roe %%', '', link],
      'Visit3.md': [
        '---',
        '# patient Jane Roe, MRN 445566',
        'status: open',
        '---',
        '# Visit3',
        link
      ],
      'Visit4.md': ['<!-- # MRN 445566 -->', '```sh', '# not the title', '```', '# Visit4', link],
      // a heading of only a comment shows nothing: the file's name, as for a note with none
      'Visit5.md': ['# %% Jane Roe %%', '', '# Later', link],
      'Visit6.md': ['## Second level', '', link],
      // its text as the heading shows it, closing #s and markup read
      'Visit7.md': ['# Visit7 for **ARH-P01** #', '', link]
    }
    for (const [name, lines] of Object.entries(files))
      await writeFile(join(vault, name), lines.join('\n'))
    const notes = await new VaultIndex().notes(vault)
    const ticket = notes.find((n) => n.name === 'T-0001 Front desk printer')!
    const titles = backlinks(ticket, notes)
      .filter((b) => b.file.startsWith('Visit'))
      .map((b) => [b.file, b.title])
      .sort()
    assert.deepEqual(titles, [
      ['Visit.md', 'Visit'],
      ['Visit2.md', 'Visit2'],
      ['Visit3.md', 'Visit3'],
      ['Visit4.md', 'Visit4'],
      ['Visit5.md', 'Visit5'],
      ['Visit6.md', 'Visit6'],
      ['Visit7.md', 'Visit7 for ARH-P01']
    ])
    for (const [file, title] of titles) {
      const view = noteView(notes.find((n) => n.rel === file)!, notes)
      assert.equal(view.title, title)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('relative links (./, ../ and <…>) resolve from the linking note', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-notes-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    await mkdir(join(vault, 'Tickets', 'Sub'), { recursive: true })
    await writeFile(join(vault, 'Tickets', 'Sub', 'Deep.md'), '# Deep\n')
    await writeFile(join(vault, 'Tickets', 'Sub', 'F.md'), '# F\n\n[[./Deep]]\n')
    await writeFile(
      join(vault, 'Tickets', 'E.md'),
      '# E\n\n[[../Runbooks/Printer runbook]] [runbook](../Runbooks/Printer%20runbook.md)\n' +
        '[x](<T-0001 Front desk printer.md>) [[/Runbooks/Printer runbook]] [[../../Outside]]\n'
    )
    const notes = await new VaultIndex().notes(vault)
    const byName = (n: string) => notes.find((x) => x.name === n)!
    const e = noteView(byName('E'), notes).links
    const runbook = join('Runbooks', 'Printer runbook.md')
    assert.equal(e['../Runbooks/Printer runbook']?.file, runbook)
    assert.equal(e['/Runbooks/Printer runbook']?.file, runbook)
    assert.equal(
      e['T-0001 Front desk printer']?.file,
      join('Tickets', 'T-0001 Front desk printer.md')
    )
    assert.equal(e['../../Outside'], null)
    assert.equal(resolveLink('./Deep', byName('F'), notes)?.rel, join('Tickets', 'Sub', 'Deep.md'))
    assert.equal(
      resolveLink('./Deep', byName('E'), notes),
      null,
      'relative to the note, not the vault'
    )
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('a note the parser struggles with does not stop the notes it mentions from opening', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-notes-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    await writeFile(
      join(vault, 'Ticket 12.md'),
      `# Ticket 12\n\nPrinter down on [[T-0001 Front desk printer]]\n\n${'>'.repeat(3000)} x\n${'- '.repeat(3000)}y\n`
    )
    const notes = await new VaultIndex().notes(vault)
    const ticket = notes.find((n) => n.name === 'T-0001 Front desk printer')!
    const view = noteView(ticket, notes)
    assert.ok(view.backlinks.some((b) => b.title === 'Ticket 12'))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('a note of links nested 10000 deep opens, and its links count as backlinks', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'arh-notes-'))
  try {
    const vault = join(tmp, 'ARH IT')
    await cp(SOURCE, vault, { recursive: true })
    const nested = '['.repeat(10_000) + 'a' + '](https://x.org)'.repeat(10_000)
    await writeFile(
      join(vault, 'Ticket 13.md'),
      `# Ticket 13\n\nPrinter down on [[T-0001 Front desk printer]]\n\n${nested}\n`
    )
    const notes = await new VaultIndex().notes(vault)
    const t0 = performance.now()
    const view = noteView(notes.find((n) => n.name === 'Ticket 13')!, notes)
    assert.ok(performance.now() - t0 < 2000, 'opens without a long freeze')
    const ticket = notes.find((n) => n.name === 'T-0001 Front desk printer')!
    assert.equal(view.links['T-0001 Front desk printer']?.file, ticket.rel)
    assert.ok(noteView(ticket, notes).backlinks.some((b) => b.title === 'Ticket 13'))
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
