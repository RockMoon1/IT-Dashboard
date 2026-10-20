import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
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
  /** The file ends in a line cut short (power lost mid-write): start the next one on its own line. */
  private torn = false
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
        } catch {
          /* verify() reports it */
        }
      }
    } catch {
      /* first run */
    }
    this.loaded = true
  }

  /** Appends one line; lines are written in call order. */
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
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, `${this.torn ? '\n' : ''}${JSON.stringify(line)}\n`, 'utf8')
      this.torn = false
      this.last = line.hash
    })
    this.queue = write.catch(() => undefined)
    return write
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
