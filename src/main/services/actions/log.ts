import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ActionRecord } from '../../../shared/actions.ts'

/**
 * Every action and custom command, one JSON line per change of state, in the app data folder
 * (never the vault). Each line carries the SHA-256 of the line before it, so an edited or removed
 * line breaks the chain and verify() says where. Never capped: this is the audit trail the vault
 * rows are built from. Custom script text is kept here only; custom output never.
 */

export interface ActionLogLine {
  ts: string
  event: 'request' | 'update' | 'result'
  record: ActionRecord
  /** Custom commands only: the full text, kept on this computer for audit. */
  script?: string
  prev: string
  hash: string
}

const GENESIS = '0'.repeat(64)

function digest(line: Omit<ActionLogLine, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(line)).digest('hex')
}

/** Named action output is kept short; custom command output is never written. */
function forDisk(r: ActionRecord, keepCustomOutput: boolean): ActionRecord {
  return {
    ...r,
    checks: r.checks.map((c) =>
      r.kind === 'exec' && !keepCustomOutput
        ? { ...c, stdout: '', stderr: '' }
        : { ...c, stdout: c.stdout.slice(0, 16_384), stderr: c.stderr.slice(0, 8_192) }
    )
  }
}

export class ActionLog {
  private file: string
  private last = GENESIS
  private loaded = false
  /** The file may end in a line cut short (power lost, a failed write): start the next on its own. */
  private torn = false
  /** Runs whose result line is in the file: synced there by append(), or found there by load(). */
  private resultsOnDisk = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private records = new Map<string, ActionRecord>()
  private order: string[] = []

  constructor(file: string) {
    this.file = file
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.file, 'utf8')
      this.torn = text.length > 0 && !text.endsWith('\n')
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue
        try {
          const l = JSON.parse(raw) as ActionLogLine
          this.last = l.hash
          if (!this.records.has(l.record.runId)) this.order.push(l.record.runId)
          this.records.set(l.record.runId, l.record)
          if (l.event === 'result' && l.record.result) this.resultsOnDisk.add(l.record.runId)
        } catch {
          /* verify() reports it */
        }
      }
    } catch {
      /* first run */
    }
    this.loaded = true
  }

  /** Appends one line; lines are written in call order, each synced to the disk before it resolves. */
  append(
    event: ActionLogLine['event'],
    record: ActionRecord,
    opts: { script?: string; keepCustomOutput?: boolean; now?: Date } = {}
  ): Promise<void> {
    if (!this.records.has(record.runId)) this.order.push(record.runId)
    this.records.set(record.runId, structuredClone(record))
    const write = this.queue.then(async () => {
      if (!this.loaded) await this.load()
      const body: Omit<ActionLogLine, 'hash'> = {
        ts: (opts.now ?? new Date()).toISOString(),
        event,
        record: forDisk(record, opts.keepCustomOutput === true),
        ...(opts.script !== undefined ? { script: opts.script } : {}),
        prev: this.last
      }
      const line: ActionLogLine = { ...body, hash: digest(body) }
      const json = JSON.stringify(line)
      await mkdir(dirname(this.file), { recursive: true })
      let written = false
      let synced = false
      try {
        const fh = await open(this.file, 'a')
        try {
          await fh.appendFile(`${this.torn ? '\n' : ''}${json}\n`, 'utf8')
          written = true
          await fh.datasync() // the agent drops a result once it is acknowledged
          synced = true
        } finally {
          await fh.close()
        }
      } finally {
        // a whole line is in the file even when only the sync or the close failed: the next
        // line chains on from it. A write that failed may have left part of one (a full disk),
        // all of it but the newline, or nothing: the file says which.
        if (written) {
          this.torn = false
          this.last = line.hash
        } else await this.afterFailedWrite(json, line.hash)
        if (synced && event === 'result' && body.record.result) this.resultsOnDisk.add(record.runId)
      }
    })
    this.queue = write.catch(() => undefined)
    return write
  }

  /**
   * After a write that failed, reads the end of the file: when the whole line got there (with or
   * without its newline) the next line chains on from it, as load() would after a restart, and
   * starts on a new line unless the file already ends with one. Unreadable: assume a torn line.
   */
  private async afterFailedWrite(json: string, hash: string): Promise<void> {
    this.torn = true
    try {
      const fh = await open(this.file, 'r')
      try {
        const line = Buffer.from(`${json}\n`, 'utf8')
        const { size } = await fh.stat()
        const n = Math.min(size, line.length)
        const tail = Buffer.alloc(n)
        if (n) await fh.read(tail, 0, n, size - n)
        const endsWith = (b: Buffer): boolean => n >= b.length && tail.subarray(n - b.length).equals(b)
        if (endsWith(line) || endsWith(line.subarray(0, -1))) this.last = hash
        this.torn = n > 0 && tail[n - 1] !== 0x0a
      } finally {
        await fh.close()
      }
    } catch {
      /* keep it torn: an extra blank line is harmless */
    }
  }

  /** Latest state of each run, newest request first. */
  list(limit = 500): ActionRecord[] {
    return this.order
      .map((id) => this.records.get(id)!)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, limit)
  }

  get(runId: string): ActionRecord | undefined {
    return this.records.get(runId)
  }

  /** Whether a result line of this run is on disk (get() also holds one still being written). */
  resultOnDisk(runId: string): boolean {
    return this.resultsOnDisk.has(runId)
  }

  /** Checks the chain; returns the 1-based line numbers that do not follow from the one before. */
  async verify(): Promise<{ lines: number; broken: number[] }> {
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return { lines: 0, broken: [] }
    }
    let prev = GENESIS
    const broken: number[] = []
    const lines = text.split('\n').filter((l) => l.trim())
    lines.forEach((raw, i) => {
      try {
        const l = JSON.parse(raw) as ActionLogLine
        const { hash, ...body } = l
        if (l.prev !== prev || digest(body) !== hash) broken.push(i + 1)
        prev = hash
      } catch {
        broken.push(i + 1)
      }
    })
    return { lines: lines.length, broken }
  }
}
