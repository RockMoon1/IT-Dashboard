import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScanRun } from '../../../shared/types.ts'

/**
 * Persists finished runs (findings, metrics, trimmed output) in the app data folder so the
 * vault blocks and the results view survive restarts. Never in the vault.
 */

const MAX_OUTPUT_PER_CHECK = 64 * 1024

export function trimRun(run: ScanRun): ScanRun {
  return {
    ...run,
    checks: run.checks.map((c) => ({
      ...c,
      stdout:
        c.stdout.length > MAX_OUTPUT_PER_CHECK
          ? `${c.stdout.slice(0, MAX_OUTPUT_PER_CHECK)}\n…[trimmed for storage]`
          : c.stdout,
      stderr: c.stderr.length > 8192 ? `${c.stderr.slice(0, 8192)}\n…[trimmed]` : c.stderr
    }))
  }
}

export class RunStore {
  private dir: string
  private cache = new Map<string, ScanRun>()
  private loaded = false

  constructor(dir: string) {
    this.dir = dir
  }

  async load(): Promise<void> {
    this.cache.clear()
    try {
      for (const f of await readdir(this.dir)) {
        if (!f.endsWith('.json')) continue
        try {
          const run = JSON.parse(await readFile(join(this.dir, f), 'utf8')) as ScanRun
          if (run && typeof run.runId === 'string') this.cache.set(run.runId, run)
        } catch {
          /* skip corrupt file */
        }
      }
    } catch {
      /* no runs yet */
    }
    this.loaded = true
  }

  async save(run: ScanRun): Promise<void> {
    const trimmed = trimRun(run)
    this.cache.set(trimmed.runId, trimmed)
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, `${trimmed.runId}.json`), JSON.stringify(trimmed), 'utf8')
  }

  get(runId: string): ScanRun | undefined {
    return this.cache.get(runId)
  }

  list(limit = 50, deviceId?: string): ScanRun[] {
    return [...this.cache.values()]
      .filter((r) => !deviceId || r.deviceId === deviceId)
      .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))
      .slice(0, limit)
  }

  lastForDevice(deviceId: string): ScanRun | undefined {
    return this.list(1, deviceId)[0]
  }
}
