/** Minimal unified diff (LCS based) for dry-run previews of note changes. */

export interface DiffStats {
  added: number
  removed: number
}

export function unifiedDiff(
  before: string,
  after: string,
  label: string,
  context = 3,
  display?: { a: string[]; b: string[] }
): { text: string; stats: DiffStats } {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  if (a[a.length - 1] === '' && before.endsWith('\n')) a.pop()
  if (b[b.length - 1] === '' && after.endsWith('\n')) b.pop()

  // LCS table (notes are small; O(n*m) is fine up to a few thousand lines)
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  type Op = { kind: ' ' | '-' | '+'; line: string; ai: number; bi: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]!, ai: i, bi: j })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: '-', line: a[i]!, ai: i, bi: j })
      i++
    } else {
      ops.push({ kind: '+', line: b[j]!, ai: i, bi: j })
      j++
    }
  }
  for (; i < n; i++) ops.push({ kind: '-', line: a[i]!, ai: i, bi: j })
  for (; j < m; j++) ops.push({ kind: '+', line: b[j]!, ai: i, bi: j })

  const stats: DiffStats = {
    added: ops.filter((o) => o.kind === '+').length,
    removed: ops.filter((o) => o.kind === '-').length
  }
  if (stats.added === 0 && stats.removed === 0) return { text: '', stats }

  // Group into hunks with context
  const out: string[] = [`--- ${label}`, `+++ ${label}`]
  let k = 0
  while (k < ops.length) {
    if (ops[k]!.kind === ' ') {
      k++
      continue
    }
    const hunkStart = Math.max(0, k - context)
    let hunkEnd = k
    let last = k
    while (hunkEnd < ops.length) {
      if (ops[hunkEnd]!.kind !== ' ') last = hunkEnd
      if (hunkEnd - last > context * 2) break
      hunkEnd++
    }
    hunkEnd = Math.min(ops.length, last + context + 1)
    const slice = ops.slice(hunkStart, hunkEnd)
    const aStart = (slice.find((o) => o.kind !== '+')?.ai ?? 0) + 1
    const bStart = (slice.find((o) => o.kind !== '-')?.bi ?? 0) + 1
    const aCount = slice.filter((o) => o.kind !== '+').length
    const bCount = slice.filter((o) => o.kind !== '-').length
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`)
    for (const o of slice)
      out.push(
        `${o.kind}${display ? ((o.kind === '+' ? display.b[o.bi] : display.a[o.ai]) ?? '') : o.line}`
      )
    k = hunkEnd
  }
  return { text: out.join('\n') + '\n', stats }
}
