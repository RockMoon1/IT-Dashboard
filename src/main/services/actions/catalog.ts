import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActionDef, ActionParamDef } from '../../../shared/actions.ts'

/**
 * The dashboard's copy of the named actions: the same files the agent embeds (actions/*.json),
 * hashed byte for byte. The dashboard shows a script and sends a request only when its copy's
 * hash equals the one the device reported in hello, so what the technician reads is what runs.
 */

export const ACTION_SCHEMA = 'arh-action/1'

function str(o: Record<string, unknown>, k: string): string {
  return typeof o[k] === 'string' ? (o[k] as string) : ''
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Shape check only; the agent applies the full rules (actions/embed.go Validate). */
export function parseAction(raw: Buffer): ActionDef {
  const o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  if (o['schema'] !== ACTION_SCHEMA)
    throw new Error(`schema ${String(o['schema'])} is not ${ACTION_SCHEMA}`)
  const name = str(o, 'name')
  if (!/^[a-z0-9-]{1,80}$/.test(name)) throw new Error('action needs a lowercase name')
  const os = str(o, 'os')
  if (os !== 'windows' && os !== 'macos' && os !== 'linux') throw new Error(`${name}: unknown os`)
  const access = str(o, 'access')
  if (access !== 'write' && access !== 'execute') throw new Error(`${name}: access ${access}`)
  const impact = str(o, 'impact')
  if (impact !== 'quiet' && impact !== 'slows' && impact !== 'interrupts')
    throw new Error(`${name}: impact ${impact}`)
  if (typeof o['version'] !== 'number' || o['version'] <= 0)
    throw new Error(`${name}: version must be positive`)
  const params: ActionParamDef[] = (Array.isArray(o['params']) ? o['params'] : []).map((x) => {
    const p = (x ?? {}) as Record<string, unknown>
    const ex = (p['examples'] ?? {}) as Record<string, unknown>
    return {
      name: str(p, 'name'),
      label: str(p, 'label'),
      pattern: str(p, 'pattern'),
      maxLength: typeof p['maxLength'] === 'number' ? p['maxLength'] : 0,
      required: p['required'] === true,
      default: str(p, 'default'),
      choices: strings(p['choices']),
      examples: { ok: strings(ex['ok']), bad: strings(ex['bad']) }
    }
  })
  const fixes = strings(o['fixes'])
  for (const f of fixes) new RegExp(f) // throws on a pattern JavaScript cannot compile
  return {
    schema: ACTION_SCHEMA,
    name,
    version: o['version'],
    os,
    access,
    category: str(o, 'category'),
    title: str(o, 'title'),
    description: str(o, 'description'),
    impact,
    reversible: o['reversible'] === true,
    undo: str(o, 'undo'),
    manualUndo: str(o, 'manualUndo'),
    abortable: o['abortable'] === true,
    concurrent: o['concurrent'] === true,
    fixes,
    shell: os === 'windows' ? 'powershell' : 'sh',
    timeoutSeconds: typeof o['timeoutSeconds'] === 'number' ? o['timeoutSeconds'] : 120,
    settleSeconds: typeof o['settleSeconds'] === 'number' ? o['settleSeconds'] : 0,
    params,
    measure: strings(o['measure']),
    apply: strings(o['apply']),
    sha256: createHash('sha256').update(raw).digest('hex')
  }
}

export class ActionCatalog {
  private actions = new Map<string, ActionDef>()
  errors: string[] = []

  async load(dir: string): Promise<void> {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
    const next = new Map<string, ActionDef>()
    const errors: string[] = []
    for (const f of files) {
      try {
        const a = parseAction(await readFile(join(dir, f)))
        if (`${a.name}.json` !== f) throw new Error('file name must equal the action name')
        next.set(a.name, a)
      } catch (err) {
        errors.push(`${f}: ${(err as Error).message}`)
      }
    }
    this.actions = next
    this.errors = errors
  }

  list(): ActionDef[] {
    return [...this.actions.values()]
  }

  get(name: string): ActionDef | undefined {
    return this.actions.get(name)
  }

  forOs(os: string): ActionDef[] {
    return this.list().filter((a) => a.os === os)
  }

  /** Actions whose `fixes` pattern matches a finding ("Category: message"). */
  fixesFor(os: string, category: string, message: string): ActionDef[] {
    const text = `${category}: ${message}`
    return this.forOs(os).filter((a) => a.fixes.some((f) => new RegExp(f).test(text)))
  }
}
