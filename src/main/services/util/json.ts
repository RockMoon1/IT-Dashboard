export type Json = Record<string, unknown>

/** Parses the JSON document a diagnostic script printed, tolerating stray lines before it. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse()
    for (const line of lines) {
      const l = line.trim()
      if (l.startsWith('{') || l.startsWith('[')) {
        try {
          return JSON.parse(l)
        } catch {
          /* keep looking */
        }
      }
    }
    return null
  }
}

/** ConvertTo-Json unwraps single-element arrays on PowerShell 5.1; normalise back to an array. */
export function asArray<T = Json>(value: unknown): T[] {
  if (value == null) return []
  return Array.isArray(value) ? (value as T[]) : [value as T]
}
