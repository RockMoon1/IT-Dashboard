import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  saveSettings
} from '../src/main/services/settings.ts'

test('mergeSettings accepts known keys, clamps intervals, ignores junk and keeps live writes behind schema approval', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, {
    vaultPath: 'D:\\Vault',
    usbPollMs: 10,
    adapterPollMs: 'soon',
    unknown: 1,
    dueStyle: 'dataview',
    schemaApproved: false,
    vaultLive: true
  })
  assert.equal(merged.vaultPath, 'D:\\Vault')
  assert.equal(merged.usbPollMs, 2000)
  assert.equal(merged.adapterPollMs, DEFAULT_SETTINGS.adapterPollMs)
  assert.equal(merged.dueStyle, 'dataview')
  assert.equal(merged.vaultLive, false, 'live writes stay off until the schema is approved')
  assert.ok(!('unknown' in merged))
  const approved = mergeSettings(DEFAULT_SETTINGS, { schemaApproved: true, vaultLive: true })
  assert.equal(approved.vaultLive, true)
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { dueStyle: 'weird' }).dueStyle, 'none')
  assert.equal(mergeSettings(DEFAULT_SETTINGS, { linkPort: 80 }).linkPort, 47912)
})

test('settings round-trip through disk and fall back to defaults when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-settings-'))
  try {
    const file = join(dir, 'nested', 'settings.json')
    assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS)
    await saveSettings(file, {
      ...DEFAULT_SETTINGS,
      technician: 'Lisandro',
      schemaApproved: true,
      vaultLive: true
    })
    const loaded = await loadSettings(file)
    assert.equal(loaded.technician, 'Lisandro')
    assert.equal(loaded.vaultLive, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settings saved before the 2026-10-20 approval are migrated once; later choices stick', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-settings-'))
  try {
    const file = join(dir, 'settings.json')
    // what the app saved before: no version, schema not approved, live writes off
    await writeFile(
      file,
      JSON.stringify({ technician: 'Lisandro', schemaApproved: false, vaultLive: false }),
      'utf8'
    )
    const migrated = await loadSettings(file)
    assert.equal(migrated.schemaApproved, true)
    assert.equal(migrated.vaultLive, true)
    assert.equal(migrated.settingsVersion, 2)
    assert.equal(migrated.technician, 'Lisandro')
    assert.equal(migrated.deviceWrite, true, 'new access switches default to full access')
    // once saved at version 2, switching live writes off again is respected
    await saveSettings(file, { ...migrated, vaultLive: false })
    assert.equal((await loadSettings(file)).vaultLive, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('access switches and the per-action list accept only sane values', () => {
  const s = mergeSettings(DEFAULT_SETTINGS, {
    deviceExecute: false,
    customCommands: 'no',
    disabledActions: ['restart-computer', 'restart-computer', 'Bad Name', 7, 'dns-flush']
  })
  assert.equal(s.deviceExecute, false)
  assert.equal(s.customCommands, true, 'wrong type ignored')
  assert.deepEqual(s.disabledActions, ['restart-computer', 'dns-flush'])
})
