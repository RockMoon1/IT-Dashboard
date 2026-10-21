import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

/**
 * Read-only, in-memory copy of the vault's Markdown notes so a computer lookup answers in
 * milliseconds. A refresh stats every note and re-reads only the ones whose size or mtime
 * changed; refreshes closer together than `maxAgeMs` reuse the last result.
 */

/**
 * A note as written: its text, lines, frontmatter and title keep its comments. What a screen
 * shows of it comes from notes.ts shownOf, as the reader shows it.
 */
export interface IndexedNote {
  /** Path relative to the vault folder, with the platform's separator. */
  rel: string
  abs: string
  /** File name without .md */
  name: string
  /** First folder under the vault ('' for notes at the top). */
  folder: string
  text: string
  lines: string[]
  frontmatter: Record<string, string>
  /** First line that starts with "# " (also in a comment), else the file name. */
  title: string
  mtimeMs: number
  size: number
}

export function parseFrontmatter(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if ((lines[0] ?? '').trim() !== '---') return out
  for (let i = 1; i < lines.length && i < 200; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '---') break
    const m = /^([A-Za-z0-9_\- ]+):\s*(.*)$/.exec(line)
    if (m?.[1]) out[m[1].trim()] = (m[2] ?? '').trim()
  }
  return out
}

export function toNote(root: string, abs: string, text: string, mtimeMs: number): IndexedNote {
  const rel = relative(root, abs)
  const lines = text.split(/\r?\n/)
  const title = lines
    .find((l) => /^#\s+/.test(l))
    ?.replace(/^#\s+/, '')
    .trim()
  return {
    rel,
    abs,
    name: basename(abs).replace(/\.md$/i, ''),
    folder: rel.includes(sep) ? (rel.split(sep)[0] ?? '') : '',
    text,
    lines,
    frontmatter: parseFrontmatter(lines),
    title: title || basename(abs).replace(/\.md$/i, ''),
    mtimeMs,
    size: Buffer.byteLength(text, 'utf8')
  }
}

async function* markdownFiles(dir: string): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* markdownFiles(p)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield p
  }
}

export class VaultIndex {
  private root = ''
  private cache = new Map<string, IndexedNote>()
  private lastRefresh = 0
  private pending: { root: string; promise: Promise<IndexedNote[]> } | null = null
  private readonly maxAgeMs: number
  private readonly maxFileBytes: number
  error: string | undefined

  constructor(opts: { maxAgeMs?: number; maxFileBytes?: number } = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 2000
    this.maxFileBytes = opts.maxFileBytes ?? 4 * 1024 * 1024
  }

  /** Notes of the vault at `root`, refreshed if the last refresh is older than maxAgeMs. */
  async notes(root: string, force = false): Promise<IndexedNote[]> {
    if (root !== this.root) {
      this.root = root
      this.cache.clear()
      this.lastRefresh = 0
    }
    if (!force && Date.now() - this.lastRefresh < this.maxAgeMs && this.cache.size)
      return [...this.cache.values()]
    // share a refresh only with callers asking for the same folder
    if (this.pending?.root !== root) {
      const promise = this.refresh(root).finally(() => {
        if (this.pending?.promise === promise) this.pending = null
      })
      this.pending = { root, promise }
    }
    return this.pending.promise
  }

  /**
   * Builds the note set for `root` from the cache plus whatever changed, then keeps it only if
   * the vault folder is still `root` (the folder can change in Settings while OneDrive is slow).
   */
  private async refresh(root: string): Promise<IndexedNote[]> {
    const previous = new Map(this.cache)
    const next = new Map<string, IndexedNote>()
    let error: string | undefined
    try {
      await stat(root)
      for await (const abs of markdownFiles(root)) {
        try {
          const s = await stat(abs)
          const cached = previous.get(abs)
          if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) {
            next.set(abs, cached)
            continue
          }
          if (s.size > this.maxFileBytes) continue
          const note = toNote(root, abs, await readFile(abs, 'utf8'), s.mtimeMs)
          note.size = s.size // bytes on disk, compared on the next refresh
          next.set(abs, note)
        } catch {
          /* unreadable or removed while walking: leave it out */
        }
      }
    } catch (err) {
      error = `vault folder not readable: ${(err as Error).message}`
    }
    if (this.root !== root) return [...next.values()]
    this.cache = next
    this.error = error
    this.lastRefresh = Date.now()
    return [...next.values()]
  }
}
