import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Settings } from '../../shared/types.ts'

import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../../shared/settings-defaults.ts'

export { DEFAULT_SETTINGS, SETTINGS_VERSION }

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
    if (key === 'disabledActions') {
      if (Array.isArray(value))
        out.disabledActions = [
          ...new Set(
            value.filter((v): v is string => typeof v === 'string' && /^[a-z0-9-]{1,80}$/.test(v))
          )
        ].slice(0, 500)
      continue
    }
    if (key === 'installPolicy') {
      if (value === 'actions' || value === 'full' || value === 'read' || value === 'clinical')
        out.installPolicy = value
      continue
    }
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

/**
 * One-time changes for settings saved by an older version.
 * v1 -> v2: Lisandro approved the vault mapping on 2026-10-20, so the "schema approved" and
 * "live writes" switches are turned on once; he can switch them off again in Settings.
 */
export function migrateSettings(stored: unknown, merged: Settings): Settings {
  const version =
    typeof stored === 'object' && stored !== null && 'settingsVersion' in stored
      ? Number((stored as { settingsVersion: unknown }).settingsVersion) || 1
      : 1
  const out = { ...merged }
  if (version < 2) {
    out.schemaApproved = true
    out.vaultLive = true
  }
  out.settingsVersion = SETTINGS_VERSION
  return out
}

export async function loadSettings(file: string): Promise<Settings> {
  let stored: unknown
  try {
    stored = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return { ...DEFAULT_SETTINGS, disabledActions: [] }
  }
  return migrateSettings(stored, mergeSettings(DEFAULT_SETTINGS, stored))
}

export async function saveSettings(file: string, settings: Settings): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(settings, null, 2), 'utf8')
}
