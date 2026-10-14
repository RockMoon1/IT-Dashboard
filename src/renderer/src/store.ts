import { computed, reactive } from 'vue'
import type { AppInfo } from '@shared/api'
import type {
  Credentials,
  Device,
  OutputEvent,
  ProbeResult,
  Protocol,
  Purpose,
  SessionDoneEvent,
  SessionRequest,
  SessionSummary,
  Settings,
  TargetOS,
  VaultCheckResult,
  VaultWriteResult
} from '@shared/types'

export interface LogLine {
  id: number
  stream: OutputEvent['stream']
  text: string
  at: string
  commandId?: string
}

interface DashboardState {
  ready: boolean
  bridgeMissing: boolean
  devices: Device[]
  selectedId: string | null
  purpose: Purpose
  purposeModalOpen: boolean
  protocol: Protocol
  host: string
  targetOs: TargetOS
  credentials: Credentials
  authorizationConfirmed: boolean
  customCommands: string
  notes: string
  probe: ProbeResult | null
  probing: boolean
  running: boolean
  sessionId: string | null
  lines: LogLine[]
  summary: SessionSummary | null
  vault: VaultWriteResult | null
  vaultError: string | null
  vaultCheck: VaultCheckResult | null
  settings: Settings | null
  settingsOpen: boolean
  appInfo: AppInfo | null
  error: string | null
  manualHost: string
  manualLabel: string
  addingManual: boolean
}

const MAX_LINES = 4000
let lineId = 0

const state = reactive<DashboardState>({
  ready: false,
  bridgeMissing: false,
  devices: [],
  selectedId: null,
  purpose: 'system-diagnostics',
  purposeModalOpen: false,
  protocol: 'winrm',
  host: '',
  targetOs: 'unknown',
  credentials: {
    username: '',
    password: '',
    privateKeyPath: '',
    port: undefined,
    useSsl: false,
    skipCertCheck: false
  },
  authorizationConfirmed: false,
  customCommands: '',
  notes: '',
  probe: null,
  probing: false,
  running: false,
  sessionId: null,
  lines: [],
  summary: null,
  vault: null,
  vaultError: null,
  vaultCheck: null,
  settings: null,
  settingsOpen: false,
  appInfo: null,
  error: null,
  manualHost: '',
  manualLabel: '',
  addingManual: false
})

const selectedDevice = computed(() => state.devices.find((d) => d.id === state.selectedId) ?? null)

function api(): Window['arh'] {
  return window.arh
}

function fail(err: unknown): void {
  state.error = err instanceof Error ? err.message : String(err)
}

function pushLine(stream: LogLine['stream'], text: string, at: string, commandId?: string): void {
  state.lines.push({ id: ++lineId, stream, text, at, commandId })
  if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES)
}

let unsubscribers: Array<() => void> = []

async function init(): Promise<void> {
  if (typeof window.arh === 'undefined') {
    state.bridgeMissing = true
    state.ready = true
    return
  }
  try {
    const [settings, devices, info] = await Promise.all([
      api().settings.get(),
      api().devices.list(),
      api().app.info()
    ])
    state.settings = settings
    state.devices = devices
    state.appInfo = info
    if (settings.defaultUsername && !state.credentials.username)
      state.credentials.username = settings.defaultUsername
    unsubscribers.forEach((u) => u())
    unsubscribers = [
      api().devices.onChanged((list) => {
        state.devices = list
      }),
      api().session.onOutput((e) => {
        if (e.sessionId !== state.sessionId) return
        pushLine(e.stream, e.text, e.at, e.commandId)
      }),
      api().session.onDone((e: SessionDoneEvent) => {
        if (e.summary.sessionId !== state.sessionId) return
        state.summary = e.summary
        state.vault = e.vault ?? null
        state.vaultError = e.vaultError ?? null
        state.running = false
      })
    ]
    await checkVault()
  } catch (err) {
    fail(err)
  } finally {
    state.ready = true
  }
}

async function checkVault(): Promise<void> {
  try {
    state.vaultCheck = await api().vault.check()
  } catch (err) {
    fail(err)
  }
}

function applyDeviceDefaults(device: Device): void {
  state.host = device.host ?? ''
  state.targetOs = device.os
  state.probe = null
  if (device.kind === 'local') state.protocol = 'local'
  else if (device.protocols.includes('winrm')) state.protocol = 'winrm'
  else if (device.protocols.includes('ssh')) state.protocol = 'ssh'
  else
    state.protocol = device.os === 'windows' ? 'winrm' : device.os === 'unknown' ? 'winrm' : 'ssh'
  if (state.protocol === 'ssh' && !state.credentials.port) state.credentials.port = 22
  if (state.protocol === 'winrm' && state.credentials.port === 22)
    state.credentials.port = undefined
}

function selectDevice(id: string): void {
  if (state.running) return
  const device = state.devices.find((d) => d.id === id)
  if (!device) return
  if (state.selectedId !== id) {
    state.selectedId = id
    state.summary = null
    state.vault = null
    state.vaultError = null
    state.lines = []
    state.authorizationConfirmed = false
    applyDeviceDefaults(device)
  }
}

/** Double-click flow from the Phase 1 design: pick the device, then ask for the main purpose. */
function openPurposePrompt(id: string): void {
  selectDevice(id)
  if (state.selectedId === id) state.purposeModalOpen = true
}

function choosePurpose(purpose: Purpose): void {
  state.purpose = purpose
  state.purposeModalOpen = false
}

function setProtocol(protocol: Protocol): void {
  state.protocol = protocol
  if (
    protocol === 'ssh' &&
    (!state.credentials.port || state.credentials.port === 5985 || state.credentials.port === 5986)
  ) {
    state.credentials.port = 22
  }
  if (protocol === 'winrm' && state.credentials.port === 22) state.credentials.port = undefined
  if (protocol === 'winrm') state.targetOs = 'windows'
}

async function runProbe(): Promise<void> {
  const host = state.host.trim()
  if (!host) return
  state.probing = true
  state.error = null
  try {
    const probe = await api().probe.host(host)
    state.probe = probe
    if (probe.os !== 'unknown') state.targetOs = probe.os
    if (probe.suggestedProtocol) setProtocol(probe.suggestedProtocol)
  } catch (err) {
    fail(err)
  } finally {
    state.probing = false
  }
}

function buildRequest(): SessionRequest | null {
  const device = selectedDevice.value
  if (!device) return null
  const c = state.credentials
  const credentials: Credentials = {
    username: c.username?.trim() || undefined,
    password: c.password || undefined,
    privateKeyPath: c.privateKeyPath?.trim() || undefined,
    passphrase: c.passphrase || undefined,
    port: c.port ? Number(c.port) : undefined,
    useSsl: c.useSsl,
    skipCertCheck: c.skipCertCheck
  }
  return {
    deviceId: device.id,
    purpose: state.purpose,
    protocol: state.protocol,
    host: state.protocol === 'local' ? undefined : state.host.trim() || device.host,
    targetOs: state.protocol === 'local' ? undefined : state.targetOs,
    credentials: state.protocol === 'local' ? undefined : credentials,
    customCommands: state.purpose === 'other' ? state.customCommands.split(/\r?\n/) : undefined,
    notes: state.notes.trim() || undefined,
    authorizationConfirmed: state.authorizationConfirmed
  }
}

async function startSession(): Promise<void> {
  const req = buildRequest()
  if (!req || state.running) return
  state.error = null
  state.summary = null
  state.vault = null
  state.vaultError = null
  state.lines = []
  state.running = true
  try {
    const { sessionId } = await api().session.start(req)
    state.sessionId = sessionId
  } catch (err) {
    state.running = false
    fail(err)
  }
}

async function abortSession(): Promise<void> {
  if (!state.sessionId) return
  try {
    await api().session.abort(state.sessionId)
  } catch (err) {
    fail(err)
  }
}

async function appendToVault(): Promise<void> {
  if (!state.sessionId || !state.summary) return
  state.vaultError = null
  try {
    state.vault = await api().vault.append(state.sessionId)
    await checkVault()
  } catch (err) {
    state.vaultError = err instanceof Error ? err.message : String(err)
  }
}

async function refreshDevices(): Promise<void> {
  try {
    state.devices = await api().devices.refresh()
  } catch (err) {
    fail(err)
  }
}

async function addManualDevice(): Promise<void> {
  const host = state.manualHost.trim()
  if (!host) return
  state.addingManual = true
  try {
    const device = await api().devices.addManual(host, state.manualLabel.trim() || undefined)
    state.manualHost = ''
    state.manualLabel = ''
    selectDevice(device.id)
  } catch (err) {
    fail(err)
  } finally {
    state.addingManual = false
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

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  try {
    state.settings = await api().settings.set(patch)
    await checkVault()
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

function clearError(): void {
  state.error = null
}

export function useDashboard() {
  return {
    state,
    selectedDevice,
    init,
    checkVault,
    selectDevice,
    openPurposePrompt,
    choosePurpose,
    setProtocol,
    runProbe,
    startSession,
    abortSession,
    appendToVault,
    refreshDevices,
    addManualDevice,
    removeDevice,
    saveSettings,
    openVault,
    clearError
  }
}
