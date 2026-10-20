import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

/**
 * Read-only, in-memory copy of the vault's Markdown notes so a computer lookup answers in
 * milliseconds. A refresh stats every note and re-reads only the ones whose size or mtime
 * changed; refreshes closer together than `maxAgeMs` reuse the last result.
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
  /** First "# " heading, else the file name. */
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
  private pending: Promise<IndexedNote[]> | null = null
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
    this.pending ??= this.refresh(root).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async refresh(root: string): Promise<IndexedNote[]> {
    const seen = new Set<string>()
    try {
      await stat(root)
      this.error = undefined
    } catch (err) {
      this.error = `vault folder not readable: ${(err as Error).message}`
      this.cache.clear()
      this.lastRefresh = Date.now()
      return []
    }
    for await (const abs of markdownFiles(root)) {
      seen.add(abs)
      try {
        const s = await stat(abs)
        const cached = this.cache.get(abs)
        if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size) continue
        if (s.size > this.maxFileBytes) continue
        const note = toNote(root, abs, await readFile(abs, 'utf8'), s.mtimeMs)
        note.size = s.size // bytes on disk, compared on the next refresh
        this.cache.set(abs, note)
      } catch {
        this.cache.delete(abs)
      }
    }
    for (const abs of [...this.cache.keys()]) if (!seen.has(abs)) this.cache.delete(abs)
    this.lastRefresh = Date.now()
    return [...this.cache.values()]
  }
}
