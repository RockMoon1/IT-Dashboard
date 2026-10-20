import type { InjectionKey } from 'vue'
import type { NoteLinkTarget } from '@shared/types'

/** What the Markdown components need from the viewer that shows them. */
export interface MdContext {
  /** Where each [[target]] of the current note points (null: not a note in the vault). */
  readonly links: Record<string, NoteLinkTarget | null>
  /** Follow a [[link]] inside the dashboard; an empty target is a heading in the same note. */
  openWiki(target: string, heading?: string): void
}

export const MD_KEY: InjectionKey<MdContext> = Symbol('markdown-context')

/** Obsidian callout kinds grouped by meaning, so each gets one tone and one icon. */
export function calloutStyle(kind: string): { icon: string; cls: string } {
  const k = kind.toLowerCase()
  if (['danger', 'error', 'bug', 'failure', 'fail', 'missing'].includes(k))
    return { icon: '⛔', cls: 'border-bad-400/50 bg-bad-400/5' }
  if (['warning', 'caution', 'attention'].includes(k))
    return { icon: '⚠', cls: 'border-warn-400/50 bg-warn-400/5' }
  if (['tip', 'hint', 'success', 'check', 'done'].includes(k))
    return { icon: '✓', cls: 'border-ok-400/40 bg-ok-400/5' }
  if (['question', 'help', 'faq'].includes(k))
    return { icon: '?', cls: 'border-info-400/40 bg-info-400/5' }
  if (['quote', 'cite'].includes(k)) return { icon: '❝', cls: 'border-white/15 bg-white/5' }
  if (['important'].includes(k)) return { icon: '!', cls: 'border-gold-400/50 bg-gold-400/5' }
  return { icon: 'ℹ', cls: 'border-info-400/40 bg-info-400/5' } // note, info, abstract, todo …
}

/** Task box as text, matching Obsidian's statuses. */
export function taskMark(status: string): string {
  if (status === 'x' || status === 'X') return '☑'
  if (status === '/') return '◐'
  if (status === '-') return '⊘'
  if (status === ' ') return '☐'
  return `[${status}]`
}
