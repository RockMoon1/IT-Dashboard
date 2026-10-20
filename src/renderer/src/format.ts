import type { HealthScore, Severity } from '@shared/types'

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local date and time (the technician PC's clock), or the date as written when it has no time. */
export function when(iso?: string): string {
  if (!iso) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ago(iso?: string, now: number = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((now - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

/** Status always travels with an icon and a word, never colour alone. */
export function scoreBadge(score?: HealthScore): { icon: string; text: string; cls: string } {
  if (score === 'critical') return { icon: '●', text: 'Critical', cls: 'text-bad-400' }
  if (score === 'attention') return { icon: '▲', text: 'Attention', cls: 'text-warn-400' }
  if (score === 'healthy') return { icon: '✓', text: 'Healthy', cls: 'text-ok-400' }
  return { icon: '○', text: 'Not scanned', cls: 'text-mist-500' }
}

export function severityBadge(s: Severity): { icon: string; text: string; cls: string } {
  if (s === 'critical') return { icon: '●', text: 'Critical', cls: 'text-bad-400' }
  if (s === 'warning') return { icon: '▲', text: 'Warning', cls: 'text-warn-400' }
  return { icon: 'i', text: 'Info', cls: 'text-info-400' }
}
