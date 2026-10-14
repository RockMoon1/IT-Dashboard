import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { hostname } from 'node:os'
import { IPC, type AppInfo } from '../shared/api.ts'
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
} from '../shared/types.ts'
import { DeviceRegistry, makeLocalDevice, makeManualDevice } from './services/devices/registry.ts'
import {
  NET_NEIGHBOR_SCRIPT,
  NetworkDiscovery,
  parseNeighborJson,
  reverseLookup
} from './services/devices/network.ts'
import { probeHost } from './services/devices/probe.ts'
import {
  USB_ENUM_SCRIPT,
  USB_EVENT_SCRIPT,
  UsbWatcher,
  parsePnpJson
} from './services/devices/usb.ts'
import {
  powerShellArgs,
  resolvePowerShellExe,
  runPowerShell,
  runProcess,
  spawnPowerShell
} from './services/remoting/powershell.ts'
import { newSessionId, runSession } from './services/remoting/session.ts'
import { SshSession } from './services/remoting/ssh.ts'
import type { RemoteExecutor } from './services/remoting/types.ts'
import { createWinRmExecutor } from './services/remoting/winrm.ts'
import { loadSettings, mergeSettings, saveSettings } from './services/settings.ts'
import { checkVault, writeSessionToVault } from './services/vault/obsidian.ts'

interface SessionState {
  abort: AbortController
  summary?: SessionSummary
}

const isWindows = process.platform === 'win32'
const nowIso = (): string => new Date().toISOString()

/** Owns long-lived state for the main process: settings, device sources, sessions. */
export class AppContext {
  readonly settingsFile: string
  settings: Settings
  readonly registry = new DeviceRegistry()
  private window: BrowserWindow | null = null
  private usb: UsbWatcher | null = null
  private network: NetworkDiscovery | null = null
  private sessions = new Map<string, SessionState>()

  private constructor(settingsFile: string, settings: Settings) {
    this.settingsFile = settingsFile
    this.settings = settings
  }

  static async create(settingsFile: string): Promise<AppContext> {
    return new AppContext(settingsFile, await loadSettings(settingsFile))
  }

  attachWindow(win: BrowserWindow): void {
    this.window = win
    win.on('closed', () => {
      if (this.window === win) this.window = null
    })
  }

  private send(channel: string, payload: unknown): void {
    const win = this.window
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  start(): void {
    this.registry.upsert(makeLocalDevice(hostname(), process.platform, nowIso()))
    this.registry.onChange((devices) => this.send(IPC.devicesChanged, devices))

    this.usb = new UsbWatcher({
      pollMs: this.settings.usbPollMs,
      enumerate: async () => {
        if (!isWindows) return []
        const r = await runPowerShell(USB_ENUM_SCRIPT, { timeoutMs: 45_000 })
        if (!r.stdout.trim() && r.exitCode !== 0)
          throw new Error(r.stderr.trim() || 'USB enumeration failed')
        return parsePnpJson(r.stdout)
      },
      watchEvents: isWindows
        ? (onChange, onExit) => {
            const child = spawnPowerShell(USB_EVENT_SCRIPT)
            let buffer = ''
            child.stdout?.setEncoding('utf8')
            child.stdout?.on('data', (chunk: string) => {
              buffer += chunk
              const lines = buffer.split(/\r?\n/)
              buffer = lines.pop() ?? ''
              if (lines.some((l) => l.includes('"change"'))) onChange()
            })
            child.on('error', (err) => onExit(err))
            child.on('exit', (code) =>
              onExit(code ? new Error(`USB event listener exited with code ${code}`) : undefined)
            )
            return () => {
              try {
                child.kill()
              } catch {
                /* already gone */
              }
            }
          }
        : undefined,
      onDevices: (devices) => this.registry.replaceKind('usb', devices),
      onError: (err) => console.error('[usb]', err.message)
    })
    this.usb.start()

    if (this.settings.networkDiscovery) this.startNetwork()
  }

  private startNetwork(): void {
    this.network?.stop()
    this.network = new NetworkDiscovery({
      refreshMs: this.settings.networkRefreshMs,
      enumerate: async () => {
        if (!isWindows) return { hostname: hostname(), local: [], neighbors: [] }
        const r = await runPowerShell(NET_NEIGHBOR_SCRIPT, { timeoutMs: 45_000 })
        return parseNeighborJson(r.stdout)
      },
      resolveName: (ip) => reverseLookup(ip),
      probe: (host) => probeHost(host, { timeoutMs: 1500 }),
      onDevices: (devices) => this.registry.replaceKind('network', devices),
      onError: (err) => console.error('[network]', err.message)
    })
    this.network.start()
  }

  stop(): void {
    this.usb?.stop()
    this.network?.stop()
    for (const s of this.sessions.values()) s.abort.abort()
  }

  private async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const before = this.settings
    this.settings = mergeSettings(this.settings, patch)
    await saveSettings(this.settingsFile, this.settings)
    if (
      before.networkDiscovery !== this.settings.networkDiscovery ||
      before.networkRefreshMs !== this.settings.networkRefreshMs
    ) {
      if (this.settings.networkDiscovery) this.startNetwork()
      else {
        this.network?.stop()
        this.network = null
        this.registry.replaceKind('network', [])
      }
    }
    return this.settings
  }

  private localExecutor(): RemoteExecutor {
    return {
      exec: (script, opts = {}) => {
        if (opts.shell === 'sh' || (!isWindows && opts.shell !== 'powershell')) {
          return runProcess('/bin/sh', ['-s'], { ...opts, stdin: `${script}\n` })
        }
        return runProcess(resolvePowerShellExe(), powerShellArgs(script), opts)
      },
      close: () => undefined
    }
  }

  private async startSession(req: SessionRequest): Promise<{ sessionId: string }> {
    const host = req.host?.trim()
    const device: Device | undefined =
      this.registry.get(req.deviceId) ??
      (host ? makeManualDevice(host, host, undefined, nowIso()) : undefined)
    if (!device) throw new Error(`Unknown device ${req.deviceId}`)

    const sessionId = newSessionId()
    const state: SessionState = { abort: new AbortController() }
    this.sessions.set(sessionId, state)

    void (async () => {
      const summary = await runSession(
        req,
        device,
        {
          local: () => this.localExecutor(),
          winrm: (target) => createWinRmExecutor(target),
          ssh: (target, opts) => SshSession.connect(target, opts),
          knownHosts: this.settings.knownHosts,
          strictHostKeys: this.settings.strictHostKeys,
          onHostKeyRecorded: (id, fp) => {
            void this.updateSettings({ knownHosts: { ...this.settings.knownHosts, [id]: fp } })
          },
          newId: () => sessionId
        },
        (e: OutputEvent) => this.send(IPC.sessionOutput, e),
        state.abort.signal
      )
      state.summary = summary
      const done: SessionDoneEvent = { summary }
      if (this.settings.autoLog) {
        try {
          done.vault = await writeSessionToVault(this.settings, summary)
        } catch (err) {
          done.vaultError = (err as Error).message
        }
      }
      this.send(IPC.sessionDone, done)
    })()

    return { sessionId }
  }

  registerIpc(): void {
    ipcMain.handle(IPC.settingsGet, (): Settings => this.settings)
    ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => this.updateSettings(patch))

    ipcMain.handle(IPC.devicesList, (): Device[] => this.registry.list())
    ipcMain.handle(IPC.devicesRefresh, async (): Promise<Device[]> => {
      await Promise.all([this.usb?.refresh(), this.network?.refresh()])
      return this.registry.list()
    })
    ipcMain.handle(
      IPC.devicesAddManual,
      async (_e, host: string, label?: string): Promise<Device> => {
        const h = host.trim()
        if (!h) throw new Error('Host is required')
        const probe = await probeHost(h, { timeoutMs: 2000 }).catch(() => undefined)
        return this.registry.upsert(makeManualDevice(h, label, probe, nowIso()))
      }
    )
    ipcMain.handle(IPC.devicesRemove, (_e, id: string) => {
      const d = this.registry.get(id)
      if (d && d.kind !== 'local') this.registry.remove(id)
    })

    ipcMain.handle(
      IPC.probeHost,
      (_e, host: string): Promise<ProbeResult> => probeHost(host.trim(), { timeoutMs: 2500 })
    )

    ipcMain.handle(IPC.sessionStart, (_e, req: SessionRequest) => this.startSession(req))
    ipcMain.handle(IPC.sessionAbort, (_e, sessionId: string) => {
      this.sessions.get(sessionId)?.abort.abort()
    })
    ipcMain.handle(
      IPC.sessionGet,
      (_e, sessionId: string): SessionSummary | null =>
        this.sessions.get(sessionId)?.summary ?? null
    )

    ipcMain.handle(IPC.vaultCheck, (): Promise<VaultCheckResult> => checkVault(this.settings))
    ipcMain.handle(IPC.vaultAppend, (_e, sessionId: string): Promise<VaultWriteResult> => {
      const summary = this.sessions.get(sessionId)?.summary
      if (!summary) throw new Error('Session has not finished or does not exist')
      return writeSessionToVault(this.settings, summary)
    })
    ipcMain.handle(IPC.vaultOpen, async () => {
      const result = await shell.openPath(this.settings.vaultPath)
      if (result) throw new Error(result)
    })

    ipcMain.handle(
      IPC.appInfo,
      (): AppInfo => ({
        version: app.getVersion(),
        platform: process.platform,
        powerShell: resolvePowerShellExe(),
        settingsFile: this.settingsFile
      })
    )
  }
}
