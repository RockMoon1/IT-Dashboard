import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Settings } from '../../shared/types.ts'

export const DEFAULT_SETTINGS: Settings = {
  vaultPath: 'C:\\Users\\lpell\\OneDrive\\Documents\\Obsidian Vault\\ARH IT',
  hubNote: 'ARH IT Hub.md',
  workLogNote: 'ARH Work Log.md',
  hubSection: 'Device Scans',
  autoLog: true,
  workLogNewestFirst: false,
  usbPollMs: 10_000,
  networkDiscovery: true,
  networkRefreshMs: 60_000,
  strictHostKeys: false,
  knownHosts: {},
  defaultUsername: ''
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Shallow merge that only accepts known keys with the right primitive type. */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  if (!isRecord(patch)) return { ...base }
  const out: Settings = { ...base, knownHosts: { ...base.knownHosts } }
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (!(key in patch)) continue
    const value = patch[key]
    if (key === 'knownHosts') {
      if (isRecord(value)) {
        const hosts: Record<string, string> = {}
        for (const [h, fp] of Object.entries(value)) if (typeof fp === 'string') hosts[h] = fp
        out.knownHosts = hosts
      }
      continue
    }
    const expected = typeof DEFAULT_SETTINGS[key]
    if (typeof value === expected) {
      if (expected === 'number' && !(Number.isFinite(value as number) && (value as number) >= 0))
        continue
      ;(out as unknown as Record<string, unknown>)[key] = value
    }
  }
  if (out.usbPollMs < 2000) out.usbPollMs = 2000
  if (out.networkRefreshMs < 10_000) out.networkRefreshMs = 10_000
  return out
}

export async function loadSettings(file: string): Promise<Settings> {
  try {
    const raw = await readFile(file, 'utf8')
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS, knownHosts: {} }
  }
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(settings, null, 2), 'utf8')
}
