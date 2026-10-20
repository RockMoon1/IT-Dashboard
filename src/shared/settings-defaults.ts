import type { Settings } from './types.ts'

/** Settings written by this version. Older files are migrated once in loadSettings. */
export const SETTINGS_VERSION = 2

/** Defaults, shared by the main process and the Settings panel. */
export const DEFAULT_SETTINGS: Settings = {
  vaultPath: 'C:\\Users\\lpell\\OneDrive\\Documents\\Obsidian Vault\\ARH IT',
  hubNote: 'ARH IT Hub.md',
  workLogNote: 'ARH Work Log.md',
  openLoopsNote: 'ARH Open Loops.md',
  assetNote: 'Assets/Asset Inventory.md',
  // approved by Lisandro on 2026-10-20 ("go for it"); still switchable in Settings
  vaultLive: true,
  schemaApproved: true,
  // the vault uses no due dates (inspection 2026-10-15: 0 of 709 tasks carry one)
  dueStyle: 'none',
  technician: '',
  beaconAllAdapters: false,
  usbPollMs: 10_000,
  adapterPollMs: 15_000,
  linkPort: 47912,
  settingsVersion: SETTINGS_VERSION,
  // full access by default, as asked on 2026-10-20; each can be switched off in Settings
  vaultRead: true,
  vaultAutoWrite: true,
  deviceScan: true,
  deviceWrite: true,
  deviceExecute: true,
  customCommands: true,
  confirmChanges: true,
  previewFirst: true,
  disabledActions: [],
  changeLogNote: 'ARH Change Log.md',
  // named write and execute actions; custom commands need a choice on each device (or "full")
  installPolicy: 'actions',
  saveCustomOutput: false
}
