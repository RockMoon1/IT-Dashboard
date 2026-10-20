import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inlineText, parseInline, parseMarkdown, type Block } from '../src/shared/markdown.ts'

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
