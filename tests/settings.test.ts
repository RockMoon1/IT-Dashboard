import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  mergeSettings,
  saveSettings
} from '../src/main/services/settings.ts'

test('mergeSettings accepts known keys with the right type, clamps intervals and ignores junk', () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, {
    vaultPath: 'D:\\Vault',
    usbPollMs: 10,
    networkRefreshMs: 'soon',
    unknown: 1,
    knownHosts: { 'a:22': 'fp', bad: 3 }
  })
  assert.equal(merged.vaultPath, 'D:\\Vault')
  assert.equal(merged.usbPollMs, 2000)
  assert.equal(merged.networkRefreshMs, DEFAULT_SETTINGS.networkRefreshMs)
  assert.deepEqual(merged.knownHosts, { 'a:22': 'fp' })
  assert.ok(!('unknown' in merged))
  assert.notEqual(merged.knownHosts, DEFAULT_SETTINGS.knownHosts)
})

test('settings round-trip through disk and fall back to defaults when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'arh-settings-'))
  try {
    const file = join(dir, 'nested', 'settings.json')
    assert.deepEqual(await loadSettings(file), DEFAULT_SETTINGS)
    await saveSettings(file, {
      ...DEFAULT_SETTINGS,
      hubSection: 'Scans',
      knownHosts: { 'h:22': 'x' }
    })
    const loaded = await loadSettings(file)
    assert.equal(loaded.hubSection, 'Scans')
    assert.deepEqual(loaded.knownHosts, { 'h:22': 'x' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
