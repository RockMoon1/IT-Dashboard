import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vaultText } from '../src/main/services/vault/content.ts'
import {
  headingKey,
  inlineText,
  parseInline,
  parseMarkdown,
  type Block,
  type Inline
} from '../src/shared/markdown.ts'

const kinds = (blocks: Block[]): string[] => blocks.map((b) => b.t)

test('frontmatter becomes properties and line numbers stay true to the file', () => {
  const md = [
    '---',
    'id: TKT-2026-007',
    'opened: 2026-09-23 11:31 MT',
    'tags:',
    '  - arh',
    '  - ticket',
    '---',
    '# TKT-2026-007 — Dell Latitude 3510 (ARH-COS)',
    '',
    'Battery drains overnight.'
  ].join('\n')
  const p = parseMarkdown(md)
  assert.deepEqual(p.frontmatter, [
    ['id', 'TKT-2026-007'],
    ['opened', '2026-09-23 11:31 MT'],
    ['tags', 'arh, ticket']
  ])
  assert.deepEqual(
    p.blocks.map((b) => [b.t, b.line]),
    [
      ['heading', 8],
      ['para', 10]
    ]
  )
  const h = p.blocks[0] as Extract<Block, { t: 'heading' }>
  assert.equal(h.text, 'TKT-2026-007 — Dell Latitude 3510 (ARH-COS)')
  // an unclosed --- at the top is a rule, not frontmatter
  assert.deepEqual(kinds(parseMarkdown('---\nnot frontmatter').blocks), ['hr', 'para'])
})

test('Open Loops shapes: priority sections, bold task titles, nested items, done dates', () => {
  const md = [
    '## 🔴 Now — live incident',
    '- [ ] **Confirm which account was used.** Check from a clean device. → [[ARH Work Log]]',
    '  - [x] asked the owner ✅ 2026-10-01',
    '  - note under it',
    '- [/] 🔴 **Ask whether the link was clicked.** ^loop-1a2b3c4d',
    '',
    '1. first',
    '2. second'
  ].join('\n')
  const p = parseMarkdown(md)
  assert.deepEqual(kinds(p.blocks), ['heading', 'list', 'list'])
  const list = p.blocks[1] as Extract<Block, { t: 'list' }>
  assert.deepEqual(
    list.items.map((it) => [it.line, it.task]),
    [
      [2, ' '],
      [5, '/']
    ]
  )
  const firstPara = list.items[0]!.c[0] as Extract<Block, { t: 'para' }>
  assert.equal(firstPara.c[0]?.t, 'strong')
  assert.ok(firstPara.c.some((x) => x.t === 'wiki' && x.target === 'ARH Work Log'))
  const nested = list.items[0]!.c[1] as Extract<Block, { t: 'list' }>
  assert.deepEqual(
    nested.items.map((it) => [it.line, it.task ?? null]),
    [
      [3, 'x'],
      [4, null]
    ]
  )
  const last = list.items[1]!.c[0] as Extract<Block, { t: 'para' }>
  assert.ok(!inlineText(last.c).includes('^loop'), 'block ids are hidden')
  const ordered = p.blocks[2] as Extract<Block, { t: 'list' }>
  assert.equal(ordered.ordered, true)
  assert.equal(ordered.items.length, 2)
  assert.deepEqual(p.links, ['ARH Work Log'])
})

test('callouts, quotes, code, tables and rules', () => {
  const md = [
    '> [!danger]- Synthetic fixture',
    '> Stand-in text with **bold**.',
    '> - a list inside',
    '',
    '> plain quote',
    '',
    '```powershell',
    'Get-HotFix | Sort-Object InstalledOn',
    '# not a heading',
    '```',
    '',
    '| Name | Notes |',
    '| --- | :-: |',
    '| ARH-T01 | uses \\| pipe and `a|b` |',
    '',
    '***'
  ].join('\n')
  const p = parseMarkdown(md)
  assert.deepEqual(kinds(p.blocks), ['callout', 'quote', 'code', 'table', 'hr'])
  const callout = p.blocks[0] as Extract<Block, { t: 'callout' }>
  assert.deepEqual(
    [callout.kind, callout.fold, inlineText(callout.title)],
    ['danger', '-', 'Synthetic fixture']
  )
  assert.deepEqual(kinds(callout.c), ['para', 'list'])
  const code = p.blocks[2] as Extract<Block, { t: 'code' }>
  assert.deepEqual(
    [code.lang, code.v],
    ['powershell', 'Get-HotFix | Sort-Object InstalledOn\n# not a heading']
  )
  const table = p.blocks[3] as Extract<Block, { t: 'table' }>
  assert.deepEqual(table.align, [null, 'center'])
  assert.equal(inlineText(table.rows[0]![1]!), 'uses | pipe and a|b')
  // a callout with no title gets its kind as the title
  const bare = parseMarkdown('> [!note]\n> body').blocks[0] as Extract<Block, { t: 'callout' }>
  assert.equal(inlineText(bare.title), 'Note')
})

test('comments and the dashboard markers are hidden, lines keep their numbers', () => {
  const md = [
    'before',
    '',
    '<!-- DASH:SCAN-LOG:START -->',
    '## 🖥️ Device scans — ARH IT Dashboard',
    '<!-- DASH:SCAN-LOG:END -->',
    '',
    'kept %% hidden %% text',
    '%%',
    'multi-line obsidian comment',
    '%%',
    'after <!-- inline --> end',
    '```',
    '<!-- inside code stays -->',
    '```'
  ].join('\n')
  const p = parseMarkdown(md)
  const texts = p.blocks.map((b) =>
    b.t === 'para' || b.t === 'heading' ? [b.line, inlineText(b.c)] : [b.line, b.t]
  )
  assert.deepEqual(texts, [
    [1, 'before'],
    [4, '🖥️ Device scans — ARH IT Dashboard'],
    [7, 'kept  text'],
    [11, 'after  end'],
    [12, 'code']
  ])
  assert.equal((p.blocks[4] as Extract<Block, { t: 'code' }>).v, '<!-- inside code stays -->')
})

test('inline: emphasis, code, links, wikilinks, tags and line breaks', () => {
  const md = parseInline(
    '**bold *nested* bold** _em_ ~~gone~~ ==mark== `a **b**` snake_case_name ***both***\nnext'
  )
  assert.deepEqual(
    md.map((x) => x.t),
    [
      'strong',
      'text',
      'em',
      'text',
      'del',
      'text',
      'mark',
      'text',
      'code',
      'text',
      'strong',
      'br',
      'text'
    ]
  )
  assert.ok(inlineText(md).includes('snake_case_name'), 'intraword underscores are text')
  const strong = md[0]
  assert.ok(strong && strong.t === 'strong')
  assert.equal(strong.c[1]?.t, 'em')

  const links = parseInline(
    'See [[INC-2026-001 — ARH Ticket 1 (consolidated)|the incident]], [[Runbook#Phase 2]], ![[diagram.png]], [site](https://example.org/x), [note](Tickets/T%201.md), https://learn.microsoft.com/a.b, and #close-criteria but not C#.'
  )
  const wikis = links.filter((x) => x.t === 'wiki')
  assert.deepEqual(
    wikis.map((w) =>
      w.t === 'wiki' ? [w.target, w.heading ?? null, w.alias ?? null, w.embed] : []
    ),
    [
      ['INC-2026-001 — ARH Ticket 1 (consolidated)', null, 'the incident', false],
      ['Runbook', 'Phase 2', null, false],
      ['diagram.png', null, null, true],
      ['Tickets/T 1', null, 'note', false]
    ]
  )
  const hrefs = links.filter((x) => x.t === 'link').map((x) => (x.t === 'link' ? x.href : ''))
  assert.deepEqual(hrefs, ['https://example.org/x', 'https://learn.microsoft.com/a.b'])
  assert.deepEqual(
    links.filter((x) => x.t === 'tag').map((x) => (x.t === 'tag' ? x.v : '')),
    ['close-criteria']
  )
})

test('nothing in a note becomes markup or a script link', () => {
  const evil = parseInline(
    '<script>alert(1)</script> [click](javascript:alert(1)) [f](file:///C:/x.exe) ![img](https://tracker.example/p.png) <img src=x onerror=alert(1)>'
  )
  assert.ok(!evil.some((x) => x.t === 'link'), 'only http(s) and mailto become links')
  const text = inlineText(evil)
  assert.ok(text.includes('<script>alert(1)</script>'), 'tags stay visible text, never markup')
  assert.ok(text.includes('[image: img]'), 'remote images are never fetched')
  assert.ok(text.includes('click') && !text.includes('javascript'))
})

test('a note with every construct parses in a few milliseconds and never loops', () => {
  const chunk = [
    '## Section',
    '- [ ] **item** [[Link]] #tag',
    '  - [x] sub',
    '> [!note] t',
    '> body',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '```',
    'code',
    '```',
    'para *x* _y_ `z` ==w== ~~v~~ * lone star _ lone underscore',
    ''
  ].join('\n')
  const big = Array.from({ length: 400 }, () => chunk).join('\n')
  const t0 = performance.now()
  const p = parseMarkdown(big)
  const ms = performance.now() - t0
  assert.equal(p.blocks.filter((b) => b.t === 'heading').length, 400)
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms for ${big.length} chars`)
  // unbalanced markers degrade to text instead of hanging
  assert.equal(inlineText(parseInline('**open `tick [[half ![x](')), '**open `tick [[half ![x](')
})

const texts = (blocks: Block[]): Array<[string, number, string]> =>
  blocks.map((b) => [
    b.t,
    b.line,
    b.t === 'para' || b.t === 'heading' ? inlineText(b.c) : b.t === 'code' ? b.v : ''
  ])

test('a bare "https://" is text, and parsing always moves on', () => {
  for (const s of [
    'https://',
    'see https:// now',
    'Admin page: https://<printer-ip>/admin',
    'x https://.'
  ]) {
    const c = parseInline(s)
    assert.ok(!c.some((x) => x.t === 'link'), s)
    assert.equal(inlineText(c), s)
  }
  assert.equal(inlineText(parseInline('**https://**')), 'https://')
  const table = parseMarkdown('| Admin | https:// |\n| - | - |\n| a | https:// |').blocks[0]
  assert.equal(table?.t, 'table')
})

test('comment markers inside code are text and hide nothing', () => {
  const md = [
    'Batch tip: `echo 100%%` prints a percent.',
    '',
    '## Next section',
    '',
    'The marker is `<!-- DASH:SCAN-LOG:START -->` in the note.',
    '',
    '> [!danger] Do not run on the DC',
    '> ```bat',
    '> echo 50%%',
    '> ```',
    '',
    '- [ ] task %% hidden %% after'
  ].join('\n')
  const p = parseMarkdown(md)
  assert.deepEqual(texts(p.blocks), [
    ['para', 1, 'Batch tip: echo 100%% prints a percent.'],
    ['heading', 3, 'Next section'],
    ['para', 5, 'The marker is <!-- DASH:SCAN-LOG:START --> in the note.'],
    ['callout', 7, ''],
    ['list', 12, '']
  ])
  const callout = p.blocks[3] as Extract<Block, { t: 'callout' }>
  assert.deepEqual(texts(callout.c), [['code', 8, 'echo 50%%']])
  const item = (p.blocks[4] as Extract<Block, { t: 'list' }>).items[0]!
  assert.deepEqual(texts(item.c), [['para', 12, 'task  after']])
  const cmd = parseInline('`for %%f in (*.log) do del %%f`')
  assert.deepEqual(cmd, [{ t: 'code', v: 'for %%f in (*.log) do del %%f' }])
})

test('an escaped \\%% or \\<!-- is text, as in Obsidian: what the writer escaped hides no row', () => {
  // what a technician typed, as the vault writer puts it in a table cell
  for (const typed of [
    'Audit item <!-- see ticket 12',
    'a <!-- b --> c',
    'odd 100%%% run',
    'pair 50%% ok',
    'Front desk laptop <!-- desk 2',
    '%%%%% <!--%% x'
  ]) {
    const md = `| A | B |\n|---|---|\n| 1 | ${vaultText(typed)} |\n| 2 | next row |\n\nafter`
    const p = parseMarkdown(md)
    assert.deepEqual(p.lines, md.split('\n'), typed)
    const table = p.blocks[0]
    assert.ok(table?.t === 'table', typed)
    assert.deepEqual(
      table.rows.map((r) => r.map(inlineText)),
      [
        ['1', typed],
        ['2', 'next row']
      ]
    )
    assert.deepEqual(texts(p.blocks.slice(1)), [['para', 6, 'after']], typed)
  }
  // typed in a note: a \ before the first character of a marker makes it text; an escaped \
  // before one does not, and a marker in a comment still ends it as written
  const md = [
    'Shown \\<!-- not a comment --> here',
    'Shown \\%% too',
    'Hidden \\\\<!-- secret --> b',
    'Hidden \\\\%% secret %% c',
    'Shown \\%\\%% d',
    'In %% secret \\%% e',
    '- [ ] Call back \\<!-- not a comment'
  ].join('\n\n')
  const p = parseMarkdown(md)
  assert.deepEqual(texts(p.blocks), [
    ['para', 1, 'Shown <!-- not a comment --> here'],
    ['para', 3, 'Shown %% too'],
    ['para', 5, 'Hidden \\ b'],
    ['para', 7, 'Hidden \\ c'],
    ['para', 9, 'Shown %%% d'],
    ['para', 11, 'In  e'],
    ['list', 13, '']
  ])
  const item = (p.blocks[6] as Extract<Block, { t: 'list' }>).items[0]!
  assert.deepEqual(texts(item.c), [['para', 13, 'Call back <!-- not a comment']])
  assert.deepEqual(
    p.lines.filter((l) => l),
    [
      'Shown \\<!-- not a comment --> here',
      'Shown \\%% too',
      'Hidden \\\\ b',
      'Hidden \\\\ c',
      'Shown \\%\\%% d',
      'In  e',
      '- [ ] Call back \\<!-- not a comment'
    ]
  )
})

test('a fence opened on a list item keeps the comments after it hidden', () => {
  const md = [
    '- ```ps',
    '  Get-X %% not a comment in code',
    '  ```',
    '',
    'Text %% private note %% end',
    '',
    '<!-- DASH:SCAN-LOG:START -->',
    '## Scans',
    '<!-- DASH:SCAN-LOG:END -->'
  ].join('\n')
  const p = parseMarkdown(md)
  assert.deepEqual(texts(p.blocks).slice(1), [
    ['para', 5, 'Text  end'],
    ['heading', 8, 'Scans']
  ])
  const code = (p.blocks[0] as Extract<Block, { t: 'list' }>).items[0]!.c[0]
  assert.deepEqual(code && texts([code]), [['code', 1, 'Get-X %% not a comment in code']])
})

test('escaped pipes in tables: aliased wikilinks and code cells read like Obsidian', () => {
  const md = [
    '| Asset | Ticket | Command |',
    '| --- | --- | --- |',
    '| ARH-P01 | [[T-0001 Front desk printer\\|T-0001]] | `Get-X \\| Select Name` |',
    '| ` | PowerShell escape | x |'
  ].join('\n')
  const p = parseMarkdown(md)
  const table = p.blocks[0] as Extract<Block, { t: 'table' }>
  const wiki = table.rows[0]![1]![0]
  assert.ok(wiki?.t === 'wiki')
  assert.deepEqual([wiki.target, wiki.alias], ['T-0001 Front desk printer', 'T-0001'])
  assert.deepEqual(table.rows[0]![2], [{ t: 'code', v: 'Get-X | Select Name' }])
  assert.deepEqual(table.rows[1]!.map(inlineText), ['`', 'PowerShell escape', 'x'])
  assert.deepEqual(p.links, ['T-0001 Front desk printer'])
  // the same link copied out of the table keeps its escape
  const copied = parseInline('[[T-0001 Front desk printer\\|T-0001]]')[0]
  assert.ok(copied?.t === 'wiki' && copied.target === 'T-0001 Front desk printer')
})

test('URLs keep the parentheses that belong to them', () => {
  const href = (s: string): string[] =>
    parseInline(s).flatMap((x) => (x.t === 'link' ? [x.href] : []))
  const docs = 'https://learn.microsoft.com/en-us/previous-versions/cc732443(v=ws.11)'
  assert.deepEqual(href(`[docs](${docs}) after`), [docs])
  assert.equal(inlineText(parseInline(`[docs](${docs}) after`)), 'docs after')
  assert.deepEqual(href(`see ${docs} now`), [docs])
  assert.deepEqual(href('https://en.wikipedia.org/wiki/Foo_(bar).'), [
    'https://en.wikipedia.org/wiki/Foo_(bar)'
  ])
  assert.deepEqual(href('(see https://example.org/kb)'), ['https://example.org/kb'])
  const angle = parseInline('[x](<Tickets/T 1.md>)')[0]
  assert.ok(angle?.t === 'wiki' && angle.target === 'Tickets/T 1')
})

test('a single * or _ is not closed inside a ** or __ run', () => {
  const shape = (c: Inline[]): unknown =>
    c.map((x) => ('c' in x ? { [x.t]: shape(x.c) } : x.t === 'text' ? x.v : x.t))
  assert.deepEqual(shape(parseInline('*Remember to run **sfc /scannow** first*')), [
    { em: ['Remember to run ', { strong: ['sfc /scannow'] }, ' first'] }
  ])
  assert.deepEqual(shape(parseInline('_a __b__ c_')), [{ em: ['a ', { strong: ['b'] }, ' c'] }])
  assert.deepEqual(shape(parseInline('*a **b***')), [{ em: ['a ', { strong: ['b'] }] }])
  assert.deepEqual(shape(parseInline('**a *b***')), [{ strong: ['a ', { em: ['b'] }] }])
})

test('block ids are hidden once, at the end of a block, and on their own line', () => {
  assert.equal(inlineText(parseInline('**x ^2** then text')), 'x ^2 then text')
  const md = ['| 1 | 2 |', '| - | - |', '| a | b |', '', '^table-1', '', 'para ^p-1'].join('\n')
  assert.deepEqual(texts(parseMarkdown(md).blocks), [
    ['table', 1, ''],
    ['para', 7, 'para']
  ])
  assert.deepEqual(kinds(parseMarkdown('> [!note]\n> body\n\n^callout-1').blocks), ['callout'])
  const h = parseMarkdown('## Heading ^h1').blocks[0] as Extract<Block, { t: 'heading' }>
  assert.equal(h.text, 'Heading')
})

test('frontmatter: block scalars, nested keys and quoted values', () => {
  const md = [
    '---',
    'desc: |',
    '  multi',
    '  line',
    'summary: >-',
    '  folded',
    '  text',
    'parent:',
    '  child: x',
    'time: "11:31"',
    "owner: 'O''Brien'",
    'tags:',
    '  - "arh"',
    '---',
    'body'
  ].join('\n')
  assert.deepEqual(parseMarkdown(md).frontmatter, [
    ['desc', 'multi\nline'],
    ['summary', 'folded text'],
    ['parent', 'child: x'],
    ['time', '11:31'],
    ['owner', "O'Brien"],
    ['tags', 'arh']
  ])
})

test('indented code after a blank line is literal code', () => {
  const md = [
    'Intro paragraph.',
    '',
    '    Get-Service | Where Status -eq *Running*',
    '    C:\\\\Temp\\\\x %% not a comment',
    '',
    'After.',
    '- item',
    '',
    '    continued item text'
  ].join('\n')
  const p = parseMarkdown(md)
  assert.deepEqual(texts(p.blocks).slice(0, 3), [
    ['para', 1, 'Intro paragraph.'],
    ['code', 3, 'Get-Service | Where Status -eq *Running*\nC:\\\\Temp\\\\x %% not a comment'],
    ['para', 6, 'After.']
  ])
  const item = (p.blocks[3] as Extract<Block, { t: 'list' }>).items[0]!
  assert.deepEqual(texts(item.c), [
    ['para', 7, 'item'],
    ['para', 9, 'continued item text']
  ])
})

test('only a list that starts at 1 interrupts a paragraph', () => {
  const p = parseMarkdown(
    'The laptop was bought in\n2024. It was refurbished.\n1. first\n2. second'
  )
  assert.deepEqual(kinds(p.blocks), ['para', 'list'])
  const para = p.blocks[0] as Extract<Block, { t: 'para' }>
  assert.equal(inlineText(para.c), 'The laptop was bought in 2024. It was refurbished.')
  assert.equal((p.blocks[1] as Extract<Block, { t: 'list' }>).items.length, 2)
})

test('table rows keep their own source lines', () => {
  const md = ['# Change log', '', '| Date | Change |', '| - | - |', '| 1 | a |', '| 2 | b |']
  const table = parseMarkdown(md.join('\n')).blocks[1] as Extract<Block, { t: 'table' }>
  assert.equal(table.line, 3)
  assert.deepEqual(table.rowLines, [5, 6])
})

test('heading links match headings the way Obsidian writes them', () => {
  const same = (a: string, b: string): void => assert.equal(headingKey(a), headingKey(b))
  same('08:55 MT — Backup job checked', '08 55 MT — Backup job checked')
  same('Step 1: Setup', 'step 1 setup')
  same('[[2026-10-14]] (Wednesday)', '2026-10-14 (Wednesday)')
  same('2026-10-13 — **Tuesday**', '2026-10-13 — Tuesday')
  assert.notEqual(headingKey('Step 1'), headingKey('Step 2'))
})

test('a long paragraph of unmatched openers parses in linear time', () => {
  const runs = ['*a ', '_b ', '[[c ', '[d ', '~~e ', '==f ', '**g ', '*h _i [[j [k ']
  const line = runs.map((u) => u.repeat(Math.ceil(25_000 / u.length))).join('')
  // ~200 KB as one long line, then as one paragraph of 80-character lines: about 100 ms when
  // each opener costs one step, minutes when each one scans to the end of the paragraph
  for (const text of [line, line.replace(/(.{80})/g, '$1\n')]) {
    const t0 = performance.now()
    const p = parseMarkdown(text)
    const ms = performance.now() - t0
    assert.ok(ms < 500, `took ${ms.toFixed(0)} ms for ${text.length} chars`)
    assert.equal(p.blocks.length, 1)
    const para = p.blocks[0] as Extract<Block, { t: 'para' }>
    if (text === line) assert.equal(inlineText(para.c), line.trim(), 'every opener stays text')
  }
})

test('code in a callout keeps its %% and a quoted fence line does not close a top-level fence', () => {
  // a batch command in an indented code block inside a callout
  const batch = parseMarkdown('> [!note] Batch\n>\n>     for %%i in (*) do echo %%i').blocks
  const callout = batch[0]
  assert.equal(callout?.t, 'callout')
  const code = callout?.t === 'callout' ? callout.c[0] : undefined
  assert.equal(code?.t, 'code')
  assert.equal(code?.t === 'code' ? code.v : '', 'for %%i in (*) do echo %%i')
  // "> ```" inside a top-level fence is text; the fence ends at its own "```"
  const md = '```\n> ```\necho 100%%\n```\nafter %% hidden %%'
  const blocks = parseMarkdown(md).blocks
  assert.deepEqual(kinds(blocks), ['code', 'para'])
  assert.equal(blocks[0]?.t === 'code' ? blocks[0].v : '', '> ```\necho 100%%')
  assert.equal(inlineText(blocks[1]?.t === 'para' ? blocks[1].c : []).trim(), 'after')
})

test('very deep quotes and lists are read as text instead of overflowing the stack', () => {
  for (const md of ['>'.repeat(3000) + ' x', '> '.repeat(3000) + 'x', '- '.repeat(3000) + 'x']) {
    const t0 = Date.now()
    const p = parseMarkdown(`before\n\n${md}\n\nafter`)
    assert.ok(Date.now() - t0 < 2000, 'still fast')
    const last = p.blocks.at(-1)
    assert.equal(last?.t === 'para' ? inlineText(last.c) : '', 'after')
  }
})

type List = Extract<Block, { t: 'list' }>
type Callout = Extract<Block, { t: 'callout' }>

test('a list item reads on from where its text starts, in a callout and at the top', () => {
  // 4 columns into the quote but 1 past the item's text: the item's second paragraph, so text
  const md = [
    '> [!note] Front desk printer',
    '> 1. Stop the spooler.',
    '>',
    '>     Check the queue first %% ask Maria (front desk) before clearing it %%',
    '> 2. Start it again.'
  ].join('\n')
  const steps = (parseMarkdown(md).blocks[0] as Callout).c[0] as List
  assert.deepEqual(texts(steps.items[0]!.c), [
    ['para', 2, 'Stop the spooler.'],
    ['para', 4, 'Check the queue first']
  ])
  // 4 columns past an item's text after a blank line: code in the item, its %% kept
  const logs = parseMarkdown(
    '1. Rename the logs:\n\n       for %%f in (*.log) do ren "%%f" "%%~nf.old"\n\n2. Check'
  ).blocks[0] as List
  assert.deepEqual(
    logs.items.map((it) => texts(it.c)),
    [
      [
        ['para', 1, 'Rename the logs:'],
        ['code', 3, 'for %%f in (*.log) do ren "%%f" "%%~nf.old"']
      ],
      [['para', 5, 'Check']]
    ]
  )
})

test('an indented code line that starts with ">" stays in the code block', () => {
  const md = [
    'Script:',
    '',
    '    @echo off',
    '    > "%TEMP%\\list.txt" dir /b',
    '    for /f %%f in (%TEMP%\\list.txt) do echo %%f'
  ].join('\n')
  assert.deepEqual(texts(parseMarkdown(md).blocks), [
    ['para', 1, 'Script:'],
    [
      'code',
      3,
      '@echo off\n> "%TEMP%\\list.txt" dir /b\nfor /f %%f in (%TEMP%\\list.txt) do echo %%f'
    ]
  ])
})

test('a fence opened after a list marker and a quote marker closes there', () => {
  const md = [
    '- Output:',
    '- > ```',
    '  > ipconfig /all',
    '  > ```',
    '',
    'After the fix %% private: called Dr. X at home %% done.'
  ].join('\n')
  const p = parseMarkdown(md)
  assert.deepEqual(texts(p.blocks), [
    ['list', 1, ''],
    ['para', 6, 'After the fix  done.']
  ])
  const quote = (p.blocks[0] as List).items[1]!.c[0]
  assert.deepEqual(quote?.t === 'quote' && texts(quote.c), [['code', 2, 'ipconfig /all']])
})

test('only the first line of a quote can be a callout title', () => {
  for (const md of [
    '> Printer notes\n> [!todo] follow up\n>     Ask about %% patient name on the stuck job %% the queue',
    '>  [!note] Steps\n>     Ask about %% patient name on the stuck job %% the queue'
  ]) {
    const quote = parseMarkdown(md).blocks[0]
    assert.equal(quote?.t, 'quote', md)
    const para = quote?.t === 'quote' ? quote.c[0] : undefined
    assert.equal(para?.t, 'para', md)
    const text = para?.t === 'para' ? inlineText(para.c) : ''
    assert.ok(text.endsWith('Ask about  the queue'), text)
  }
})

test('a line that held only a comment is a blank line before the code after it', () => {
  const batch = parseMarkdown(
    '> [!note] Batch\n> %% reviewed 10/20 %%\n>     for %%i in (*.tmp) do del "%%i"'
  ).blocks[0] as Callout
  assert.deepEqual(texts(batch.c), [['code', 3, 'for %%i in (*.tmp) do del "%%i"']])
  const top = parseMarkdown(
    'Clean the temp folder:\n%% reviewed %%\n    for %%i in (*.tmp) do del "%%i"'
  )
  assert.deepEqual(texts(top.blocks), [
    ['para', 1, 'Clean the temp folder:'],
    ['code', 3, 'for %%i in (*.tmp) do del "%%i"']
  ])
})

test('a fence in a list item ends with the item', () => {
  // the closing fence was forgotten: item 2 is text again, and its comment is hidden
  const md = '1. Command:\n   ```\n   ipconfig\n2. Then note %% private: patient John Doe %% ok'
  const list = parseMarkdown(md).blocks[0] as List
  assert.deepEqual(
    list.items.map((it) => texts(it.c)),
    [
      [
        ['para', 1, 'Command:'],
        ['code', 2, 'ipconfig']
      ],
      [['para', 4, 'Then note  ok']]
    ]
  )
  // "- ````" ends the item's fence and opens one of its own, closed by the next item
  const next = parseMarkdown('- step\n  ```` x\n- ````\n- note %% hidden %%').blocks[0] as List
  assert.deepEqual(texts(next.items[2]!.c), [['para', 4, 'note']])
})

/** Every text node of a parsed note, in order. */
function textNodes(blocks: Block[]): string[] {
  const out: string[] = []
  const inline = (c: Inline[]): void => {
    for (const x of c) {
      if (x.t === 'text') out.push(x.v)
      else if ('c' in x) inline(x.c)
    }
  }
  for (const b of blocks) {
    if (b.t === 'para' || b.t === 'heading') inline(b.c)
    else if (b.t === 'quote') out.push(...textNodes(b.c))
    else if (b.t === 'callout') {
      inline(b.title)
      out.push(...textNodes(b.c))
    } else if (b.t === 'list') for (const it of b.items) out.push(...textNodes(it.c))
    else if (b.t === 'table') for (const row of [b.head, ...b.rows]) row.forEach(inline)
  }
  return out
}

test('hiding a comment at the start of a line does not make the rest a fence or code', () => {
  // a fence and indented code must start their line; after a comment they are text
  const fence = parseMarkdown('Steps:\n%% reviewed %%```\nCall %% patient John Doe %% back\n```')
  assert.deepEqual(texts(fence.blocks), [
    ['para', 1, 'Steps: ``` Call  back'],
    ['code', 4, '']
  ])
  const indent = parseMarkdown(
    'Steps:\n\n%% reviewed %%    net stop spooler\n    Call %% patient John Doe %% back'
  )
  assert.deepEqual(texts(indent.blocks), [
    ['para', 1, 'Steps:'],
    ['para', 3, 'net stop spooler Call  back']
  ])
  // the same in a callout and in a list item
  const callout = parseMarkdown(
    '> [!note] Steps\n>\n> %% reviewed %%    net stop spooler\n>     Call %% patient %% back'
  ).blocks[0] as Callout
  assert.deepEqual(texts(callout.c), [['para', 3, 'net stop spooler Call  back']])
  const item = parseMarkdown('- %% reviewed %%```\n  Call %% patient John Doe %% back')
    .blocks[0] as List
  assert.deepEqual(texts(item.items[0]!.c), [['para', 1, '``` Call  back']])
  // a line that held nothing but the comment is still a blank line
  const blank = parseMarkdown('Steps:\n%% reviewed %%\n    net stop spooler')
  assert.deepEqual(texts(blank.blocks), [
    ['para', 1, 'Steps:'],
    ['code', 3, 'net stop spooler']
  ])
})

test('a table needs a delimiter row as written, and a list item looks two lines ahead', () => {
  // "|---|---| %% checked %%" is not a delimiter row, so the line above it is no table head
  const fence = parseMarkdown(
    'Port | Use\n|---|---| %% checked 10/20 %%\n```| x\nCalled %% patient Jane Roe %% back'
  )
  assert.deepEqual(texts(fence.blocks), [
    ['para', 1, 'Port | Use |---|---|'],
    ['code', 3, 'Called %% patient Jane Roe %% back']
  ])
  const quoted = parseMarkdown('Port | Use\n|---|---| %% checked %%\n>     dir %%x%% | more')
  assert.deepEqual(texts(quoted.blocks), [
    ['para', 1, 'Port | Use |---|---|'],
    ['quote', 3, '']
  ])
  const quote = quoted.blocks[1]
  assert.deepEqual(quote?.t === 'quote' && texts(quote.c), [['code', 3, 'dir %%x%% | more']])
  // a real delimiter row still makes one, and comments in the cells are hidden
  const table = parseMarkdown('Port | Use %% note %%\n|---|---|\n| 445 | SMB %% patient %% |')
    .blocks[0] as Extract<Block, { t: 'table' }>
  assert.equal(table.t, 'table')
  assert.deepEqual([...table.head, ...table.rows[0]!].map(inlineText), [
    'Port',
    'Use',
    '445',
    'SMB'
  ])
  // a table start after a list item ends the item, so the quote in it is not a table head
  const md = '- Logs:\n- >     for %%f in (*.log) do type %%f | find "err"\n|---|---|\n|---|---|'
  const p = parseMarkdown(md)
  assert.deepEqual(kinds(p.blocks), ['list', 'table'])
  const logs = (p.blocks[0] as List).items[1]!.c[0]
  assert.deepEqual(logs?.t === 'quote' && texts(logs.c), [
    ['code', 2, 'for %%f in (*.log) do type %%f | find "err"']
  ])
})

test('a line that starts another block ends a table and heads none, as in GFM', () => {
  // the command's only pipe is in a %% pair: with it hidden the line has none, and either way
  // the line is quoted indented code, so the command shows whole
  const command = `for /f %%a in ('net view ^| find "fs"') do echo %%a`
  const codeOf = (md: string): string[] => {
    const code: Array<[number, string, string]> = []
    textAndCode(parseMarkdown(md).blocks, [], code)
    return code.map(([, , v]) => v)
  }
  const row = parseMarkdown(`| Share | Path |\n|---|---|\n| Scans | D:\\scans |\n>     ${command}`)
  assert.deepEqual(kinds(row.blocks), ['table', 'quote'])
  assert.equal((row.blocks[0] as Extract<Block, { t: 'table' }>).rows.length, 1)
  const quote = row.blocks[1]
  assert.deepEqual(quote?.t === 'quote' && texts(quote.c), [['code', 4, command]])
  // nor does a quote or a list item head a table, but a numbered line that goes on a paragraph
  // (one that starts at 2 lists nothing there) can
  for (const md of [`>     ${command}\n|---|---|`, `10) >     ${command}\n|---|---|`]) {
    assert.equal(parseMarkdown(md).blocks[0]?.t, md.startsWith('>') ? 'quote' : 'list', md)
    assert.deepEqual(codeOf(md), [command], md)
  }
  const ports = parseMarkdown('Ports:\n2. web | 443\n|---|---|').blocks
  assert.deepEqual(kinds(ports), ['para', 'table'])
  // and a delimiter row that is a list item makes none: the item holds a quote of code
  const item = 'Port | Use\n- |---|---|\n    >     > %% checked %%`x`'
  assert.deepEqual(kinds(parseMarkdown(item).blocks), ['para', 'list'])
  assert.deepEqual(codeOf(item), ['> %% checked %%`x`'])
  // a heading, a list item, a fence and a rule end a table too
  const ends = parseMarkdown(
    [
      ...['| a | b |', '|---|---|', '| 1 | 2 |', '# Next | step'],
      ...['| 3 | 4 |', '|---|---|', '- item | x'],
      ...['| 5 | 6 |', '|---|---|', '```', 'code | x', '```'],
      ...['| 7 | 8 |', '|---|---|', '***']
    ].join('\n')
  )
  assert.deepEqual(kinds(ends.blocks), [
    ...['table', 'heading', 'table', 'list'],
    ...['table', 'code', 'table', 'hr']
  ])
  assert.deepEqual(
    ends.blocks.flatMap((b) => (b.t === 'table' ? [b.rows.length] : [])),
    [1, 0, 0, 0]
  )
})

test("a list item's fence takes no lazy line: the item ends there, as in CommonMark", () => {
  const command = `for /f %%a in ('net view ^| find "fs"') do echo %%a`
  const read = (md: string): { text: string[]; code: string[] } => {
    const text: string[] = []
    const code: Array<[number, string, string]> = []
    textAndCode(parseMarkdown(md).blocks, text, code)
    return { text, code: code.map(([, , v]) => v) }
  }
  // the command's only pipe is in a %% pair: as written the line heads a table, and with the
  // comment hidden it would be an unindented line in the item's open fence; either way it is
  // not code, so the code block is the one line above it
  for (const [md, code] of [
    [`1. Find the file server:\n   \`\`\`bat\n   net view\n${command}\n|---|---|`, ['net view']],
    [`> - \`\`\`\n> ${command}\n> |---|---|`, ['']],
    ['- ~~~\nx %% a|b %% y\n| - | - |', ['']],
    ['- ~~~\nx | y %% start\n|---|---|\nend %% z', ['']],
    [
      '1. Run:\n   ```bat\n   ipconfig\nRestart %% asked Maria | front desk %% the spooler\n| - |',
      ['ipconfig']
    ],
    // with no table after it too, and in an item in an item
    ['- a\n  ```\n  x\nb %% secret %%', ['x']],
    ['- a\n  - ```\n    x\nb %% secret %%', ['x']]
  ] as const) {
    const got = read(md)
    assert.deepEqual(got.code, code, md)
    assert.ok(!got.text.some((v) => v.includes('%%') || v.includes('asked')), md)
  }
  // an indented line, a closed fence and a lazy line after text go on as before
  const item = parseMarkdown('- a\n  ```\n  x\n  ```\nb %% secret %%\n  c').blocks
  assert.deepEqual(kinds(item), ['list'])
  assert.deepEqual(texts((item[0] as List).items[0]!.c), [
    ['para', 1, 'a'],
    ['code', 2, 'x'],
    ['para', 5, 'b c']
  ])
})

test('a backtick is a code span here only where parseInline reads one', () => {
  // \` is a backtick, not a span: the comment after it is text, so it is hidden
  const esc = parseMarkdown('Run \\`%% patient John Doe %%` now').blocks
  assert.deepEqual(texts(esc), [['para', 1, 'Run `` now']])
  // \\ is a backslash, and the span after it keeps its comment markers
  const both = parseMarkdown('Run \\\\`%% kept %%` now').blocks[0]
  assert.deepEqual(both?.t === 'para' && both.c, [
    { t: 'text', v: 'Run \\' },
    { t: 'code', v: '%% kept %%' },
    { t: 'text', v: ' now' }
  ])
  // a span opened on one line of a paragraph closes on the next: the backtick that starts the
  // next line ends it, and what follows is text
  const multi = parseMarkdown('Run `cmd\n` %% patient John Doe %% `').blocks
  assert.deepEqual(textNodes(multi), ['Run ', '  `'])
  assert.ok(multi[0]?.t === 'para' && multi[0].c.some((x) => x.t === 'code' && x.v === 'cmd\n'))
  // a run left open in one paragraph does not reach into the next
  const apart = parseMarkdown('Run `cmd\n\n`%% kept %%` and %% hidden %%').blocks
  assert.deepEqual(textNodes(apart), ['Run `cmd', ' and'])
})

/** Every inline code span of a parsed note, in order. */
function codeSpans(blocks: Block[]): string[] {
  const out: string[] = []
  const inline = (c: Inline[]): void => {
    for (const x of c) {
      if (x.t === 'code') out.push(x.v)
      else if ('c' in x) inline(x.c)
    }
  }
  for (const b of blocks) {
    if (b.t === 'para' || b.t === 'heading') inline(b.c)
    else if (b.t === 'quote') out.push(...codeSpans(b.c))
    else if (b.t === 'callout') {
      inline(b.title)
      out.push(...codeSpans(b.c))
    } else if (b.t === 'list') for (const it of b.items) out.push(...codeSpans(it.c))
    else if (b.t === 'table') for (const row of [b.head, ...b.rows]) row.forEach(inline)
  }
  return out
}

test('a backtick in a link label, wikilink or URL is theirs, not the start of a code span', () => {
  // PowerShell's `n escape in a link label: parseInline reads the label on its own, so the next
  // line's spans are `Get-Printer` and `Restart-Service Spooler`, and the comment between them
  // is text, so it is hidden
  const ran = 'Ran `Get-Printer` for %% patient Jane Roe %% then `Restart-Service Spooler`'
  for (const see of [
    'See [the `n escape](https://learn.microsoft.com/powershell/about_special_characters)',
    'See [[Run`book]]',
    'See https://x.org/a`b',
    'See [x](https://x.org/a`b)'
  ]) {
    for (const md of [
      `${see}\n${ran}`,
      `> ${see}\n> ${ran}`,
      `- ${see}\n  ${ran}`,
      `${see} ${ran}`
    ]) {
      const blocks = parseMarkdown(md).blocks
      assert.ok(!textNodes(blocks).some((v) => v.includes('%%')), md)
      assert.deepEqual(codeSpans(blocks), ['Get-Printer', 'Restart-Service Spooler'], md)
    }
  }
  // the same on one line, which leaked before the lines were read apart too
  const one = parseMarkdown('[a `b](https://x.org) and `c` %% secret %% `d`').blocks
  assert.deepEqual(textNodes(one), ['a `b', ' and ', '  '])
  // and a span after such a link keeps the %% of its command
  const cmd = parseMarkdown('See [the `n escape](https://x.org) then `for %%f in (*) do echo %%f`')
  assert.deepEqual(codeSpans(cmd.blocks), ['for %%f in (*) do echo %%f'])
  // a reading only the whole paragraph shows: the emphasis that line 1 opens ends on line 2,
  // after the span its backtick opens there, so "` e* %% patient %% `" is no span
  const across = parseMarkdown('*a `b* c\nd` e* %% patient Jane Roe %% `f`').blocks
  assert.ok(!textNodes(across).some((v) => v.includes('%%')), JSON.stringify(across))
  assert.deepEqual(codeSpans(across), ['b* c\nd', 'f'])
  // and one only the table shows: the row's pipe in the wikilink splits its cells
  const row = parseMarkdown('| a | b |\n|---|---|\n| [[x|`y]] ` %% patient Jane Roe %% ` | z |')
  assert.ok(!textNodes(row.blocks).some((v) => v.includes('%%')), JSON.stringify(row.blocks))
  // the parser's own stand-ins are not taken from a note
  const own = parseMarkdown('a \uFDD1%% x %% b `\uFDD0%% k %%`').blocks
  assert.deepEqual(own[0]?.t === 'para' && own[0].c, [
    { t: 'text', v: 'a \uFFFD b ' },
    { t: 'code', v: '\uFFFD%% k %%' }
  ])
})

test('an indented fence takes off its indent, not the first letters of a tabbed line', () => {
  // the fence is 2 spaces in; a tab is 4 columns but one character, which was cut with "f"
  const top = parseMarkdown('  ```\n\tfor %%f in (*) do echo %%f\n   x\n  ```').blocks
  assert.deepEqual(texts(top), [['code', 1, 'for %%f in (*) do echo %%f\n x']])
})

test('a line of 120000 quote markers parses in linear time', () => {
  for (const md of ['> '.repeat(120_000) + 'x', '>'.repeat(120_000) + ' x']) {
    const t0 = performance.now()
    const p = parseMarkdown(`before\n\n${md}\n\nafter %% hidden %%`)
    const ms = performance.now() - t0
    // about 100 ms when each line is read once per level, seconds when once per marker
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms for ${md.length} chars`)
    const last = p.blocks.at(-1)
    assert.equal(last?.t === 'para' ? inlineText(last.c) : '', 'after')
  }
})

test('a line read for its code spans and comments takes a few readings, not one per comment', () => {
  const n = 10_000
  for (const md of [
    '`a` %% patient %% '.repeat(20_000),
    'x ` %% patient %% '.repeat(20_000),
    'See [the `n](https://x.org) `a` %% patient %% `b`\n'.repeat(5000),
    '*a `b* c\nd` e* %% patient %% `f`\n\n'.repeat(2000),
    '> '.repeat(120_000) + '`a %% kept %%` %% patient %%',
    // past the nesting limit the label is text, so its span is too
    '['.repeat(n) + 'a `b %% patient %%`' + '](https://x.org)'.repeat(n)
  ]) {
    const t0 = performance.now()
    const p = parseMarkdown(md)
    const ms = performance.now() - t0
    // 100 to 800 ms here
    assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms for ${md.slice(0, 30)}`)
    const text: string[] = []
    textAndCode(p.blocks, text, [])
    assert.ok(!text.some((v) => v.includes('patient')), md.slice(0, 30))
  }
})

/**
 * The best of 7 parses of each of two notes, taken in turn (a, b, a, b, ...), so that both see the
 * same load: test files run side by side, and timed one after the other a busy moment can fall
 * on one side only.
 */
function bestOfPair(a: string, b: string): [number, number] {
  let ta = Infinity
  let tb = Infinity
  for (let k = 0; k < 7; k++) {
    let t0 = performance.now()
    parseMarkdown(a)
    ta = Math.min(ta, performance.now() - t0)
    t0 = performance.now()
    parseMarkdown(b)
    tb = Math.min(tb, performance.now() - t0)
  }
  return [ta, tb]
}

test('a paragraph read again costs about its own lines, not the whole note again', () => {
  // the paragraph only the whole paragraph reads differently (see above), after and before
  // 10000 lines with comments: read again in full, the note took twice as long as without it
  const body = Array.from({ length: 10_000 }, (_, i) =>
    i % 7 === 0 ? '' : `Line ${i}: run \`Get-Printer -Name P${i}\` see [[Ticket ${i}]] %% n ${i} %%`
  ).join('\n')
  const para = '*a `b* c\nd` e* %% patient Jane Roe %% `f`'
  for (const md of [`${body}\n\n${para}`, `${para}\n\n${body}`]) {
    const [ms, alone] = bestOfPair(md, body)
    assert.ok(ms < alone * 1.5 + 10, `${ms.toFixed(0)} ms, ${alone.toFixed(0)} ms without it`)
    const text: string[] = []
    textAndCode(parseMarkdown(md).blocks, text, [])
    assert.ok(!text.some((v) => v.includes('patient')))
  }
})

test('a list item looks at the line after next only for a delimiter row', () => {
  // every lazy line with a pipe could start a table; a list item 64 deep would work out the
  // line after it at every level, and that line's next one, and so on
  const deep = Array.from({ length: 64 }, (_, d) => '  '.repeat(d) + '- x').join('\n')
  const md = `${deep}\n${'a|b %% hidden %%\n'.repeat(2000)}after`
  const t0 = performance.now()
  const p = parseMarkdown(md)
  const ms = performance.now() - t0
  // about 250 ms; 2.5 s without that check, and 23 s for 20000 lines
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`)
  assert.ok(!textNodes(p.blocks).some((v) => v.includes('%%')))
})

test('a list nested deep reads its lines about as fast as a quote nested as deep', () => {
  // every level of a list reads each line of its body again, and so does the comment pass: with
  // a line's indent worked out by regex, and twice, at each level (and an item match where the
  // item goes on), a list 16 deep took 2 to 4 times as long as the quote, and 5 times with one
  // comment when 64 deep; now about 1 and 2
  const nest = (d: number): string =>
    Array.from({ length: d }, (_, k) => '  '.repeat(k) + '- x').join('\n')
  const quote = (d: number, n: number): string => ('> '.repeat(d) + 'a step b\n').repeat(n)
  const lazy = `${nest(64)}\n${'a step b\n'.repeat(5000)}`
  for (const [md, q, most] of [
    [`${nest(16)}\n${('  '.repeat(16) + 'a step b\n').repeat(20_000)}`, quote(16, 20_000), 1.75],
    [lazy, quote(64, 5000), 1.5],
    [`${lazy}end %% patient Jane Roe %%`, quote(64, 5000), 3.25]
  ] as const) {
    const [ms, alone] = bestOfPair(md, q)
    assert.ok(ms < alone * most + 10, `${ms.toFixed(0)} ms, ${alone.toFixed(0)} ms for the quote`)
  }
  assert.ok(
    !textNodes(parseMarkdown(`${lazy}end %% patient Jane Roe %%`).blocks).some((v) =>
      v.includes('patient')
    )
  )
})

test('a line is read once for its code spans only where hiding its comments cannot change them', () => {
  // hidden where the text starts, the comment makes the # after it a tag, which takes the _ an
  // emphasis would have closed at; the code span then goes on into the next line, comment and
  // all. A comment that holds an emphasis delimiter changes them too
  for (const [md, span] of [
    ['%% printer %%#_`net stop spooler_ x\ny %% kept %%` z', 'net stop spooler_ x\ny %% kept %%'],
    ['%% *x %% `a*\ny %% kept %%` z', 'a*\ny %% kept %%']
  ] as const) {
    assert.deepEqual(codeSpans(parseMarkdown(md).blocks), [span], md)
  }
  // where it cannot, the line is as it was: quoted tasks and table rows with a comment before
  // their code
  const tasks = parseMarkdown('> - [ ] Step 1 %% patient Jane Roe %% `net stop spooler`').blocks
  assert.deepEqual(codeSpans(tasks), ['net stop spooler'])
  assert.ok(!textNodes(tasks).some((v) => v.includes('patient')))
  const row = parseMarkdown(
    '| a | b |\n|---|---|\n| r %% patient Jane Roe %% | `ipconfig` |'
  ).blocks
  assert.deepEqual(codeSpans(row), ['ipconfig'])
  assert.ok(!textNodes(row).some((v) => v.includes('patient')))
})

test('links nested 10000 deep parse quickly and stop nesting at a limit', () => {
  const n = 10_000
  const md = '['.repeat(n) + 'a' + '](https://x.org)'.repeat(n)
  const depth = (c: Inline[]): number =>
    Math.max(0, ...c.map((x) => ('c' in x ? 1 + depth(x.c) : 0)))
  // a few hundred ms each; without the limit, half a minute and then a stack overflow
  for (const text of [md, `*${md}*`]) {
    const t0 = performance.now()
    const para = parseMarkdown(text).blocks[0]
    const ms = performance.now() - t0
    assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms for ${text.length} chars`)
    assert.ok(para?.t === 'para' && depth(para.c) <= 40, 'past the limit a label is text')
    assert.ok(inlineText(para.c).includes('a' + '](https://x.org)'.repeat(n - 40)))
  }
  // a few levels still read as links
  const two = parseInline('[[x](https://a.org) and more](https://b.org)')
  assert.ok(two[0]?.t === 'link' && two[0].c[0]?.t === 'link')
  // nor does a label of 200000 parts overflow the stack
  const parts = parseInline('[' + '`a` '.repeat(200_000) + '](javascript:x)')
  assert.equal(parts.filter((x) => x.t === 'code').length, 200_000)
  // past the limit a label is text without the comments hidden in it, and without what stood
  // in for them
  for (const comment of ['%% patient Jane Roe %%', '<!-- patient Jane Roe -->']) {
    const deep = '['.repeat(40) + `a ${comment} b` + '](https://x.org)'.repeat(40)
    const text: string[] = []
    const all: string[] = []
    textAndCode(parseMarkdown(deep).blocks, text, [], all)
    assert.ok(
      all.every((v) => !v.includes('\uFDD0') && !v.includes('patient')),
      comment
    )
    assert.ok(text.join('').includes('[a  b](https://x.org)'), comment)
  }
})

test('a bare URL with a hidden comment in it ends where it ends', () => {
  for (const md of [
    'Open https://x.org/abc%% patient %%def now',
    'Open https://x.org/a<!-- x -->b<!-- y -->cdef now',
    'Open https://x.org/abc%% patient %%def. Then'
  ]) {
    const para = parseMarkdown(md).blocks[0]
    assert.ok(para?.t === 'para', md)
    assert.deepEqual(para.c.slice(0, 2), [
      { t: 'text', v: 'Open ' },
      { t: 'link', href: 'https://x.org/abcdef', c: [{ t: 'text', v: 'https://x.org/abcdef' }] }
    ])
    assert.equal(
      inlineText(para.c),
      md.endsWith('now') ? 'Open https://x.org/abcdef now' : 'Open https://x.org/abcdef. Then'
    )
  }
})

test('a task box that held only a comment is a plain item, as in Obsidian', () => {
  // the placeholder of the hidden comment was taken for the task's status ("[\uFDD0]")
  for (const md of [
    '- [%% Jane Roe %%] Call the vendor',
    '1. [<!-- MRN 445566 -->] Call the vendor',
    '> - [%%x%%] Call the vendor'
  ]) {
    const top = parseMarkdown(md).blocks[0]
    const list = top?.t === 'quote' ? top.c[0] : top
    assert.ok(list?.t === 'list', md)
    assert.equal(list.items[0]!.task, undefined, md)
    assert.deepEqual(textNodes(list.items[0]!.c), ['[] Call the vendor'], md)
  }
  const done = parseMarkdown('- [x] Called back %% Jane Roe %%').blocks[0] as List
  assert.equal(done.items[0]!.task, 'x')
})

test('a YAML comment after a property is not shown, nor is a link in it, as in Obsidian', () => {
  const md = [
    '---',
    'status: open # was for Jane Roe, room 4',
    'tags:',
    '  - printer # Jane Roe',
    '  - "a #b" # MRN 445566',
    'parent:',
    '  child: x # DOB 1970-01-02',
    "owner: 'O''Brien #2' # Jane",
    'color: "#fff"',
    'url: https://x.org/a#b',
    'note: # Jane Roe',
    'list: [a, "b #c"] # Jane',
    'desc: | # Jane Roe',
    '  as written # in a block',
    'id:#x',
    '# Jane Roe, the whole line',
    'related: "[[T-0001]]" # Jane Roe, see [[T-0002]]',
    '---',
    'body'
  ].join('\n')
  const p = parseMarkdown(md)
  assert.deepEqual(p.frontmatter, [
    ['status', 'open'],
    ['tags', 'printer, a #b'],
    ['parent', 'child: x'],
    ['owner', "O'Brien #2"],
    ['color', '#fff'],
    ['url', 'https://x.org/a#b'],
    ['note', ''],
    ['list', '[a, "b #c"]'],
    ['desc', 'as written # in a block'],
    // no space before the #: not a comment
    ['id', '#x'],
    ['related', '[[T-0001]]']
  ])
  assert.deepEqual(p.linkLines, [{ target: 'T-0001', line: 17 }])
  // a backlink from a property shows its line without the comment
  assert.equal(p.lines[16]?.trim(), 'related: "[[T-0001]]"')
  assert.ok(!p.lines.slice(0, 18).some((l) => /Jane|MRN|DOB/.test(l)))
})

test("a YAML comment less indented than a block scalar's text ends it, and a key holds none", () => {
  const link = '[[T-0001 Front desk printer]]'
  const md = [
    '---',
    'notes: |',
    '    Replaced the toner.',
    `  # ask Jane Roe (MRN 445566) about ${link}`,
    'status: open',
    'summary: >',
    '  called the vendor',
    ' # Jane Roe, DOB 1970-01-02',
    'steps: |2',
    '    kept indent',
    "  # content at the indicator's indent",
    ' # MRN 445566',
    'desc: |',
    '  # a heading in the text',
    '',
    '  more',
    ' # Jane Roe',
    'room: |',
    '    first',
    '\t# Jane Roe',
    // a blank line before the text indents it at least as far as its spaces
    'lead: |',
    '   ',
    '  # Jane Roe',
    'kept: >2-',
    '    as given',
    ' # MRN 445566',
    'parent:',
    '  child # Jane Roe: x',
    'tags:',
    '  - a',
    'room 4 # Jane Roe: yes',
    '---',
    'body'
  ].join('\n')
  const p = parseMarkdown(md)
  // as YAML reads it: PyYAML gives the same, except that it keeps the text's last line break
  // and, with an indent given, the spaces past it, that "child" (a plain line under a key) is
  // parent's value there, and that it takes neither the tab (a space before a comment in YAML,
  // not indent) nor "room 4 # Jane Roe: yes" (no key: its # starts a comment)
  assert.deepEqual(p.frontmatter, [
    ['notes', 'Replaced the toner.'],
    ['status', 'open'],
    ['summary', 'called the vendor'],
    ['steps', "kept indent\n# content at the indicator's indent"],
    ['desc', '# a heading in the text\n\nmore'],
    ['room', 'first'],
    ['lead', ''],
    ['kept', 'as given'],
    ['parent', ''],
    ['tags', 'a']
  ])
  // the comment's link is no link, and no line a backlink can show holds a comment
  assert.deepEqual(p.linkLines, [])
  assert.ok(!p.lines.slice(0, 32).some((l) => /Jane|MRN|DOB/.test(l)), p.lines.join('\n'))
  assert.equal(p.lines[32], 'body')
})

test("a link's line counts the note's line breaks: not a <br>, and those in a code span", () => {
  const md = [
    '| Date | Note |',
    '|---|---|',
    '| 10-14 | Fixed<br>see [[T-0001 Printer]] |',
    '| 10-15 | Called the vendor about the scanner |',
    '',
    '| a<br/>b [[T-0002]] | c |',
    '|---|---|',
    '',
    'Paged<BR>then [[T-0003]]',
    '```',
    'net stop spooler',
    '```',
    '',
    'Ran `net stop',
    'spooler` then [[T-0004]]',
    'and **`a',
    'b` [[T-0005]]**'
  ].join('\n')
  const p = parseMarkdown(md)
  // the line a backlink shows and the viewer jumps to holds the link
  assert.deepEqual(
    p.linkLines.map((l) => [l.target, l.line, p.lines[l.line - 1]]),
    [
      ['T-0001 Printer', 3, md.split('\n')[2]],
      ['T-0002', 6, md.split('\n')[5]],
      ['T-0003', 9, md.split('\n')[8]],
      ['T-0004', 15, md.split('\n')[14]],
      ['T-0005', 17, md.split('\n')[16]]
    ]
  )
  // a <br> still breaks the line where it is drawn
  const para = p.blocks.find((b) => b.t === 'para' && b.line === 9)
  assert.ok(para?.t === 'para' && para.c.some((x) => x.t === 'br'))
})

test('a list or quote line with a lone \\r or U+2028 in it is still that line: its comments stay hidden', () => {
  // Obsidian ends a line at a lone \\r and reads U+2028 as a character; split on \\n only, such a
  // line failed the item and quote patterns, so it and the indented lines after it read as code
  const secret = /Jane|445566/
  for (const md of [
    '## Calls\n\n\t- [ ] call back %% Jane Roe, MRN 445566 %%\r\r\nnext\n',
    '## Calls\n\n\t- [ ] call back\u2028later %% Jane Roe, MRN 445566 %%\n',
    '## Calls\r\r\n\r\r\n\t- [ ] call back %% Jane Roe, MRN 445566 %%\r\r\n',
    '## Calls\n\n\t- printer\u2028reset\n\t- call back %% Jane Roe, MRN 445566 %%\n',
    '- called\r\r\n\r\r\n\tfollow-up %% Jane Roe, MRN 445566 %%\r\r\n'
  ]) {
    const p = parseMarkdown(md)
    assert.doesNotMatch(JSON.stringify(p.blocks), secret, JSON.stringify(md))
    assert.doesNotMatch(p.lines.join('\n'), secret, JSON.stringify(md))
  }
})

test('a heading reads as it did: closing #s, tabs, and a \\r or U+2028 only at its end', () => {
  const heads = (md: string): Array<[number, string]> =>
    parseMarkdown(md).blocks.map((b) => (b.t === 'heading' ? [b.level, b.text] : [0, b.t]))
  assert.deepEqual(heads('# Title ##'), [[1, 'Title']])
  assert.deepEqual(heads('##\tTitle\t#\t'), [[2, 'Title']])
  assert.deepEqual(heads('### a # #'), [[3, 'a #']])
  assert.deepEqual(heads('# ##'), [[1, '##']])
  assert.deepEqual(heads('# C# #'), [[1, 'C#']])
  assert.deepEqual(heads('# Title\r\r\nnext'), [
    [1, 'Title'],
    [0, 'para']
  ])
  assert.deepEqual(heads('# a \u2028'), [[1, 'a']])
  assert.deepEqual(heads('# a\u2028#'), [[1, 'a']])
  assert.deepEqual(heads('# a\u2028b'), [[0, 'para']])
  assert.deepEqual(heads('#Title'), [[0, 'para']])
})

/** Milliseconds parseMarkdown takes for `md`. */
function parseTime(md: string): number {
  const t0 = performance.now()
  parseMarkdown(md)
  return performance.now() - t0
}

test('a heading or near delimiter row with a long run of spaces parses in linear time', () => {
  for (const md of [
    // a regex for a heading's closing #s backtracked over the run (7 s for 60 KB, 20 s for 100)
    '# Notes' + ' '.repeat(100_000) + 'end',
    '## Notes' + '\t'.repeat(100_000) + 'end #',
    // and one for a delimiter row, after a line with a pipe; also read for comments (9 to 19 s)
    'Port | Use\n--' + ' '.repeat(100_000) + '| x',
    '> Port | Use\n> --' + ' '.repeat(100_000) + '| x',
    'Port | Use %% note %%\n--' + ' '.repeat(100_000) + '| x'
  ]) {
    const ms = parseTime(md)
    // a few ms here
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms for ${JSON.stringify(md.slice(0, 16))}`)
  }
})

test('backtick runs that close nothing parse in linear time', () => {
  // shorter and shorter runs: each was searched for to the end of the line (14 to 27 s)
  const runs = 'a ' + Array.from({ length: 900 }, (_, k) => '`'.repeat(900 - k) + 'a').join('')
  const long = 'a ' + '`'.repeat(20_000) + 'a' + ('`'.repeat(19_999) + 'a').repeat(20)
  for (const md of [
    runs,
    `*${runs}*`,
    `| a | b |\n|---|---|\n| ${runs} | c |`,
    `| ${runs} | c |\n|---|---|`,
    // one long run in emphasis: each of its backticks was read to the run's end (3 s)
    '*a ' + '`'.repeat(100_000) + ' b*',
    // one long run over runs one shorter: indexOf read each of them again (2 to 5 s)
    long,
    `*${long}*`,
    `| a | b |\n|---|---|\n| ${long} | c |`
  ]) {
    const ms = parseTime(md)
    // 5 to 40 ms here
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms for ${JSON.stringify(md.slice(0, 16))}`)
  }
  // a run still closes at the next one as long, and a span in emphasis still keeps its *
  for (const [md, spans] of [
    ['x ```` y ``` z ` w `` v', ['w']],
    ['a ``` b ` c `` d ``` e', ['b ` c `` d']],
    ['*a `` x ` b* ``', ['x ` b*']],
    ['*a ``` x ``` b*', ['x']]
  ] as const) {
    assert.deepEqual(codeSpans(parseMarkdown(md).blocks), spans, md)
  }
})

test('ordinary code spans work out no table of backtick runs, so they cost what they did', () => {
  // the longest run after each position was worked out for each text and row with a backtick,
  // which made ordinary notes with code spans parse 25 to 40% slower than at cb9d5bb (50 to 90%
  // with a lone backtick); only a text where three runs close nothing needs it
  const Real = globalThis.Int32Array
  let made = 0
  globalThis.Int32Array = class extends Real {
    constructor(...args: [number]) {
      super(...args)
      made++
    }
  } as Int32ArrayConstructor
  try {
    const md = [
      'Run `Get-Printer` then ``Restart`Service`` and *see `a` and `b`* or **run `c`**.',
      '',
      '| Port | `Use` |',
      '|---|---|',
      '| `a|b` | *x `y`* |',
      '',
      '- [ ] call about `ARH-P01`',
      '> [!note] `Title`',
      '> body with `code`',
      '',
      'Use the ` key, or `` twice, then `code` here: ```',
      '',
      '| `x` ``y | `z |',
      '|---|---|'
    ].join('\n')
    assert.equal(codeSpans(parseMarkdown(md).blocks).length, 15)
    assert.equal(made, 0)
    // once three runs close nothing, the table is worked out (and later runs are looked up in it)
    assert.deepEqual(codeSpans(parseMarkdown('a ``` b `` c ` d `` e').blocks), ['c ` d'])
    assert.equal(made, 0)
    assert.deepEqual(codeSpans(parseMarkdown('a ```` b ``` c `` d ` e ` f').blocks), ['e'])
    assert.equal(made, 1)
  } finally {
    globalThis.Int32Array = Real
  }
})

test('a table has a delimiter row of as many cells as its header, as in GFM, and 256 at most', () => {
  assert.deepEqual(kinds(parseMarkdown('| a | b |\n|---|\n| 1 | 2 |').blocks), ['para'])
  assert.deepEqual(kinds(parseMarkdown('a | b\n---|---|---').blocks), ['para'])
  // a comment after the last pipe is no cell, in the comment pass too
  const md = '| a | b | %% Jane Roe %%\n|---|---|\n| 1 | `%% kept %%` |'
  const table = parseMarkdown(md).blocks[0]
  assert.ok(table?.t === 'table')
  assert.deepEqual(table.head.map(inlineText), ['a', 'b'])
  assert.deepEqual(codeSpans([table]), ['%% kept %%'])
  const cols = (n: number): string => `${'|a'.repeat(n)}|\n${'|-'.repeat(n)}|\n${'|b'.repeat(n)}|`
  assert.deepEqual(kinds(parseMarkdown(cols(256)).blocks), ['table'])
  assert.deepEqual(kinds(parseMarkdown(cols(257)).blocks), ['para'])
})

test("a table's cells are its rows' own, so a wide header over short rows parses quickly", () => {
  // each row was padded to the header's cells: 20000 columns over 2000 rows of one pipe each
  // were 40 million cells (12 s, 120 MB to the window), and would still be 5 million at 256
  // columns over 20000 rows; now the first two are no table (GFM, MAX_COLS)
  for (const md of [
    '|a'.repeat(20_000) + '|\n|-|\n' + '|\n'.repeat(2000),
    '|a'.repeat(20_000) + '|\n' + '|-'.repeat(20_000) + '|\n' + '|\n'.repeat(2000),
    '|a'.repeat(256) + '|\n' + '|-'.repeat(256) + '|\n' + '|\n'.repeat(20_000)
  ]) {
    const t0 = performance.now()
    const p = parseMarkdown(md)
    const ms = performance.now() - t0
    const cells = p.blocks.reduce(
      (n, b) => (b.t === 'table' ? n + b.head.length + b.rows.flat().length : n),
      0
    )
    assert.ok(cells <= md.length, `${cells} cells for ${md.length} characters`)
    // 10 to 50 ms here
    assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`)
  }
  const table = parseMarkdown('| a | b | c |\n|---|---|---|\n| 1 |\n| 2 | 3 | 4 | 5 |').blocks[0]
  assert.ok(table?.t === 'table')
  assert.deepEqual(
    table.rows.map((r) => r.map(inlineText)),
    [['1'], ['2', '3', '4']]
  )
})

/** A small deterministic random source (mulberry32): every run checks the same notes. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A random note of quotes, callouts, lists, indented code, fences, tables, commands with %% in
 * them, code spans and comments, also a comment right before what would start a block, and
 * backticks that a link's label, a wikilink, a URL or emphasis takes before a code span could.
 * With `reshaping`, also comments that change the note's shape once hidden: lines that hold only
 * a comment, comments over several lines, and comments that hold a table row's pipes. `deep`
 * nests further.
 */
function randomNote(rand: () => number, reshaping: boolean, deep: boolean): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const prefixes = ['> ', '>', '>  ', '>     ', '- ', '1. ', '2. ', '- [ ] ', ' ', '  ', '   ']
  prefixes.push('    ', '\t', '* ', '10) ', '    > ')
  let id = 0
  // what a line could start once a comment before it is hidden
  const starts = ['```', '~~~', '    for %%i in (c) do del "%%i"', '> x', '- x', '1. x', '# h']
  starts.push('|---|---|', '[!note] t', '* * *', 'a | b', '`x`')
  const contents = [
    () => `text ${id++}`,
    () => `text %% secret ${id++} %% more`,
    () => `word <!-- secret ${id++} --> after`,
    () => pick(['```', '````', '```bat', '~~~']),
    () => `for %%f in (c${id++}) do echo %%f`,
    () => `    for %%i in (c${id++}) do del "%%i"`,
    () => `[!note] Title %% secret ${id++} %%`,
    () => `- item %% secret ${id++} %%`,
    () => '1. step',
    () => pick(['- - -', '* * *', `# Step ${id++} %% secret %%`]),
    () => '',
    () => pick(['|---|---|', '| - | - |', '|:-|-:|', '|---|---| %% secret %%', '|-|-| <!-- x -->']),
    () => pick(['Port | Use', '| a | b |', 'x | y %% secret %%', '| c %% secret %% | d |', 'p|q']),
    () => `%% secret ${id++} %%` + pick(starts),
    () => `<!-- secret ${id++} -->` + pick(starts),
    () => pick(['Run \\`%% secret %%` now', 'a \\\\`%% kept %%` b', 'tick `a', '` %% secret %% `']),
    () => pick(['`%% kept %%` x %% secret %%', 'x `` y `%% kept %%` z', 'p `q %% kept %% r`']),
    // \\ before a comment is a backslash; escaped markers are text (each "shown"), as the vault
    // writer escapes typed ones
    () =>
      pick([
        'a \\\\%% secret %% b \\<!-- shown \\%% shown \\%\\%% shown',
        '`` s `` %% secret %%',
        'u ` v',
        '**b %% secret %%**'
      ]),
    () =>
      pick(['See [the `n escape](https://x.org)', 'See [[Run`book]]', 'See https://x.org/a`b']) +
      pick(['', ' `c` %% secret %% `d`', ' %% secret %% `e`', ' [x](https://x.org/a`b) `f`']),
    () => pick(['Ran `Get-Printer` %% secret %% `Restart`', '*a `b* c', 'd` e* %% secret %% `f`']),
    () => pick(['*x [[a`b]] y ` z* `w` %% secret %% `v`', '[[x %% secret %% y]]', '_u `v_']),
    () =>
      pick([
        '[a `%% kept %%` b](https://x.org) %% secret %%',
        '| [[a|b`]] | `c` %% secret %% `d` |'
      ]),
    ...(reshaping
      ? [() => `%% secret ${id++} %%`, () => '%%', () => '<!--', () => '-->', () => 'x %% a|b %% y']
      : [])
  ]
  const lines: string[] = []
  for (let k = 2 + Math.floor(rand() * 14); k > 0; k--) {
    let prefix = ''
    for (let d = Math.floor(rand() * (deep ? 7 : 4)); d > 0; d--) prefix += pick(prefixes)
    lines.push(prefix + pick(contents)())
  }
  return lines.join('\n')
}

/**
 * The text of a parsed note that is not code (text nodes, links and wikilinks), and its code
 * blocks ([line, lang, code]), in order, and in `all` every string the viewer could show (code
 * spans too).
 */
function textAndCode(
  blocks: Block[],
  text: string[],
  code: Array<[number, string, string]>,
  all: string[] = []
): void {
  const inline = (c: Inline[]): void => {
    for (const x of c) {
      if (x.t === 'text') text.push(x.v)
      else if (x.t === 'link') text.push(x.href)
      else if (x.t === 'wiki') text.push(x.target, x.heading ?? '', x.alias ?? '')
      if (x.t === 'text' || x.t === 'code' || x.t === 'tag') all.push(x.v)
      else if (x.t === 'link') all.push(x.href)
      else if (x.t === 'wiki') all.push(x.target, x.heading ?? '', x.alias ?? '')
      if ('c' in x) inline(x.c)
    }
  }
  for (const b of blocks) {
    if (b.t === 'code') {
      code.push([b.line, b.lang, b.v])
      all.push(b.lang, b.v)
    } else if (b.t === 'para' || b.t === 'heading') inline(b.c)
    else if (b.t === 'quote') textAndCode(b.c, text, code, all)
    else if (b.t === 'callout') {
      inline(b.title)
      textAndCode(b.c, text, code, all)
    } else if (b.t === 'list') {
      for (const it of b.items) {
        all.push(it.task ?? '')
        textAndCode(it.c, text, code, all)
      }
    } else if (b.t === 'table') for (const row of [b.head, ...b.rows]) row.forEach(inline)
  }
}

test('comments are hidden wherever the note shows text, and code keeps every byte', () => {
  // these seeds' notes include table rows and heads whose only pipe is in a comment, on a line
  // that reads as quoted code once the comment is hidden (15), or as a line in a list item's
  // open fence (135)
  let rand = random(15)
  for (let k = 0; k < 12_000; k++) {
    if (k === 6000) rand = random(135)
    const reshaping = k % 2 === 1
    const md = randomNote(rand, reshaping, k % 4 >= 2)
    const text: string[] = []
    const code: Array<[number, string, string]> = []
    const all: string[] = []
    textAndCode(parseMarkdown(md).blocks, text, code, all)
    const shown = text
      .map((v) => v.replaceAll('<!-- shown', '').replaceAll('%% shown', ''))
      .find((v) => v.includes('%%') || v.includes('<!--'))
    assert.equal(shown, undefined, `a comment shows as text in:\n${md}`)
    // what stands in for a hidden comment, or marks a kept one, is never shown
    assert.ok(!all.some((v) => /[\uFDD0\uFDD1]/.test(v)), `a placeholder shows in:\n${md}`)
    if (reshaping) {
      // every line of a code block is a line of the note as written, past its quote and list
      // markers (nothing in it hidden, nothing cut), and a command in one is whole
      const source = md.split('\n').map((l) => l.trimEnd())
      for (const [, , v] of code) {
        for (const line of v.split('\n')) {
          const t = line.trim()
          const written = source.some(
            (s) => s.endsWith(t) && /^[\s>*+\-\d.)[\]]*$/.test(s.slice(0, s.length - t.length))
          )
          assert.ok(!t || written, `code line ${JSON.stringify(line)} is not as written in:\n${md}`)
          if (line.includes('for '))
            assert.match(line, /for %%(f in \(c\d*\) do echo %%f|i in \(c\d*\) do del "%%i")$/, md)
        }
      }
    } else {
      // these comments leave each line's shape as it was, even one that a fence, a delimiter
      // row or indented code would follow, so the code blocks are the ones the note has when
      // no comment is hidden at all
      const plain = md.replaceAll('%%', '§§').replaceAll('<!--', '‹!--')
      const want: Array<[number, string, string]> = []
      textAndCode(parseMarkdown(plain).blocks, [], want)
      const back = (v: string): string => v.replaceAll('§§', '%%').replaceAll('‹!--', '<!--')
      assert.deepEqual(
        code,
        want.map(([line, lang, v]) => [line, lang, back(v)]),
        `code differs in:\n${md}`
      )
    }
  }
})

/**
 * A random note of what notes hold, without comments and without a pathological line: headings
 * with closing #s, tabs and spaces, paragraphs with code spans and backtick runs, emphasis around
 * them, links, tables whose delimiter row has the header's cells (rows short and long), lists
 * with task boxes, quotes and callouts with tables, fences, indented code, rules, lines that
 * almost are a delimiter row, and frontmatter.
 */
function ordinaryNote(rand: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
  const upTo = (n: number): number => Math.floor(rand() * (n + 1))
  const words = [
    'printer',
    'ARH-P01',
    'spooler',
    'Jane',
    'net stop',
    'C:\\Temp',
    'x',
    '2024.',
    '1.'
  ]
  const inline = [
    () => pick(words),
    () =>
      pick(['`code`', '``a`b``', '` x `', '`', '``', '```', '`a|b`', '`` ` ``', '`run` `', '\\`']),
    () => pick(['*em*', '**strong**', '_u_', '__s__', '~~del~~', '==mark==', '***both***']),
    () => pick(['*a `b* c`', '*a `b` c*', '**x `y**` z', '_p `q_ r`', '*', '_', '**']),
    () => pick(['[link](https://x.org)', '[[Wiki]]', '[[Wiki|alias]]', '[[Note#Head]]']),
    () => pick(['![img](x.png)', '[rel](Tickets/T-1.md)', 'https://x.org/a#b', '<br>']),
    () => pick(['#tag', '#1', 'a #b', '\\|', '\\*', '|', ' # ', '#', '##', ' -- ', ':--']),
    () => '`'.repeat(1 + upTo(4)) + pick(words) + '`'.repeat(1 + upTo(4))
  ]
  const text = (): string => {
    let s = ''
    for (let k = 1 + upTo(4); k > 0; k--) s += pick(inline)() + pick([' ', '', '  '])
    return s
  }
  // a line of text has a word, so it is never a delimiter row
  const line = (): string => `${pick(words)} ${text()}`
  // a header's cell holds no pipe and no backtick, so it has the cells it is written with
  const headCell = (): string =>
    pick(['', 'Port', '**Use**', '[[Wiki\\|alias]]', 'a \\| b', '_x_', '#tag', '--', ':-'])
  const cellText = (): string => pick([text, () => '', () => pick(words), () => '`a|b`'])()
  const row = (n: number, outer: boolean, cell = cellText): string => {
    const cells = Array.from({ length: n }, () => pick([' ', '']) + cell() + pick([' ', '']))
    return outer ? `|${cells.join('|')}|` : cells.join('|')
  }
  const blocks = [
    () => {
      const open = ' '.repeat(upTo(3)) + '#'.repeat(1 + upTo(6))
      const close = pick(['', ' #', ' ##', '#', ' # ', '  ###  ', ' \\#', ' a #', '\t#'])
      return open + pick([' ', '  ', '\t', '', ' \t']) + text() + close + pick(['', ' ', '\t'])
    },
    () => Array.from({ length: 1 + upTo(2) }, line).join('\n'),
    () => {
      const n = 1 + upTo(5)
      const outer = rand() < 0.7 || n === 1
      const sep = Array.from({ length: n }, () =>
        pick(['---', '-', ' --- ', ':-', '-:', ':-:', ' :---: ', '--  '])
      )
      // (without outer pipes, an empty cell at an end would read as one)
      const lines = [
        row(n, outer, outer ? headCell : () => headCell() || 'Use'),
        outer || rand() < 0.5 ? `|${sep.join('|')}|` : sep.join('|')
      ]
      for (let r = upTo(4); r > 0; r--) lines.push(row(Math.max(1, n + upTo(4) - 2), true))
      return lines.join('\n')
    },
    () => {
      const items: string[] = []
      for (let k = 1 + upTo(3); k > 0; k--) {
        const indent = pick(['', '', '  ', '    '])
        const box = pick(['', '', '[ ] ', '[x] ', '[/] ', '[-] ', '[] ', '[ab] '])
        items.push(indent + pick(['- ', '* ', '1. ', '2) ']) + box + line())
      }
      return items.join('\n')
    },
    () => {
      const head = pick(['', '[!note] Title', '[!danger]- Fold', '[!tip]+'])
      const body = [line(), '| a | b |', '|---|---|', '| 1 | 2 |', line()].slice(0, 1 + upTo(4))
      return [head, ...body]
        .filter((l, k) => k > 0 || l)
        .map((l) => pick(['> ', '>', '>  ']) + l)
        .join('\n')
    },
    () => pick(['```', '~~~', '```bat']) + '\n' + text() + '\n| a |\n' + pick(['```', '~~~']),
    () => '    ' + text() + '\n    more',
    // (not ---: at the top it would open frontmatter, where " #" starts a YAML comment)
    () => pick(['***', '* * *', '___', '- - -']),
    () => pick(['--', '-|-', '|-', ':--:', '- |'])
  ]
  const out: string[] = []
  if (rand() < 0.3) {
    const fm = ['---']
    for (let k = 1 + upTo(4); k > 0; k--) {
      fm.push(
        pick([
          'id: TKT-2026-007',
          'time: "11:31"',
          "owner: 'O''Brien'",
          'color: "#fff"',
          'url: https://x.org/a#b',
          'tags:\n  - arh\n  - "ticket"',
          'parent:\n  child: x',
          'desc: |\n  multi\n  line',
          'related: "[[Wiki]]"',
          'list: [a, b]'
        ])
      )
    }
    out.push(fm.join('\n'), '---')
  }
  // blocks apart, so that no line with a pipe comes right before another block's delimiter row
  for (let k = 1 + upTo(6); k > 0; k--) out.push(pick(blocks)(), '')
  return out.join('\n')
}

/** `blocks` with each table row padded to its header's cells, as the parser once stored it. */
function padded(blocks: Block[]): Block[] {
  return blocks.map((b): Block => {
    if (b.t === 'table') return { ...b, rows: b.rows.map((r) => b.head.map((_, j) => r[j] ?? [])) }
    if (b.t === 'quote' || b.t === 'callout') return { ...b, c: padded(b.c) }
    if (b.t === 'list') return { ...b, items: b.items.map((it) => ({ ...it, c: padded(it.c) })) }
    return b
  })
}

test('ordinary notes read as they did before the parser was made linear (cb9d5bb)', async (t) => {
  // the parser as it was, from git; a shallow clone (as in CI) has not got it
  let before: string
  try {
    before = execFileSync('git', ['show', 'cb9d5bb:src/shared/markdown.ts'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    t.skip('commit cb9d5bb is not in this clone')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'arh-markdown-'))
  try {
    await writeFile(join(dir, 'markdown.ts'), before)
    const old = (await import(
      pathToFileURL(join(dir, 'markdown.ts')).href
    )) as typeof import('../src/shared/markdown.ts')
    // a <br> is now marked as one, and a link's line no longer counts it (checked below)
    const plain = (x: object): unknown =>
      JSON.parse(JSON.stringify(x, (k, v: unknown) => (k === 'html' ? undefined : v)))
    const rand = random(7)
    for (let k = 0; k < 10_000; k++) {
      const md = ordinaryNote(rand)
      const now = parseMarkdown(md)
      const was = old.parseMarkdown(md)
      const targets = (p: typeof now): string[] => p.linkLines.map((l) => l.target)
      // a table row now holds only its own cells (the viewer draws the rest empty)
      assert.deepEqual(
        plain({ ...now, blocks: padded(now.blocks), lines: [], linkLines: targets(now) }),
        plain({ ...was, lines: [], linkLines: targets(was) }),
        `reads differently:\n${md}`
      )
      // and a backlink's line is the line as written, the one its link is on
      assert.deepEqual(now.lines, md.split('\n'))
      for (const { target, line } of now.linkLines)
        assert.ok(now.lines[line - 1]?.includes(target), `${target} not on line ${line}:\n${md}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
