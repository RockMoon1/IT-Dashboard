import type {
  Device,
  OutputEvent,
  ProbeResult,
  SessionDoneEvent,
  SessionRequest,
  SessionSummary,
  Settings,
  VaultCheckResult,
  VaultWriteResult
} from './types.ts'

/** IPC channel names. Single source of truth for main, preload and renderer. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  devicesList: 'devices:list',
  devicesRefresh: 'devices:refresh',
  devicesAddManual: 'devices:add-manual',
  devicesRemove: 'devices:remove',
  devicesChanged: 'devices:changed',
  probeHost: 'probe:host',
  sessionStart: 'session:start',
  sessionAbort: 'session:abort',
  sessionGet: 'session:get',
  sessionOutput: 'session:output',
  sessionDone: 'session:done',
  vaultCheck: 'vault:check',
  vaultAppend: 'vault:append',
  vaultOpen: 'vault:open',
  appInfo: 'app:info'
} as const

export interface AppInfo {
  version: string
  platform: string
  powerShell: string
  settingsFile: string
}

/** The API the preload script exposes on `window.arh`. */
export interface ArhApi {
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  devices: {
    list(): Promise<Device[]>
    refresh(): Promise<Device[]>
    addManual(host: string, label?: string): Promise<Device>
    remove(id: string): Promise<void>
    onChanged(cb: (devices: Device[]) => void): () => void
  }
  probe: {
    host(host: string): Promise<ProbeResult>
  }
  session: {
    start(req: SessionRequest): Promise<{ sessionId: string }>
    abort(sessionId: string): Promise<void>
    get(sessionId: string): Promise<SessionSummary | null>
    onOutput(cb: (e: OutputEvent) => void): () => void
    onDone(cb: (e: SessionDoneEvent) => void): () => void
  }
  vault: {
    check(): Promise<VaultCheckResult>
    append(sessionId: string): Promise<VaultWriteResult>
    open(): Promise<void>
  }
  app: {
    info(): Promise<AppInfo>
  }
}
