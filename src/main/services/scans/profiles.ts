import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Purpose } from '../../../shared/types.ts'

/**
 * Host-side copy of the scan profiles. Same files, same validation rules as profiles/embed.go.
 * The host only ever sends { profile, version } to an agent; it never sends a command.
 */

export const PROFILE_SCHEMA = 'arh-scan-profile/1'

export interface ProfileCheck {
  id: string
  title: string
  category: string
  shell: 'powershell' | 'sh'
  command: string[]
  format: 'json' | 'text'
  timeoutSeconds: number
  optional: boolean
  access: 'read'
}

export interface ScanProfile {
  schema: string
  name: string
  version: number
  os: 'windows' | 'macos' | 'linux'
  purpose: Exclude<Purpose, 'other'>
  title: string
  description: string
  checks: ProfileCheck[]
}

export function validateProfile(p: unknown): ScanProfile {
  if (!p || typeof p !== 'object') throw new Error('profile is not an object')
  const o = p as Record<string, unknown>
  if (o['schema'] !== PROFILE_SCHEMA)
    throw new Error(`schema ${String(o['schema'])} is not ${PROFILE_SCHEMA}`)
  if (typeof o['name'] !== 'string' || !o['name']) throw new Error('profile needs a name')
  if (typeof o['version'] !== 'number' || o['version'] <= 0)
    throw new Error(`${o['name']}: version must be positive`)
  if (!['windows', 'macos', 'linux'].includes(String(o['os'])))
    throw new Error(`${o['name']}: unknown os`)
  if (typeof o['purpose'] !== 'string' || !o['purpose'])
    throw new Error(`${o['name']}: purpose is empty`)
  const checks = Array.isArray(o['checks']) ? (o['checks'] as unknown[]) : []
  if (!checks.length) throw new Error(`${o['name']}: no checks`)
  const ids = new Set<string>()
  const wantShell = o['os'] === 'windows' ? 'powershell' : 'sh'
  const out: ProfileCheck[] = checks.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>
    if (typeof c['id'] !== 'string' || !c['id'] || ids.has(c['id']))
      throw new Error(`${o['name']}: missing or duplicate check id`)
    ids.add(c['id'])
    if (c['access'] !== 'read')
      throw new Error(
        `${o['name']}/${c['id']}: access ${String(c['access'])} is not allowed in version 1`
      )
    if (c['shell'] !== wantShell)
      throw new Error(`${o['name']}/${c['id']}: shell ${String(c['shell'])} does not match os`)
    const command = Array.isArray(c['command'])
      ? (c['command'] as unknown[]).filter((l): l is string => typeof l === 'string')
      : []
    if (!command.join('').trim()) throw new Error(`${o['name']}/${c['id']}: empty command`)
    if (c['format'] !== 'json' && c['format'] !== 'text')
      throw new Error(`${o['name']}/${c['id']}: bad format`)
    return {
      id: c['id'],
      title: typeof c['title'] === 'string' ? c['title'] : c['id'],
      category: typeof c['category'] === 'string' ? c['category'] : 'General',
      shell: wantShell,
      command,
      format: c['format'],
      timeoutSeconds:
        typeof c['timeoutSeconds'] === 'number' && c['timeoutSeconds'] > 0
          ? c['timeoutSeconds']
          : 90,
      optional: c['optional'] === true,
      access: 'read'
    }
  })
  return {
    schema: PROFILE_SCHEMA,
    name: o['name'],
    version: o['version'],
    os: o['os'] as ScanProfile['os'],
    purpose: o['purpose'] as ScanProfile['purpose'],
    title: typeof o['title'] === 'string' ? o['title'] : o['name'],
    description: typeof o['description'] === 'string' ? o['description'] : '',
    checks: out
  }
}

/** "Other" has no profile of its own in version 1: it runs the baseline system diagnostics. */
export function profilePurpose(purpose: Purpose): ScanProfile['purpose'] {
  return purpose === 'other' ? 'system-diagnostics' : purpose
}

export class ProfileCatalog {
  private profiles = new Map<string, ScanProfile>()
  dir = ''

  async load(dir: string): Promise<ScanProfile[]> {
    this.dir = dir
    this.profiles.clear()
    const names = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
    for (const file of names) {
      const parsed = validateProfile(JSON.parse(await readFile(join(dir, file), 'utf8')))
      if (`${parsed.name}.json` !== file)
        throw new Error(`${file}: file name must equal profile name`)
      this.profiles.set(parsed.name, parsed)
    }
    return this.list()
  }

  list(): ScanProfile[] {
    return [...this.profiles.values()]
  }

  get(name: string): ScanProfile | undefined {
    return this.profiles.get(name)
  }

  forPurpose(os: ScanProfile['os'], purpose: Purpose): ScanProfile | undefined {
    return this.profiles.get(`${os}-${profilePurpose(purpose)}`)
  }

  summaries(): Array<{
    name: string
    version: number
    os: string
    purpose: string
    title: string
    checks: number
    categories: string[]
  }> {
    return this.list().map((p) => ({
      name: p.name,
      version: p.version,
      os: p.os,
      purpose: p.purpose,
      title: p.title,
      checks: p.checks.length,
      categories: [...new Set(p.checks.map((c) => c.category))]
    }))
  }
}
