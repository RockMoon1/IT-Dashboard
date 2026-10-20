import { sep } from 'node:path'
import type { NoteLinkTarget, NoteView } from '../../../shared/types.ts'
import { parseMarkdown } from '../../../shared/markdown.ts'
import type { IndexedNote } from './vaultindex.ts'

/**
 * Reading a note inside the dashboard: the note itself, where each of its [[links]] points, and
 * which notes link to it. Everything comes from the in-memory vault index; nothing is written.
 */

const slash = (p: string): string => p.split(sep).join('/')
const lower = (s: string): string => s.trim().toLowerCase()
const noExt = (p: string): string => p.replace(/\.md$/i, '')

/**
 * Where a wikilink target points, the way Obsidian resolves it: a path ("Tickets/Note") must
 * match the end of a note's path; a bare name matches the file name. With several candidates
 * the one in the linking note's folder wins, then the shortest path.
 */
export function resolveLink(
  target: string,
  from: Pick<IndexedNote, 'rel'> | null,
  notes: IndexedNote[]
): IndexedNote | null {
  const t = lower(noExt(target.replace(/\\/g, '/')))
  if (!t) return null
  const hasPath = t.includes('/')
  const candidates = notes.filter((n) => {
    const rel = lower(noExt(slash(n.rel)))
    return hasPath ? rel === t || rel.endsWith(`/${t}`) : lower(n.name) === t
  })
  if (!candidates.length) return null
  const fromDir = from ? lower(slash(from.rel)).split('/').slice(0, -1).join('/') : ''
  return [...candidates].sort((a, b) => {
    const da = lower(slash(a.rel)).split('/').slice(0, -1).join('/') === fromDir ? 0 : 1
    const db = lower(slash(b.rel)).split('/').slice(0, -1).join('/') === fromDir ? 0 : 1
    return da - db || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel)
  })[0]!
}

/** Notes whose lines link to `note` by [[Name]], [[Name|…]], [[Name#…]] or [[folder/Name]]. */
export function backlinks(
  note: IndexedNote,
  notes: IndexedNote[],
  limit = 60
): NoteView['backlinks'] {
  const out: NoteView['backlinks'] = []
  const re = /!?\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g
  for (const other of notes) {
    if (other.abs === note.abs) continue
    other.lines.forEach((line, i) => {
      if (out.length >= limit) return
      for (const m of line.matchAll(re)) {
        const target = m[1] ?? ''
        if (resolveLink(target, other, notes)?.abs !== note.abs) continue
        out.push({
          file: other.rel,
          title: other.title,
          line: i + 1,
          text: line.trim().slice(0, 300)
        })
        break
      }
    })
    if (out.length >= limit) break
  }
  return out
}

export function noteView(note: IndexedNote, notes: IndexedNote[]): NoteView {
  const parsed = parseMarkdown(note.text)
  const links: Record<string, NoteLinkTarget | null> = {}
  for (const target of parsed.links) {
    const hit = resolveLink(target, note, notes)
    links[target] = hit ? { file: hit.rel, title: hit.title } : null
  }
  return {
    file: note.rel,
    title: note.title,
    folder: note.folder,
    mtimeMs: note.mtimeMs,
    frontmatter: parsed.frontmatter,
    blocks: parsed.blocks,
    links,
    backlinks: backlinks(note, notes)
  }
}
