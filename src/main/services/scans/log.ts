import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One line per scan in a JSONL file inside the app data folder. Never in the vault. */
export interface ScanLogEntry {
  ts: string
  runId: string
  deviceId: string
  serial: string
  hostname: string
  os: string
  purpose: string
  profile: string
  version: number
  technician: string
  durationMs: number
  status: 'ok' | 'failed' | 'aborted'
  exitStatus: string
  checks: number
  failedChecks: number
  findings: number
  critical: number
}

export class ScanLog {
  private file: string

  constructor(file: string) {
    this.file = file
  }

  async append(entry: ScanLogEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  async all(): Promise<ScanLogEntry[]> {
    try {
      const text = await readFile(this.file, 'utf8')
      return text
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as ScanLogEntry
          } catch {
            return null
          }
        })
        .filter((e): e is ScanLogEntry => e !== null)
    } catch {
      return []
    }
  }

  async list(
    opts: { deviceId?: string; serial?: string; limit?: number } = {}
  ): Promise<ScanLogEntry[]> {
    let entries = (await this.all()).reverse()
    if (opts.deviceId) entries = entries.filter((e) => e.deviceId === opts.deviceId)
    if (opts.serial)
      entries = entries.filter((e) => e.serial.toLowerCase() === opts.serial!.toLowerCase())
    entries.sort((a, b) => b.ts.localeCompare(a.ts))
    return entries.slice(0, opts.limit ?? 50)
  }

  async lastForDevice(deviceId: string): Promise<ScanLogEntry | undefined> {
    return (await this.list({ deviceId, limit: 1 }))[0]
  }
}
