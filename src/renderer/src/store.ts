import { computed, reactive } from 'vue'
import type { LogLine } from '@shared/api'
import type {
  AppInfo,
  ComputerProfile,
  ComputerSummary,
  LookupResult,
  LookupTarget,
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
} from '@shared/types'

export type Tab =
  | 'computer'
  | 'scan'
  | 'results'
  | 'health'
  | 'loops'
  | 'worklog'
  | 'search'
  | 'link'

export interface ConsoleLine {
  id: number
  at: string
  checkId?: string
  stream: 'stdout' | 'stderr' | 'status'
  text: string
}

interface DashboardState {
  ready: boolean
  bridgeMissing: boolean
  error: string | null
  tab: Tab
  appInfo: AppInfo | null
  settings: Settings | null
  settingsOpen: boolean
  devices: DeviceView[]
  selectedId: string | null
  purposeModalOpen: boolean
  purpose: Purpose
  link: LinkStatus | null
  enrollOpen: boolean
  enrollment: EnrollmentView | null
  enrollments: EnrollmentView[]
  enrollLabel: string
  runs: ScanRun[]
  currentRunId: string | null
  console: ConsoleLine[]
  history: ScanHistoryEntry[]
  profiles: ProfileSummary[]
  vault: VaultStatus | null
  preview: VaultPreview | null
  previewOpen: boolean
  applyResults: VaultApplyResult[] | null
  applying: boolean
  loops: OpenLoopsView | null
  workLog: WorkLogView | null
  searchQuery: string
  searchHits: SearchHit[]
  searching: boolean
  logLines: LogLine[]
  busy: string | null
  lookup: LookupResult | null
  computers: ComputerSummary[]
  profile: ComputerProfile | null
  profileTarget: LookupTarget | null
  profileLoading: boolean
  /** A past scan opened in Results/Health while another scan is running; null = currentRun. */
  viewRunId: string | null
}

const MAX_CONSOLE = 5000
let lineId = 0

const state = reactive<DashboardState>({
  ready: false,
  bridgeMissing: false,
  error: null,
  tab: 'computer',
  appInfo: null,
  settings: null,
  settingsOpen: false,
  devices: [],
  selectedId: null,
  purposeModalOpen: false,
  purpose: 'system-diagnostics',
  link: null,
  enrollOpen: false,
  enrollment: null,
  enrollments: [],
  enrollLabel: '',
  runs: [],
  currentRunId: null,
  console: [],
  history: [],
  profiles: [],
  vault: null,
  preview: null,
  previewOpen: false,
  applyResults: null,
  applying: false,
  loops: null,
  workLog: null,
  searchQuery: '',
  searchHits: [],
  searching: false,
  logLines: [],
  busy: null,
  lookup: null,
  computers: [],
  profile: null,
  profileTarget: null,
  profileLoading: false,
  viewRunId: null
})

const selectedDevice = computed(() => state.devices.find((d) => d.id === state.selectedId) ?? null)
const currentRun = computed(() => state.runs.find((r) => r.runId === state.currentRunId) ?? null)
const runningRun = computed(() => state.runs.find((r) => r.status === 'running') ?? null)
/** What Results and Health show: a past scan picked during a live one, else the current run. */
const viewedRun = computed(
  () =>
    (state.viewRunId ? state.runs.find((r) => r.runId === state.viewRunId) : undefined) ??
    currentRun.value
)

function api(): Window['arh'] {
  return window.arh
}

function fail(err: unknown): void {
  state.error = err instanceof Error ? err.message : String(err)
}

function pushConsole(stream: ConsoleLine['stream'], text: string, checkId?: string): void {
  state.console.push({ id: ++lineId, at: new Date().toISOString(), stream, text, checkId })
  if (state.console.length > MAX_CONSOLE)
    state.console.splice(0, state.console.length - MAX_CONSOLE)
}

function upsertRun(run: ScanRun): void {
  const idx = state.runs.findIndex((r) => r.runId === run.runId)
  if (idx >= 0) state.runs[idx] = run
  else state.runs.unshift(run)
}

function applyScanEvent(e: ScanEvent): void {
  switch (e.type) {
    case 'run-start':
      upsertRun(e.run)
      state.currentRunId = e.run.runId
      state.viewRunId = null
      state.console = []
      pushConsole(
        'status',
        `▶ ${e.run.title} (${e.run.profile} v${e.run.version}) on ${e.run.hostname} · ${e.run.checks.length} checks`
      )
      state.tab = 'scan'
      return
    case 'check-start': {
      const run = state.runs.find((r) => r.runId === e.runId)
      const check = run?.checks.find((c) => c.id === e.checkId)
      if (check) {
        check.status = 'running'
        pushConsole('status', `── ${check.title}`, e.checkId)
      }
      return
    }
    case 'check-output': {
      const run = state.runs.find((r) => r.runId === e.runId)
      const check = run?.checks.find((c) => c.id === e.checkId)
      if (check) {
        if (e.stream === 'stdout') check.stdout += e.data
        else check.stderr += e.data
      }
      pushConsole(e.stream, e.data, e.checkId)
      return
    }
    case 'check-end': {
      const run = state.runs.find((r) => r.runId === e.runId)
      if (run) {
        const idx = run.checks.findIndex((c) => c.id === e.check.id)
        if (idx >= 0) run.checks[idx] = e.check
      }
      const mark = e.check.status === 'ok' ? '✓' : e.check.status === 'timeout' ? '⏱' : '✗'
      pushConsole(
        'status',
        `${mark} ${e.check.title} · exit ${e.check.exitCode ?? 'n/a'} · ${(e.check.durationMs / 1000).toFixed(1)} s${e.check.truncated ? ' · output truncated' : ''}`,
        e.check.id
      )
      return
    }
    case 'run-end':
      upsertRun(e.run)
      // Preview and Health follow the scan that just finished
      state.currentRunId = e.run.runId
      pushConsole(
        'status',
        `■ ${e.run.status.toUpperCase()} · ${e.run.health?.findings.length ?? 0} finding(s) · ${(e.run.durationMs / 1000).toFixed(0)} s${e.run.error ? ` · ${e.run.error}` : ''}`
      )
      void refreshHistory()
      if (state.profile?.summary.deviceId === e.run.deviceId) void refreshProfile()
      void loadComputers()
      return
  }
}

let unsubscribers: Array<() => void> = []

async function init(): Promise<void> {
  if (typeof window.arh === 'undefined') {
    state.bridgeMissing = true
    state.ready = true
    return
  }
  try {
    const [settings, devices, info, link, runs, profiles] = await Promise.all([
      api().settings.get(),
      api().devices.list(),
      api().app.info(),
      api().link.status(),
      api().scan.list(),
      api().profiles.list()
    ])
    state.settings = settings
    state.devices = devices
    state.appInfo = info
    state.link = link
    state.runs = runs
    state.profiles = profiles
    const running = runs.find((r) => r.status === 'running')
    state.currentRunId = running?.runId ?? runs[0]?.runId ?? null
    unsubscribers.forEach((u) => u())
    unsubscribers = [
      api().devices.onChanged((list) => {
        state.devices = list
      }),
      api().link.onChanged((status) => {
        state.link = status
      }),
      api().scan.onEvent(applyScanEvent),
      api().app.onLog((line) => {
        state.logLines.push(line)
        if (state.logLines.length > 300) state.logLines.shift()
      })
    ]
    await Promise.all([
      refreshVault(),
      refreshHistory(),
      refreshLoops(),
      refreshWorkLog(),
      loadComputers()
    ])
  } catch (err) {
    fail(err)
  } finally {
    state.ready = true
  }
}

async function refreshVault(): Promise<void> {
  try {
    state.vault = await api().vault.status()
  } catch (err) {
    fail(err)
  }
}

async function refreshHistory(): Promise<void> {
  try {
    state.history = await api().scan.history()
  } catch {
    /* non-fatal */
  }
}

async function refreshLoops(): Promise<void> {
  try {
    state.loops = await api().vault.openLoops()
  } catch (err) {
    fail(err)
  }
}

async function refreshWorkLog(): Promise<void> {
  try {
    state.workLog = await api().vault.workLog(40)
  } catch (err) {
    fail(err)
  }
}

function selectDevice(id: string): void {
  state.selectedId = id
  const d = state.devices.find((x) => x.id === id)
  if (d?.lastScan && !runningRun.value)
    state.currentRunId = state.runs.find((r) => r.deviceId === id)?.runId ?? state.currentRunId
  // a click shows everything on record for the computer, unless it would hide a live scan
  if (d?.kind === 'enrolled' && !(runningRun.value && state.tab === 'scan'))
    void openProfile({ deviceId: id })
}

/** Double-click flow: pick the device, then choose the purpose; nothing runs until confirmed. */
function openPurposePrompt(id: string): void {
  selectDevice(id)
  const d = selectedDevice.value
  if (!d || d.kind !== 'enrolled') return
  state.purpose = d.suggestedPurpose ?? 'system-diagnostics'
  state.purposeModalOpen = true
}

async function confirmPurpose(purpose: Purpose): Promise<void> {
  const d = selectedDevice.value
  state.purposeModalOpen = false
  if (!d) return
  state.error = null
  try {
    const run = await api().scan.start(d.id, purpose)
    upsertRun(run)
    state.currentRunId = run.runId
    state.tab = 'scan'
  } catch (err) {
    fail(err)
  }
}

async function abortCurrent(): Promise<void> {
  const run = runningRun.value
  if (!run) return
  try {
    await api().scan.abort(run.runId)
  } catch (err) {
    fail(err)
  }
}

function showRun(runId: string): void {
  state.currentRunId = runId
  state.viewRunId = null
  const run = state.runs.find((r) => r.runId === runId)
  if (run) {
    state.console = []
    for (const c of run.checks) {
      pushConsole('status', `── ${c.title}`, c.id)
      if (c.stdout) pushConsole('stdout', c.stdout, c.id)
      if (c.stderr) pushConsole('stderr', c.stderr, c.id)
    }
  }
}

async function openEnroll(): Promise<void> {
  state.enrollOpen = true
  state.enrollment = null
  try {
    state.enrollments = await api().enroll.list()
  } catch (err) {
    fail(err)
  }
}

async function createEnrollment(): Promise<void> {
  state.error = null
  try {
    state.enrollment = await api().enroll.create(state.enrollLabel.trim() || undefined)
    state.enrollments = await api().enroll.list()
  } catch (err) {
    fail(err)
  }
}

async function cancelEnrollment(token: string): Promise<void> {
  try {
    await api().enroll.cancel(token)
    state.enrollments = await api().enroll.list()
    if (state.enrollment?.token === token) state.enrollment = null
  } catch (err) {
    fail(err)
  }
}

async function refreshLink(): Promise<void> {
  state.busy = 'Refreshing link…'
  try {
    state.link = await api().link.refresh()
    state.devices = await api().devices.list()
  } catch (err) {
    fail(err)
  } finally {
    state.busy = null
  }
}

async function enableFirewall(): Promise<string> {
  state.busy = 'Waiting for the elevation prompt…'
  try {
    const r = await api().link.enableFirewall()
    state.link = await api().link.status()
    return r.message
  } catch (err) {
    fail(err)
    return String(err)
  } finally {
    state.busy = null
  }
}

async function openPreview(): Promise<void> {
  state.previewOpen = true
  state.preview = null
  state.applyResults = null
  try {
    state.preview = await api().vault.preview(state.currentRunId)
  } catch (err) {
    fail(err)
  }
}

async function applyPreview(): Promise<void> {
  state.applying = true
  try {
    state.applyResults = await api().vault.apply(state.currentRunId)
    await Promise.all([refreshVault(), refreshLoops(), refreshWorkLog()])
    state.preview = await api().vault.preview(state.currentRunId)
  } catch (err) {
    fail(err)
  } finally {
    state.applying = false
  }
}

async function runSearch(): Promise<void> {
  const q = state.searchQuery.trim()
  if (!q) {
    state.searchHits = []
    return
  }
  state.searching = true
  try {
    state.searchHits = await api().vault.search(q)
  } catch (err) {
    fail(err)
  } finally {
    state.searching = false
  }
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  try {
    state.settings = await api().settings.set(patch)
    await refreshVault()
    state.link = await api().link.status()
  } catch (err) {
    fail(err)
  }
}

async function removeDevice(id: string): Promise<void> {
  try {
    await api().devices.remove(id)
    if (state.selectedId === id) state.selectedId = null
  } catch (err) {
    fail(err)
  }
}

async function renameDevice(id: string, name: string): Promise<void> {
  try {
    await api().devices.rename(id, name)
  } catch (err) {
    fail(err)
  }
}

/* ---------- computer lookup ---------- */

let lookupSeq = 0
/** Runs a lookup; only the newest one is shown in the list, but every caller gets its answer. */
async function runLookup(query: string): Promise<LookupResult | null> {
  const seq = ++lookupSeq
  try {
    const result = await api().lookup.search(query)
    if (seq === lookupSeq) state.lookup = result
    return result
  } catch (err) {
    fail(err)
    return null
  }
}

async function loadComputers(): Promise<void> {
  try {
    state.computers = await api().lookup.list()
  } catch (err) {
    fail(err)
  }
}

let profileSeq = 0

/** Loads a computer page without changing tabs. Only the latest request may land. */
async function loadProfile(target: LookupTarget): Promise<void> {
  const seq = ++profileSeq
  state.profileTarget = target
  state.profileLoading = true
  try {
    const profile = await api().lookup.profile(target)
    if (seq === profileSeq) state.profile = profile
  } catch (err) {
    if (seq === profileSeq) fail(err)
  } finally {
    if (seq === profileSeq) state.profileLoading = false
  }
}

/** Opens the computer view; nothing has to be connected, it reads stored scans and the vault. */
async function openProfile(target: LookupTarget): Promise<void> {
  state.tab = 'computer'
  await loadProfile(target)
}

/** Background refresh (after a scan, or the page's Refresh button): stays on the current tab. */
async function refreshProfile(): Promise<void> {
  if (state.profileTarget) await loadProfile(state.profileTarget)
}

function closeProfile(): void {
  profileSeq++ // a page still loading must not reappear
  state.profile = null
  state.profileTarget = null
  state.profileLoading = false
  void loadComputers()
}

async function openNote(file: string): Promise<void> {
  try {
    await api().vault.openNote(file)
  } catch (err) {
    fail(err)
  }
}

/**
 * Shows any stored scan in the Results tab, fetching it if it is older than the recent list.
 * While a scan is running it is shown beside it (viewRunId): the live console, the current run
 * and the Preview of the scan in progress are left alone.
 */
async function openRunById(runId: string): Promise<void> {
  try {
    if (!state.runs.some((r) => r.runId === runId)) {
      const run = await api().scan.get(runId)
      if (!run) throw new Error(`scan ${runId} is no longer stored`)
      state.runs.push(run)
    }
    if (runningRun.value && runningRun.value.runId !== runId) state.viewRunId = runId
    else showRun(runId)
    state.tab = 'results'
  } catch (err) {
    fail(err)
  }
}

async function openVault(): Promise<void> {
  try {
    await api().vault.open()
  } catch (err) {
    fail(err)
  }
}

export function useDashboard() {
  return {
    state,
    selectedDevice,
    currentRun,
    runningRun,
    viewedRun,
    init,
    refreshVault,
    refreshHistory,
    refreshLoops,
    refreshWorkLog,
    selectDevice,
    openPurposePrompt,
    confirmPurpose,
    abortCurrent,
    showRun,
    openEnroll,
    createEnrollment,
    cancelEnrollment,
    refreshLink,
    enableFirewall,
    openPreview,
    applyPreview,
    runSearch,
    saveSettings,
    removeDevice,
    renameDevice,
    openVault,
    runLookup,
    loadComputers,
    openProfile,
    refreshProfile,
    closeProfile,
    openNote,
    openRunById,
    clearError: () => {
      state.error = null
    }
  }
}
