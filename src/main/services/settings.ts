import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Settings } from '../../shared/types.ts'

export const DEFAULT_SETTINGS: Settings = {
  vaultPath: 'C:\\Users\\lpell\\OneDrive\\Documents\\Obsidian Vault\\ARH IT',
  hubNote: 'ARH IT Hub.md',
  workLogNote: 'ARH Work Log.md',
  openLoopsNote: 'ARH Open Loops.md',
  vaultLive: false,
  schemaApproved: false,
  dueStyle: 'tasks-emoji',
  technician: '',
  beaconAllAdapters: false,
  usbPollMs: 10_000,
  adapterPollMs: 15_000,
  linkPort: 47912
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Shallow merge that only accepts known keys with the right primitive type. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const out: Settings = { ...base }
  if (!isRecord(patch)) return out
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (key === 'dueStyle') {
      if (value === 'tasks-emoji' || value === 'dataview' || value === 'plain' || value === 'none')
        out.dueStyle = value
      continue
    }
    const expected = typeof DEFAULT_SETTINGS[key]
    if (typeof value !== expected) continue
    if (expected === 'number' && !(Number.isFinite(value as number) && (value as number) >= 0))
      continue
    ;(out as unknown as Record<string, unknown>)[key] = value
  }
  if (out.usbPollMs < 2000) out.usbPollMs = 2000
  if (out.adapterPollMs < 3000) out.adapterPollMs = 3000
  if (out.linkPort < 1024 || out.linkPort > 65535) out.linkPort = DEFAULT_SETTINGS.linkPort
  // Live writes require an approved schema; the UI cannot bypass this coupling.
  if (!out.schemaApproved) out.vaultLive = false
  return out
}

export async function loadSettings(file: string): Promise<Settings> {
  try {
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(settings, null, 2), 'utf8')
}
