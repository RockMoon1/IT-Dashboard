import type {
  ActionDef,
  ActionEvent,
  ActionOffer,
  ActionRecord,
  ActionRequest,
  ExecRequest
} from './actions.ts'
import type {
  AppInfo,
  ComputerProfile,
  ComputerSummary,
  LookupResult,
  LookupTarget,
  NoteView,
  DeviceView,
  EnrollmentView,
  LinkStatus,
  OpenLoopsView,
  ProfileSummary,
  Purpose,
  ScanEvent,
  ScanHistoryEntry,
  ScanRun,
  SearchHit,
  Settings,
  VaultApplyResult,
  VaultPreview,
  VaultStatus,
  WorkLogView
} from './types.ts'

/** IPC channel names. Single source of truth for main, preload and renderer. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appInfo: 'app:info',
  devicesList: 'devices:list',
  devicesChanged: 'devices:changed',
  devicesRemove: 'devices:remove',
  devicesRename: 'devices:rename',
  linkStatus: 'link:status',
  linkChanged: 'link:changed',
  linkEnableFirewall: 'link:enable-firewall',
  linkRefresh: 'link:refresh',
  enrollNew: 'enroll:new',
  enrollCancel: 'enroll:cancel',
  enrollList: 'enroll:list',
  scanStart: 'scan:start',
  scanAbort: 'scan:abort',
  scanGet: 'scan:get',
  scanList: 'scan:list',
  scanHistory: 'scan:history',
  scanEvent: 'scan:event',
  profilesList: 'profiles:list',
  vaultStatus: 'vault:status',
  vaultPreview: 'vault:preview',
  vaultApply: 'vault:apply',
  vaultOpenLoops: 'vault:open-loops',
  vaultWorkLog: 'vault:work-log',
  vaultSearch: 'vault:search',
  vaultOpen: 'vault:open',
  vaultOpenNote: 'vault:open-note',
  vaultReadNote: 'vault:read-note',
  lookupSearch: 'lookup:search',
  lookupList: 'lookup:list',
  lookupProfile: 'lookup:profile',
  actionsCatalog: 'actions:catalog',
  actionsOffers: 'actions:offers',
  actionsPreview: 'actions:preview',
  actionsRun: 'actions:run',
  actionsExec: 'actions:exec',
  actionsAbort: 'actions:abort',
  actionsList: 'actions:list',
  actionsEvent: 'actions:event',
  log: 'app:log'
} as const

export interface LogLine {
  at: string
  source: string
  text: string
}

/** The API the preload script exposes on `window.arh`. */
export interface ArhApi {
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  app: {
    info(): Promise<AppInfo>
    onLog(cb: (line: LogLine) => void): () => void
  }
  devices: {
    list(): Promise<DeviceView[]>
    remove(id: string): Promise<void>
    rename(id: string, displayName: string): Promise<void>
    onChanged(cb: (devices: DeviceView[]) => void): () => void
  }
  link: {
    status(): Promise<LinkStatus>
    refresh(): Promise<LinkStatus>
    enableFirewall(): Promise<{ started: boolean; message: string }>
    onChanged(cb: (status: LinkStatus) => void): () => void
  }
  enroll: {
    create(label?: string): Promise<EnrollmentView>
    cancel(token: string): Promise<void>
    list(): Promise<EnrollmentView[]>
  }
  scan: {
    start(deviceId: string, purpose: Purpose): Promise<ScanRun>
    abort(runId: string): Promise<boolean>
    get(runId: string): Promise<ScanRun | null>
    list(): Promise<ScanRun[]>
    history(deviceId?: string): Promise<ScanHistoryEntry[]>
    onEvent(cb: (e: ScanEvent) => void): () => void
  }
  profiles: {
    list(): Promise<ProfileSummary[]>
  }
  vault: {
    status(): Promise<VaultStatus>
    preview(runId: string | null): Promise<VaultPreview>
    apply(runId: string | null): Promise<VaultApplyResult[]>
    openLoops(): Promise<OpenLoopsView>
    workLog(limit?: number): Promise<WorkLogView>
    search(query: string): Promise<SearchHit[]>
    open(): Promise<void>
    /** Opens one note (path relative to the vault) in Obsidian. */
    openNote(file: string): Promise<void>
    /** Reads one note for the dashboard's own viewer (read only). */
    readNote(file: string): Promise<NoteView>
  }
  lookup: {
    search(query: string): Promise<LookupResult>
    list(): Promise<ComputerSummary[]>
    profile(target: LookupTarget): Promise<ComputerProfile>
  }
  actions: {
    /** Every shipped action, for Settings. */
    catalog(): Promise<ActionDef[]>
    /** The actions a connected device offers, with what stands in the way of each. */
    offers(deviceId: string): Promise<ActionOffer[]>
    /** Measures only; nothing on the device changes. */
    preview(req: ActionRequest): Promise<ActionRecord>
    /** A real run, confirmed from a preview (previewOf) while "preview first" is on. */
    run(
      req: ActionRequest,
      confirm: { previewOf?: string; confirmName?: string }
    ): Promise<ActionRecord>
    exec(req: ExecRequest): Promise<ActionRecord>
    abort(runId: string): Promise<boolean>
    list(limit?: number): Promise<ActionRecord[]>
    onEvent(cb: (e: ActionEvent) => void): () => void
  }
}
