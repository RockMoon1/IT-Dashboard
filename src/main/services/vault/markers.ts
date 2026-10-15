/**
 * Marker-delimited blocks inside existing notes:
 *   <!-- DASH:DEVICE-SCANS:START -->
 *   …managed text…
 *   <!-- DASH:DEVICE-SCANS:END -->
 * The writer replaces only what lies between its own markers. Missing markers are appended once
 * at the end of the note. Text outside markers is never touched.
 */

export type Eol = '\r\n' | '\n'

export function detectEol(text: string): Eol {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

export function markerKeyValid(key: string): boolean {
  return /^[A-Z0-9][A-Z0-9_-]{0,40}$/.test(key)
}

export function startMarker(key: string): string {
  return `<!-- DASH:${key}:START -->`
}

export function endMarker(key: string): string {
  return `<!-- DASH:${key}:END -->`
}

export interface Block {
  /** Offset of the start marker line's first character. */
  start: number
  /** Offset just past the end marker line (excluding its line terminator). */
  end: number
  body: string
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Finds the managed block; throws if markers are malformed (unbalanced or duplicated). */
export function findBlock(text: string, key: string): Block | null {
  if (!markerKeyValid(key)) throw new Error(`invalid marker key ${JSON.stringify(key)}`)
  const startRe = new RegExp(`^[ \\t]*${escapeRe(startMarker(key))}[ \\t]*$`, 'gm')
  const endRe = new RegExp(`^[ \\t]*${escapeRe(endMarker(key))}[ \\t]*$`, 'gm')
  const starts = [...text.matchAll(startRe)]
  const ends = [...text.matchAll(endRe)]
  if (starts.length === 0 && ends.length === 0) return null
  if (starts.length !== 1 || ends.length !== 1)
    throw new Error(
      `note has ${starts.length} start and ${ends.length} end markers for ${key}; expected one of each`
    )
  const s = starts[0]!
  const e = ends[0]!
  if (e.index! < s.index!) throw new Error(`end marker for ${key} comes before its start marker`)
  const bodyStart = s.index! + s[0].length
  const bodyEnd = e.index!
  const eol = detectEol(text)
  let body = text.slice(bodyStart, bodyEnd)
  if (body.startsWith(eol)) body = body.slice(eol.length)
  if (body.endsWith(eol)) body = body.slice(0, -eol.length)
  return { start: s.index!, end: e.index! + e[0].length, body }
}

/** Returns the note text with the block body replaced (or the block appended at the end). */
export function setBlock(
  text: string,
  key: string,
  body: string
): { text: string; created: boolean } {
  const eol = detectEol(text)
  const normalizedBody = body.replace(/\r?\n/g, eol).replace(new RegExp(`(${escapeRe(eol)})+$`), '')
  const block = findBlock(text, key)
  const rendered = `${startMarker(key)}${eol}${normalizedBody}${normalizedBody ? eol : ''}${endMarker(key)}`
  if (block) {
    return { text: text.slice(0, block.start) + rendered + text.slice(block.end), created: false }
  }
  let base = text
  const hadTrailingNewline = base.endsWith(eol)
  base = base.replace(new RegExp(`(${escapeRe(eol)})+$`), '')
  const separator = base.length ? `${eol}${eol}` : ''
  const suffix = hadTrailingNewline || base.length === 0 ? eol : eol
  return { text: `${base}${separator}${rendered}${suffix}`, created: true }
}

/** Reads the current body of a block, or null when absent. */
export function getBlock(text: string, key: string): string | null {
  return findBlock(text, key)?.body ?? null
}
