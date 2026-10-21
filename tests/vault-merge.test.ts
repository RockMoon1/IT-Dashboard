import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONTENT_OPTIONS,
  mergeChanges,
  mergeLog,
  ownIndex,
  type ActionEntry
} from '../src/main/services/vault/content.ts'
import type { ActionRecord } from '../src/shared/actions.ts'
import type { ScanRun } from '../src/shared/types.ts'

/* ---------- a vault with a long history: every scan and run the dashboard has made ---------- */

const at = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString()
const id = (prefix: string, i: number): string =>
  `${prefix}_${(1_767_225_600_000 + i).toString(36)}_${i.toString(16).padStart(6, '0')}`

function scan(i: number): ScanRun {
  return {
    runId: id('r', i),
    deviceId: 'dev1',
    serial: 'SN-TEST-01',
    hostname: 'EXAM2-LT',
    os: 'windows',
    purpose: 'security-check',
    profile: 'windows-security-check',
    version: 1,
    title: 'Security Check',
    technician: 'Lisandro',
    startedAt: at(i),
    finishedAt: at(i),
    status: 'ok',
    checks: [],
    durationMs: 42_000,
    health: {
      score: 'attention',
      metrics: {},
      findings: [
        {
          id: 'disk',
          severity: 'warning',
          category: 'Storage',
          message: 'Disk C: 9% free',
          loop: true
        }
      ]
    }
  }
}

function change(i: number, status: ActionRecord['status'] = 'changed'): ActionEntry {
  const unknown = status === 'unknown'
  const when = new Date(Date.parse(at(i)) + 60_000).toISOString()
  return {
    record: {
      runId: id('a', i),
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
      ...(unknown ? {} : { endedAt: when }),
      status,
      checks: [],
      ...(unknown
        ? {}
        : {
            result: {
              runId: id('a', i),
              kind: 'action',
              dryRun: false,
              applied: true,
              startedAt: when,
              before: { items: [{ item: 'Firewall Public', value: 'off' }], exitCode: 0 },
              apply: { items: null, exitCode: 0 },
              after: { items: [{ item: 'Firewall Public', value: 'on' }], exitCode: 0 }
            }
          })
    }
  }
}

test('vault: a long Work Log and Change Log merge in well under a second', () => {
  const opts = DEFAULT_CONTENT_OPTIONS
  const n = 2000
  const scans = Array.from({ length: n }, (_, i) => scan(i))
  // every hundredth run lost its link, so its outcome was unknown when it was written
  const first = Array.from({ length: n }, (_, i) => change(i, i % 100 ? 'changed' : 'unknown'))
  const log = mergeLog(null, scans, opts, first).body
  const changes = mergeChanges(null, first, opts).body
  assert.equal(changes.split('\n').filter((l) => / · (run|result) a_/.test(l)).length, n)
  // those runs have reported since, and one more run is done
  const now = [...Array.from({ length: n }, (_, i) => change(i)), change(n)]
  const start = performance.now()
  const nextLog = mergeLog(log, scans, opts, now)
  const nextChanges = mergeChanges(changes, now, opts)
  const ms = performance.now() - start
  assert.equal(nextLog.added, n / 100 + 1, 'a result entry for each unknown run, and the new run')
  assert.equal(nextChanges.added, n / 100 + 1)
  assert.ok(ms < 1000, `one write took ${Math.round(ms)} ms`)
  assert.equal(mergeLog(nextLog.body, scans, opts, now).added, 0)
  assert.equal(mergeChanges(nextChanges.body, now, opts).added, 0)
})

/* ---------- the index finds exactly what matching each line with each run found ---------- */

/** How a run's own lines were found before the index (5f621a8): three patterns per line and id. */
function ownLineBefore(line: string, runId: string, table: boolean): string | null {
  const t = line.trimEnd()
  if (table ? !t.trimStart().startsWith('|') : !t.startsWith('- ')) return null
  const id = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const end = table ? '\\s*\\|$' : '(?:\\s+\\^[A-Za-z0-9-]+)?$'
  if (new RegExp(`· run ${id} · result pending${end}`).test(t)) return 'pending'
  if (new RegExp(`· run ${id}${end}`).test(t)) return 'run'
  if (new RegExp(`· result ${id}${end}`).test(t)) return 'result'
  return null
}

/** Deterministic random picks (mulberry32): every run checks the same bodies. */
function random(seed: number): <T>(list: readonly T[]) => T {
  return (list) => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return list[Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * list.length)]!
  }
}

// ids the dashboard makes; then ids an older build kept as a device sent them, and the words and
// marks of the endings themselves
const IDS = [
  id('a', 1),
  id('r', 2),
  id('x', 3),
  id('p', 4),
  `${id('a', 1)}~dev12345`,
  'd_0123456789abcdef',
  'pending',
  'result',
  'run',
  '·',
  'x·',
  '^b1',
  'x|',
  'x||',
  '|',
  'a.b',
  '.*',
  'a+(b)',
  '$&',
  '\\',
  'é😀',
  '',
  ' ',
  'a b',
  'X ',
  ' X',
  'X ^b1',
  'a\tb',
  `${id('a', 5)} · result pending`,
  `${id('a', 6)} | x`
]
const BITS = ['· ', 'run ', 'result ', ' · result pending', ' ', '\t', '\u00a0', '|', '^b1', 'x']
// what Obsidian, a table plugin or the technician may leave at the end of an entry or a row
const LOG_ENDS = ['', ' ^b1-x', '  ^c2', '\t^Z9', '^b1', ' ^', '\u00a0']
const ROW_ENDS = [' |', '|', '  |', ' ||', ' ^b1 |', '\t| ']

function generatedLines(pick: ReturnType<typeof random>, table: boolean): string[] {
  const ends = table ? ROW_ENDS : LOG_ENDS
  return Array.from({ length: pick([1, 5, 10, 20, 30]) }, () => {
    const start = pick(table ? ['| ', '  | ', '- '] : ['- ', '    - ', '| '])
    const middle = Array.from({ length: pick([0, 1, 2, 4]) }, () =>
      pick([pick(BITS), pick(BITS), pick(IDS)])
    )
    const own = pick([
      ` · run ${pick(IDS)}`,
      ` · run ${pick(IDS)} · result pending`,
      ` · result ${pick(IDS)}`,
      ''
    ])
    const end = pick([pick(ends), pick(ends), pick([...LOG_ENDS, ...ROW_ENDS, ' · run', '·'])])
    return start + middle.join('') + own + end
  })
}

/** A block as the dashboard writes it, with the outcomes reported since, then linked and padded. */
function writtenLines(pick: ReturnType<typeof random>, table: boolean): string[] {
  const opts = DEFAULT_CONTENT_OPTIONS
  const runs = Array.from({ length: pick([1, 3, 8]) }, (_, i) => {
    const e = change(i, pick(['changed', 'unknown'] as const))
    e.record.runId = pick(IDS)
    if (pick([false, true])) e.record.reason = `Undo of · run ${pick(IDS)} · result pending`
    return e
  })
  const reported = runs.map((e) => ({ record: { ...change(0).record, runId: e.record.runId } }))
  const scans = Array.from({ length: pick([0, 2]) }, (_, i) => ({ ...scan(i), runId: pick(IDS) }))
  const merge = (body: string | null, entries: ActionEntry[]): string =>
    table ? mergeChanges(body, entries, opts).body : mergeLog(body, scans, opts, entries).body
  return merge(merge(null, runs), reported)
    .split('\n')
    .map((l) => l + pick(['', '', ...LOG_ENDS, ...ROW_ENDS]))
}

test('vault: the one-pass index finds exactly the own lines the match of each line found', () => {
  const pick = random(20261021)
  let owned = 0
  for (let n = 0; n < 300; n++) {
    for (const table of [false, true]) {
      const lines = n % 3 ? generatedLines(pick, table) : writtenLines(pick, table)
      const ownOf = ownIndex(lines, table)
      // every id either could find: those above, and each start of a word after "run" or "result"
      const ids = new Set(IDS)
      for (const l of lines)
        for (const [w] of l.matchAll(/(?<=(?:run|result) )\S+/g))
          for (let k = 1; k <= w.length; k++) ids.add(w.slice(0, k))
      for (const runId of ids) {
        const before = lines.map((l) => ownLineBefore(l, runId, table)).filter((o) => o !== null)
        assert.deepEqual(
          ownOf(runId),
          before,
          `${JSON.stringify(runId)} in ${JSON.stringify(lines)}`
        )
        owned += before.length
      }
    }
  }
  assert.ok(owned > 2000, `the bodies hold own lines: ${owned}`)
})
