import { test } from 'node:test'
import assert from 'node:assert/strict'
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
