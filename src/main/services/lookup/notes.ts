import { posix, sep } from 'node:path'
import type { NoteLinkTarget, NoteView } from '../../../shared/types.ts'
import { parseMarkdown, type Block, type ParsedNote } from '../../../shared/markdown.ts'
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
 * match the end of a note's path; a bare name matches the file name; "./" and "../" start from
 * the linking note's folder. With several candidates the one in the linking note's folder
 * wins, then the shortest path.
 */
export function resolveLink(
  target: string,
  from: Pick<IndexedNote, 'rel'> | null,
  notes: IndexedNote[]
): IndexedNote | null {
  const fromDir = from ? lower(slash(from.rel)).split('/').slice(0, -1).join('/') : ''
  let t = lower(noExt(target.replace(/\\/g, '/')))
  const relative = /^\.\.?\//.test(t)
  t = relative ? posix.join(fromDir, t) : t.replace(/^\/+/, '')
  if (!t) return null
  const hasPath = t.includes('/')
  const candidates = notes.filter((n) => {
    const rel = lower(noExt(slash(n.rel)))
    if (relative) return rel === t
    return hasPath ? rel === t || rel.endsWith(`/${t}`) : lower(n.name) === t
  })
  if (!candidates.length) return null
  return [...candidates].sort((a, b) => {
    const da = lower(slash(a.rel)).split('/').slice(0, -1).join('/') === fromDir ? 0 : 1
    const db = lower(slash(b.rel)).split('/').slice(0, -1).join('/') === fromDir ? 0 : 1
    return da - db || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel)
  })[0]!
}

/**
 * A note's title as the reader shows it: the text of its first # heading, comments hidden, or
 * its file name. Not the index's title, which is the first line that starts with "# " as
 * written, also in a comment, a property's YAML comment or code.
 */
function titleOf(note: IndexedNote, blocks: Block[]): string {
  const h = blocks.find((b) => b.t === 'heading' && b.level === 1)
  return (h?.t === 'heading' && h.text) || note.name
}

/**
 * A note as the reader shows it, for every screen that shows a note's text: its links, its lines
 * (comments and YAML comments hidden, each line where it was), its title and its properties.
 * Parsed once per version (the index replaces the object when the file changes). The index's
 * own text, lines, title and frontmatter are as written, comments too.
 */
export type Shown = Pick<ParsedNote, 'linkLines' | 'lines'> & {
  title: string
  frontmatter: Record<string, string>
}
const shownCache = new WeakMap<IndexedNote, Shown>()
export function shownOf(note: IndexedNote): Shown {
  let shown = shownCache.get(note)
  if (!shown) {
    try {
      const { linkLines, lines, blocks, frontmatter } = parseMarkdown(note.text)
      shown = {
        linkLines,
        lines,
        title: titleOf(note, blocks),
        frontmatter: Object.fromEntries(frontmatter)
      }
    } catch {
      // one note the parser cannot read must not stop the notes it mentions opening; none of
      // its text shows
      shown = { linkLines: [], lines: [], title: note.name, frontmatter: {} }
    }
    shownCache.set(note, shown)
  }
  return shown
}

/**
 * Notes that link to `note` where the reader shows a link: [[Name]], [[Name|…]], [[Name#…]],
 * [[folder/Name]], [text](Name.md) and properties; not in code or comments. One per line.
 */
export function backlinks(
  note: IndexedNote,
  notes: IndexedNote[],
  limit = 60
): NoteView['backlinks'] {
  const out: NoteView['backlinks'] = []
  // only notes that mention the name (as written or URL-encoded) are parsed
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = [note.name, note.name.replace(/ /g, '%20'), encodeURI(note.name)]
  const mentions = new RegExp(names.map(esc).join('|'), 'i')
  for (const other of notes) {
    if (other.abs === note.abs || !mentions.test(other.text)) continue
    const seen = new Set<number>()
    const { linkLines, lines, title } = shownOf(other)
    for (const { target, line } of linkLines) {
      if (out.length >= limit) break
      if (seen.has(line) || resolveLink(target, other, notes)?.abs !== note.abs) continue
      seen.add(line)
      out.push({
        file: other.rel,
        title,
        line,
        // the line as the reader shows it: a comment on it may hold a patient's details
        text: (lines[line - 1] ?? '').trim().slice(0, 300)
      })
    }
    if (out.length >= limit) break
  }
  return out
}

export function noteView(note: IndexedNote, notes: IndexedNote[]): NoteView {
  const parsed = parseMarkdown(note.text)
  const links: Record<string, NoteLinkTarget | null> = {}
  for (const target of parsed.links) {
    const hit = resolveLink(target, note, notes)
    links[target] = hit ? { file: hit.rel, title: shownOf(hit).title } : null
  }
  return {
    file: note.rel,
    title: titleOf(note, parsed.blocks),
    folder: note.folder,
    mtimeMs: note.mtimeMs,
    frontmatter: parsed.frontmatter,
    blocks: parsed.blocks,
    links,
    backlinks: backlinks(note, notes)
  }
}
