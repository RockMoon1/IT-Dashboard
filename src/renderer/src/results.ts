import type { CheckRun, ResultNode, ScanRun } from '@shared/types'

/** Tolerant JSON parse for check output (mirrors main/services/util/json.ts). */
export function tryParseJson(text: string): unknown {
  const trimmed = text.replace(/^﻿/, '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    for (const line of trimmed.split(/\r?\n/).reverse()) {
      const l = line.trim()
      if (l.startsWith('{') || l.startsWith('[')) {
        try {
          return JSON.parse(l)
        } catch {
          /* keep looking */
        }
      }
    }
    return null
  }
}

export function resultsTree(run: ScanRun): ResultNode[] {
  const byCat = new Map<string, ResultNode>()
  for (const c of run.checks) {
    const node = byCat.get(c.category) ?? { category: c.category, checks: [] }
    byCat.set(c.category, node)
    node.checks.push({
      id: c.id,
      title: c.title,
      status: c.status,
      durationMs: c.durationMs,
      parsed: c.format === 'json' ? tryParseJson(c.stdout) : null,
      text: c.format === 'json' ? '' : c.stdout,
      stderr: c.stderr,
      truncated: c.truncated
    })
  }
  return [...byCat.values()]
}

export function statusMark(status: CheckRun['status']): { text: string; cls: string } {
  switch (status) {
    case 'ok':
      return { text: '✓', cls: 'text-ok-400' }
    case 'failed':
      return { text: '✗', cls: 'text-bad-400' }
    case 'timeout':
      return { text: '⏱', cls: 'text-warn-400' }
    case 'running':
      return { text: '●', cls: 'text-gold-300 animate-pulse' }
    default:
      return { text: '○', cls: 'text-mist-700' }
  }
}

/** True for arrays of flat objects, which render better as a table. */
export function isTabular(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) return false
  return value.every(
    (row) =>
      row &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      Object.values(row as Record<string, unknown>).every(
        (v) => v === null || typeof v !== 'object'
      )
  )
}

export function fmt(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}
