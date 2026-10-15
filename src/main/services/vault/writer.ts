import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises'
import { constants, type Dirent } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { unifiedDiff } from './diff.ts'
import { findBlock, setBlock } from './markers.ts'

/**
 * Writes managed blocks into existing vault notes.
 *
 * - Never creates a note. A missing note is an error reported in the preview.
 * - Dry-run by default: `preview` returns the exact diff; `apply` refuses unless live is on.
 * - Before the first live write to a note, a backup copy goes to <appData>/vault-backups.
 * - Writes are atomic: temp file in <appData>/vault-tmp, then rename over the note (copy +
 *   unlink fallback when the two are on different volumes).
 * - After each write the note's folder is checked for OneDrive conflict copies.
 */

export interface WritePlan {
  notePath: string
  key: string
  body: string
}

export interface NotePreview {
  notePath: string
  exists: boolean
  keys: string[]
  markersCreated: string[]
  changed: boolean
  diff: string
  added: number
  removed: number
  error?: string
  backupExists: boolean
}

export interface ApplyResult {
  notePath: string
  written: boolean
  backupPath?: string
  conflictCopies: string[]
  error?: string
}

export interface WriterOptions {
  appDataDir: string
  live: boolean
  now?: () => Date
}

export const CONFLICT_PATTERNS = [
  /conflicted copy/i,
  /\(conflict\)/i,
  /-conflict\b/i,
  /conflict-\d/i
]

export function isConflictCopy(fileName: string): boolean {
  return CONFLICT_PATTERNS.some((re) => re.test(fileName))
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function groupByNote(plans: WritePlan[]): Map<string, WritePlan[]> {
  const map = new Map<string, WritePlan[]>()
  for (const p of plans) map.set(p.notePath, [...(map.get(p.notePath) ?? []), p])
  return map
}

export class VaultWriter {
  private opts: WriterOptions

  constructor(opts: WriterOptions) {
    this.opts = opts
  }

  get live(): boolean {
    return this.opts.live
  }

  setLive(live: boolean): void {
    this.opts.live = live
  }

  backupDir(): string {
    return join(this.opts.appDataDir, 'vault-backups')
  }

  tmpDir(): string {
    return join(this.opts.appDataDir, 'vault-tmp')
  }

  private backupPathFor(notePath: string): string {
    return join(
      this.backupDir(),
      `${basename(notePath, extname(notePath))}.first-write${extname(notePath)}`
    )
  }

  /** Computes the new text for a note without touching the disk. */
  static render(current: string, plans: WritePlan[]): { text: string; created: string[] } {
    let text = current
    const created: string[] = []
    for (const p of plans) {
      const r = setBlock(text, p.key, p.body)
      text = r.text
      if (r.created) created.push(p.key)
    }
    return { text, created }
  }

  async preview(plans: WritePlan[]): Promise<NotePreview[]> {
    const out: NotePreview[] = []
    for (const [notePath, notePlans] of groupByNote(plans)) {
      const keys = notePlans.map((p) => p.key)
      const backupExists = await exists(this.backupPathFor(notePath))
      if (!(await exists(notePath))) {
        out.push({
          notePath,
          exists: false,
          keys,
          markersCreated: [],
          changed: false,
          diff: '',
          added: 0,
          removed: 0,
          backupExists,
          error: 'note does not exist (the dashboard never creates notes)'
        })
        continue
      }
      try {
        const current = await readFile(notePath, 'utf8')
        for (const k of keys) findBlock(current, k) // throws on malformed markers
        const { text, created } = VaultWriter.render(current, notePlans)
        const d = unifiedDiff(current, text, basename(notePath))
        out.push({
          notePath,
          exists: true,
          keys,
          markersCreated: created,
          changed: text !== current,
          diff: d.text,
          added: d.stats.added,
          removed: d.stats.removed,
          backupExists
        })
      } catch (err) {
        out.push({
          notePath,
          exists: true,
          keys,
          markersCreated: [],
          changed: false,
          diff: '',
          added: 0,
          removed: 0,
          backupExists,
          error: (err as Error).message
        })
      }
    }
    return out
  }

  async apply(plans: WritePlan[]): Promise<ApplyResult[]> {
    if (!this.opts.live)
      throw new Error(
        'vault writes are in dry-run mode; enable live writes in Settings after approving the schema'
      )
    const results: ApplyResult[] = []
    for (const [notePath, notePlans] of groupByNote(plans)) {
      try {
        if (!(await exists(notePath)))
          throw new Error('note does not exist (the dashboard never creates notes)')
        const current = await readFile(notePath, 'utf8')
        for (const p of notePlans) findBlock(current, p.key)
        const { text } = VaultWriter.render(current, notePlans)
        if (text === current) {
          results.push({
            notePath,
            written: false,
            conflictCopies: await this.conflictCopies(notePath)
          })
          continue
        }
        const backupPath = await this.backupOnce(notePath)
        await this.atomicWrite(notePath, text)
        results.push({
          notePath,
          written: true,
          backupPath,
          conflictCopies: await this.conflictCopies(notePath)
        })
      } catch (err) {
        results.push({
          notePath,
          written: false,
          conflictCopies: [],
          error: (err as Error).message
        })
      }
    }
    return results
  }

  /** Copies the note into the backup folder the first time it is written; later writes keep it. */
  async backupOnce(notePath: string): Promise<string> {
    const target = this.backupPathFor(notePath)
    if (await exists(target)) return target
    await mkdir(this.backupDir(), { recursive: true })
    await copyFile(notePath, target)
    return target
  }

  async atomicWrite(notePath: string, text: string): Promise<void> {
    await mkdir(this.tmpDir(), { recursive: true })
    const stamp = (this.opts.now ?? (() => new Date()))().getTime().toString(36)
    const tmp = join(this.tmpDir(), `${basename(notePath)}.${process.pid}.${stamp}.tmp`)
    await writeFile(tmp, text, 'utf8')
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, notePath)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EXDEV') {
          // Different volumes: copy over, then remove the temp file.
          await copyFile(tmp, notePath)
          await unlink(tmp).catch(() => undefined)
          break
        }
        // OneDrive or an antivirus scanner can hold the note for a moment on Windows.
        if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 5) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
          continue
        }
        await unlink(tmp).catch(() => undefined)
        throw err
      }
    }
    const s = await stat(notePath)
    if (s.size !== Buffer.byteLength(text, 'utf8'))
      throw new Error(`size mismatch after writing ${notePath}`)
  }

  /** Lists OneDrive conflict copies that sit next to the note and share its base name. */
  async conflictCopies(notePath: string): Promise<string[]> {
    const dir = dirname(notePath)
    const base = basename(notePath, extname(notePath)).toLowerCase()
    try {
      const names = await readdir(dir)
      return names
        .filter(
          (n) =>
            n.toLowerCase() !== basename(notePath).toLowerCase() &&
            n.toLowerCase().startsWith(base) &&
            isConflictCopy(n)
        )
        .map((n) => join(dir, n))
    } catch {
      return []
    }
  }

  /** Scans the whole vault for conflict copies (any file), for the dashboard's health panel. */
  static async scanConflicts(vaultPath: string, limit = 50): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= limit) return
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.name === '.obsidian' || e.name === '.trash' || e.name === '.git') continue
        const p = join(dir, e.name)
        if (e.isDirectory()) await walk(p)
        else if (isConflictCopy(e.name)) out.push(p)
        if (out.length >= limit) return
      }
    }
    await walk(vaultPath)
    return out
  }
}
