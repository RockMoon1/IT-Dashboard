import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { IPC, type LogLine } from '../shared/api.ts'
import type {
  AppInfo,
  ComputerProfile,
  ComputerSummary,
  DeviceView,
  EnrollmentView,
  LinkStatus,
  LookupResult,
  LookupTarget,
  NoteView,
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
} from '../shared/types.ts'
import {
  ADAPTERS_SCRIPT,
  beaconInterfaces,
  LinkWatcher,
  NET_EVENTS_SCRIPT,
  parseAdaptersJson,
  type NetAdapter
} from './services/detection/adapters.ts'
import {
  USB_ENUM_SCRIPT,
  USB_EVENT_SCRIPT,
  UsbWatcher,
  parsePnpJson,
  type UsbDevice
} from './services/devices/usb.ts'
import { Beaconer } from './services/link/beacon.ts'
import { DeviceStore, type EnrolledDevice } from './services/link/devices.ts'
import { LinkServer, type LinkEvent } from './services/link/server.ts'
import { TokenStore } from './services/link/tokens.ts'
import { runPowerShell, spawnPowerShell } from './services/remoting/powershell.ts'
import { ScanLog } from './services/scans/log.ts'
import { ProfileCatalog } from './services/scans/profiles.ts'
import { ScanRunner } from './services/scans/runner.ts'
import { RunStore } from './services/scans/runstore.ts'
import { CredentialManagerStore } from './services/secrets/credman.ts'
import { ensureHostIdentity, type HostIdentity } from './services/secrets/host-identity.ts'
import { SafeStorageStore } from './services/secrets/safestorage.ts'
import { MemoryStore, type SecretStore } from './services/secrets/store.ts'
import { loadSettings, mergeSettings, saveSettings } from './services/settings.ts'
import { BLOCK_KEYS } from './services/vault/content.ts'
import { findBlock } from './services/vault/markers.ts'
import { buildWritePlans, notePaths } from './services/vault/plans.ts'
import { parseDatedEntries, parseTasks, searchVault } from './services/vault/reader.ts'
import { VaultWriter } from './services/vault/writer.ts'
import { VaultIndex, type IndexedNote } from './services/lookup/vaultindex.ts'
import { noteView } from './services/lookup/notes.ts'
import {
  buildComputers,
  buildProfile,
  inventoryRows,
  lookup,
  noteRoles,
  rankComputers,
  summarize
} from './services/lookup/computers.ts'

const isWindows = process.platform === 'win32'
const nowIso = (): string => new Date().toISOString()
const FIREWALL_RULE = 'ARH IT Dashboard link'

export interface AppPaths {
  settingsFile: string
  appDataDir: string
  profilesDir: string
  agentBinary: string | null
  agentDistDir: string | null
}

/** Owns every long-lived piece of the main process and exposes it over IPC. */
export class AppContext {
  readonly paths: AppPaths
  settings: Settings
  private window: BrowserWindow | null = null
  private secrets: SecretStore = new MemoryStore()
  private identity: HostIdentity | null = null
  private hostId = ''
  private devices: DeviceStore
  private tokens = new TokenStore()
  private link: LinkServer | null = null
  private beaconer: Beaconer | null = null
  private linkWatcher: LinkWatcher | null = null
  private usb: UsbWatcher | null = null
  private adapters: NetAdapter[] = []
  private usbDevices: UsbDevice[] = []
  private catalog = new ProfileCatalog()
  private scanLog: ScanLog
  private runStore: RunStore
  private runner: ScanRunner
  private writer: VaultWriter
  private vaultIndex = new VaultIndex()
  private lastLinkError: string | undefined
  private firewallRulePresent: boolean | null = null
  private logLines: LogLine[] = []

  private constructor(paths: AppPaths, settings: Settings) {
    this.paths = paths
    this.settings = settings
    this.devices = new DeviceStore(join(paths.appDataDir, 'devices.json'))
    this.scanLog = new ScanLog(join(paths.appDataDir, 'scans.jsonl'))
    this.runStore = new RunStore(join(paths.appDataDir, 'runs'))
    this.writer = new VaultWriter({
      appDataDir: paths.appDataDir,
      live: settings.vaultLive && settings.schemaApproved
    })
    this.runner = new ScanRunner({
      catalog: this.catalog,
      log: this.scanLog,
      send: (deviceId, message) => this.link?.send(deviceId, message) ?? false,
      technician: () =>
        this.settings.technician || process.env['USERNAME'] || process.env['USER'] || 'technician'
    })
  }

  static async create(paths: AppPaths): Promise<AppContext> {
    return new AppContext(paths, await loadSettings(paths.settingsFile))
  }

  /* ---------- lifecycle ---------- */

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

  private log(source: string, text: string): void {
    const line: LogLine = { at: nowIso(), source, text }
    this.logLines.push(line)
    if (this.logLines.length > 500) this.logLines.shift()
    console.log(`[${source}] ${text}`)
    this.send(IPC.log, line)
  }

  async start(): Promise<void> {
    await this.devices.load()
    await this.runStore.load()
    try {
      await this.catalog.load(this.paths.profilesDir)
      this.log(
        'profiles',
        `${this.catalog.list().length} scan profiles loaded from ${this.paths.profilesDir}`
      )
    } catch (err) {
      this.log('profiles', `could not load profiles: ${(err as Error).message}`)
    }
    this.secrets = await this.pickSecretStore()
    this.log('secrets', this.secrets.describe())
    await this.startLink()
    this.startDetection()
    this.runner.onEvent((e) => this.onScanEvent(e))
  }

  async stop(): Promise<void> {
    this.usb?.stop()
    this.linkWatcher?.stop()
    this.beaconer?.stop()
    await this.link?.stop()
  }

  private async pickSecretStore(): Promise<SecretStore> {
    if (isWindows) {
      const store = new CredentialManagerStore()
      try {
        await store.get('probe')
        return store
      } catch (err) {
        this.log(
          'secrets',
          `Credential Manager unavailable (${(err as Error).message}); falling back to safeStorage`
        )
      }
    }
    if (SafeStorageStore.available())
      return new SafeStorageStore(join(this.paths.appDataDir, 'secrets.json'))
    this.log('secrets', 'no OS keystore available; host key will not persist across restarts')
    return new MemoryStore()
  }

  private async startLink(): Promise<void> {
    if (!this.paths.agentBinary) {
      this.lastLinkError =
        'agent binary not found: run "npm run agent:build" (or install the packaged app) to enable the link'
      this.log('link', this.lastLinkError)
      return
    }
    try {
      this.identity = await ensureHostIdentity({
        dataDir: this.paths.appDataDir,
        secrets: this.secrets,
        agentBinary: this.paths.agentBinary
      })
      this.hostId = await this.ensureHostId()
      const server = new LinkServer({
        certPem: this.identity.certPem,
        keyPem: this.identity.keyPem,
        hostFingerprint: this.identity.fingerprint,
        hostId: this.hostId,
        devices: this.devices,
        tokens: this.tokens,
        port: this.settings.linkPort,
        log: (l) => this.log('link', l)
      })
      server.onEvent((e) => this.onLinkEvent(e))
      const port = await server.start()
      this.link = server
      this.beaconer = new Beaconer({
        tlsPort: port,
        hostFingerprint: this.identity.fingerprint,
        hostId: this.hostId,
        log: (l) => this.log('beacon', l)
      })
      this.beaconer.start()
      this.lastLinkError = undefined
      this.log(
        'link',
        `listening on tcp/${port}; host fingerprint ${this.identity.fingerprint.slice(0, 16)}…`
      )
      void this.checkFirewallRule()
    } catch (err) {
      this.lastLinkError = (err as Error).message
      this.log('link', `link not started: ${this.lastLinkError}`)
    }
  }

  private async ensureHostId(): Promise<string> {
    const key = 'host-id'
    const existing = await this.secrets.get(key).catch(() => null)
    if (existing) return existing
    const id = randomUUID()
    await this.secrets.set(key, id).catch(() => undefined)
    return id
  }

  private startDetection(): void {
    this.linkWatcher = new LinkWatcher({
      pollMs: this.settings.adapterPollMs,
      enumerate: async () => {
        if (!isWindows) return []
        const r = await runPowerShell(ADAPTERS_SCRIPT, { timeoutMs: 45_000 })
        return parseAdaptersJson(r.stdout)
      },
      watchEvents: isWindows
        ? (onChange, onExit) => this.spawnEventListener(NET_EVENTS_SCRIPT, 'wmi', onChange, onExit)
        : undefined,
      onAdapters: (adapters) => {
        this.adapters = adapters
        const ifaces = beaconInterfaces(adapters, this.settings.beaconAllAdapters)
        void this.beaconer?.setInterfaces(ifaces)
        this.log(
          'detect',
          `${adapters.filter((a) => a.isLink).length} link adapter(s), beaconing on ${ifaces.length} address(es)`
        )
        this.pushLink()
        this.pushDevices()
      },
      onError: (err) => this.log('detect', err.message)
    })
    this.linkWatcher.start()

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
        ? (onChange, onExit) => this.spawnEventListener(USB_EVENT_SCRIPT, 'usb', onChange, onExit)
        : undefined,
      onDevices: (devices) => {
        this.usbDevices = devices
        this.pushDevices()
      },
      onError: (err) => this.log('usb', err.message)
    })
    this.usb.start()
  }

  private spawnEventListener(
    script: string,
    tag: string,
    onChange: () => void,
    onExit: (err?: Error) => void
  ): () => void {
    const child = spawnPowerShell(script)
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const l of lines) if (l.includes('"change"')) onChange()
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (t: string) => this.log(tag, t.trim()))
    child.on('error', (err) => onExit(err))
    child.on('exit', (code) =>
      onExit(code ? new Error(`${tag} event listener exited with code ${code}`) : undefined)
    )
    return () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }

  /* ---------- link and scan events ---------- */

  private onLinkEvent(e: LinkEvent): void {
    switch (e.type) {
      case 'connected':
      case 'enrolled':
        this.log('link', `${e.type}: ${e.device.displayName} (${e.device.os}) from ${e.address}`)
        this.pushDevices()
        return
      case 'disconnected':
        this.runner.deviceLost(e.deviceId)
        this.pushDevices()
        return
      case 'rejected':
        this.log('link', `rejected ${e.fingerprint.slice(0, 16)} from ${e.address}: ${e.reason}`)
        return
      case 'message':
        this.runner.handleMessage(e.deviceId, e.message)
        return
      case 'listening':
        this.pushLink()
        return
    }
  }

  private onScanEvent(e: ScanEvent): void {
    this.send(IPC.scanEvent, e)
    if (e.type === 'run-end') {
      void this.runStore
        .save(e.run)
        .catch((err) => this.log('scans', `could not persist run: ${(err as Error).message}`))
      this.pushDevices()
    }
  }

  /* ---------- views ---------- */

  private suggestPurpose(device: EnrolledDevice): { purpose: Purpose; reason: string } {
    const last = this.runStore.lastForDevice(device.id)
    if (!last) return { purpose: 'system-diagnostics', reason: 'no previous scan on record' }
    const critical = last.health?.findings.filter((f) => f.severity === 'critical').length ?? 0
    const when = (last.finishedAt ?? last.startedAt).slice(0, 10)
    if (critical > 0 && last.purpose !== 'security-check')
      return {
        purpose: 'security-check',
        reason: `${critical} critical finding(s) in the ${when} scan`
      }
    if (last.status !== 'ok')
      return { purpose: last.purpose, reason: `the ${when} scan ended ${last.status}; repeat it` }
    return {
      purpose: last.purpose,
      reason: `last scan on ${when} was ${last.purpose.replace(/-/g, ' ')}`
    }
  }

  deviceViews(): DeviceView[] {
    const out: DeviceView[] = []
    for (const d of this.devices.list()) {
      const connected = this.link?.isConnected(d.id) ?? false
      const address = this.link?.connected().find((c) => c.device.id === d.id)?.address
      const last = this.runStore.lastForDevice(d.id)
      const suggestion = this.suggestPurpose(d)
      out.push({
        id: d.id,
        kind: 'enrolled',
        displayName: d.displayName,
        os: d.os,
        present: connected,
        connected,
        hostname: d.hostname,
        serial: d.serial,
        address,
        lastSeen: d.lastSeen,
        enrolledAt: d.enrolledAt,
        agentVersion: d.agentVersion,
        profiles: d.profiles,
        lastScan: last
          ? {
              runId: last.runId,
              purpose: last.purpose,
              at: last.finishedAt ?? last.startedAt,
              status: last.status,
              score: last.health?.score
            }
          : undefined,
        suggestedPurpose: suggestion.purpose,
        suggestionReason: suggestion.reason
      })
    }
    const anyConnected = out.some((d) => d.connected)
    for (const a of this.adapters) {
      if (!a.isLink || a.status.toLowerCase() !== 'up' || anyConnected) continue
      out.push({
        id: `link:${a.name}`,
        kind: 'link-unknown',
        displayName: `Device on ${a.name}`,
        os: 'unknown',
        present: true,
        connected: false,
        adapterName: a.name,
        linkReason: a.linkReason,
        hint: 'A cable link is up but no enrolled agent has connected. Enroll the device, or wait for its agent to hear the beacon.'
      })
    }
    for (const u of this.usbDevices) {
      out.push({
        id: u.id,
        kind: 'usb',
        displayName: u.name,
        os: 'unknown',
        present: u.present,
        connected: false,
        serial: u.serial,
        deviceClass: u.deviceClass,
        manufacturer: u.manufacturer,
        status: u.status,
        vendorId: u.vendorId,
        productId: u.productId,
        lastSeen: u.lastSeen,
        hint: u.osHint
      })
    }
    return out
  }

  private pushDevices(): void {
    this.send(IPC.devicesChanged, this.deviceViews())
  }

  linkStatus(): LinkStatus {
    return {
      listening: this.link !== null,
      port: this.link?.port ?? this.settings.linkPort,
      hostFingerprint: this.identity?.fingerprint ?? '',
      hostId: this.hostId,
      beaconInterfaces:
        this.beaconer
          ?.interfaces()
          .map(
            (i) =>
              `${i.address}${i.scopeId != null ? `%${i.scopeId}` : ''}${i.name ? ` (${i.name})` : ''}`
          ) ?? [],
      adapters: this.adapters.map((a) => ({
        name: a.name,
        description: a.description,
        status: a.status,
        isLink: a.isLink,
        linkReason: a.linkReason,
        ipv4: a.ipv4.map((x) => `${x.address}/${x.prefixLength}`),
        ipv6LinkLocal: a.ipv6LinkLocal.map((x) => x.address),
        pnpDeviceId: a.pnpDeviceId,
        mac: a.mac
      })),
      beaconAllAdapters: this.settings.beaconAllAdapters,
      secretStore: this.secrets.describe(),
      agentBinary: this.paths.agentBinary,
      firewallRulePresent: this.firewallRulePresent,
      lastError: this.lastLinkError
    }
  }

  private pushLink(): void {
    this.send(IPC.linkChanged, this.linkStatus())
  }

  private async checkFirewallRule(): Promise<void> {
    if (!isWindows) {
      this.firewallRulePresent = null
      return
    }
    const r = await runPowerShell(
      `if (Get-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -ErrorAction SilentlyContinue) { 'True' } else { 'False' }`,
      { timeoutMs: 30_000 }
    )
    this.firewallRulePresent = r.stdout.trim().endsWith('True')
    this.pushLink()
  }

  private async enableFirewall(): Promise<{ started: boolean; message: string }> {
    if (!isWindows) return { started: false, message: 'firewall rules are only managed on Windows' }
    const port = this.link?.port ?? this.settings.linkPort
    const inner = `New-NetFirewallRule -DisplayName '${FIREWALL_RULE}' -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Any | Out-Null`
    const escaped = inner.replace(/'/g, "''")
    const r = await runPowerShell(
      `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', '${escaped}'`,
      { timeoutMs: 180_000 }
    )
    await this.checkFirewallRule()
    if (this.firewallRulePresent)
      return { started: true, message: `inbound rule "${FIREWALL_RULE}" (TCP ${port}) is present` }
    return {
      started: r.exitCode === 0,
      message:
        r.exitCode === 0
          ? 'the elevation prompt was dismissed or the rule was not created'
          : r.stderr.trim() || 'could not start the elevated PowerShell'
    }
  }

  private enrollmentView(t: { token: string; expiresAt: number; label?: string }): EnrollmentView {
    return {
      token: t.token,
      expiresAt: new Date(t.expiresAt).toISOString(),
      hostFingerprint: this.identity?.fingerprint ?? '',
      label: t.label,
      commands: {
        windows: `arh-agent-windows-amd64.exe install --token ${t.token}`,
        macos: `sudo ./arh-agent-darwin-arm64 install --token ${t.token}`,
        linux: `sudo ./arh-agent-linux-amd64 install --token ${t.token}`
      }
    }
  }

  /* ---------- vault ---------- */

  private async vaultStatus(): Promise<VaultStatus> {
    const paths = notePaths(this.settings)
    const problems: string[] = []
    const exists = existsSync(this.settings.vaultPath)
    if (!exists) problems.push(`vault folder not found: ${this.settings.vaultPath}`)
    const notes: VaultStatus['notes'] = []
    const roles: Array<[VaultStatus['notes'][number]['role'], string, string]> = [
      ['assets', this.settings.assetNote, paths.assets],
      ['openLoops', this.settings.openLoopsNote, paths.openLoops],
      ['workLog', this.settings.workLogNote, paths.workLog]
    ]
    if (paths.hub) roles.push(['hub', this.settings.hubNote, paths.hub])
    for (const [role, name, path] of roles) {
      const noteExists = existsSync(path)
      const markers: string[] = []
      if (noteExists) {
        try {
          const text = await (await import('node:fs/promises')).readFile(path, 'utf8')
          for (const key of Object.values(BLOCK_KEYS)) if (findBlock(text, key)) markers.push(key)
        } catch (err) {
          problems.push(`${name}: ${(err as Error).message}`)
        }
      } else if (exists)
        problems.push(`note not found: ${path} (the dashboard never creates notes)`)
      notes.push({
        role,
        name,
        path,
        exists: noteExists,
        markers,
        backupExists: existsSync(
          join(this.writer.backupDir(), `${basename(name).replace(/\.md$/i, '')}.first-write.md`)
        )
      })
    }
    const conflicts = exists ? await VaultWriter.scanConflicts(this.settings.vaultPath) : []
    if (conflicts.length)
      problems.push(
        `${conflicts.length} OneDrive conflict cop${conflicts.length === 1 ? 'y' : 'ies'} in the vault`
      )
    if (!this.settings.schemaApproved)
      problems.push('vault schema not approved yet: writes stay in dry-run')
    return {
      vaultPath: this.settings.vaultPath,
      exists,
      live: this.writer.live,
      schemaApproved: this.settings.schemaApproved,
      notes,
      conflicts,
      backupsDir: this.writer.backupDir(),
      problems
    }
  }

  private recentRuns(): ScanRun[] {
    const merged = new Map<string, ScanRun>()
    for (const r of this.runStore.list(20)) merged.set(r.runId, r)
    for (const r of this.runner.list()) if (r.status !== 'running') merged.set(r.runId, r)
    return [...merged.values()]
      .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt))
      .slice(0, 20)
  }

  /** Runs the vault blocks are built from: enough history that nothing is dropped in dry-run. */
  private planRuns(): ScanRun[] {
    const merged = new Map<string, ScanRun>()
    for (const r of this.runStore.list(500)) merged.set(r.runId, r)
    for (const r of this.runner.list()) if (r.status !== 'running') merged.set(r.runId, r)
    return [...merged.values()]
  }

  private async plans(): Promise<ReturnType<typeof buildWritePlans>> {
    return buildWritePlans({
      settings: this.settings,
      devices: this.devices.list(),
      runs: this.planRuns()
    })
  }

  private async vaultPreview(runId: string | null): Promise<VaultPreview> {
    const notes = await this.writer.preview(await this.plans())
    return { runId, generatedAt: nowIso(), live: this.writer.live, notes }
  }

  private async vaultApply(): Promise<VaultApplyResult[]> {
    const results = await this.writer.apply(await this.plans())
    for (const r of results)
      this.log(
        'vault',
        r.error
          ? `${r.notePath}: ${r.error}`
          : `${r.notePath}: ${r.written ? 'written' : 'unchanged'}${r.conflictCopies.length ? ` (${r.conflictCopies.length} conflict copies!)` : ''}`
      )
    return results
  }

  private async openLoops(): Promise<OpenLoopsView> {
    const path = notePaths(this.settings).openLoops
    const candidates = this.recentRuns().flatMap((r) =>
      (r.health?.findings ?? [])
        .filter((f) => f.loop)
        .map((finding) => ({
          runId: r.runId,
          hostname: r.hostname,
          finding,
          at: r.finishedAt ?? r.startedAt
        }))
    )
    try {
      const text = await (await import('node:fs/promises')).readFile(path, 'utf8')
      const tasks = parseTasks(text, this.settings.openLoopsNote)
      return {
        source: path,
        tasks,
        overdue: tasks.filter((t) => t.overdue).length,
        dueSoon: tasks.filter((t) => t.dueSoon).length,
        candidates
      }
    } catch (err) {
      return {
        source: path,
        tasks: [],
        overdue: 0,
        dueSoon: 0,
        candidates,
        error: (err as Error).message
      }
    }
  }

  private async workLog(limit: number): Promise<WorkLogView> {
    const path = notePaths(this.settings).workLog
    try {
      const text = await (await import('node:fs/promises')).readFile(path, 'utf8')
      const entries = parseDatedEntries(text, this.settings.workLogNote).slice(0, limit)
      return { source: path, entries }
    } catch (err) {
      return { source: path, entries: [], error: (err as Error).message }
    }
  }

  /* ---------- computer lookup ---------- */

  private async lookupData(): Promise<{
    notes: Awaited<ReturnType<VaultIndex['notes']>>
    computers: ReturnType<typeof buildComputers>
  }> {
    const notes = await this.vaultIndex.notes(this.settings.vaultPath)
    const roles = noteRoles(notes, this.settings)
    const inventory = roles.assets ? inventoryRows(roles.assets) : []
    const merged = new Map<string, ScanRun>()
    for (const r of this.runStore.list(5000)) merged.set(r.runId, r)
    for (const r of this.runner.list()) if (r.status !== 'running') merged.set(r.runId, r)
    return {
      notes,
      computers: buildComputers(this.devices.list(), [...merged.values()], inventory)
    }
  }

  private isConnected = (id: string): boolean => this.link?.isConnected(id) ?? false

  private async lookupSearch(query: string): Promise<LookupResult> {
    const started = performance.now()
    const { notes, computers } = await this.lookupData()
    const result = lookup(
      query,
      computers.map((c) => summarize(c, this.isConnected)),
      notes
    )
    return { ...result, tookMs: Math.round(performance.now() - started) }
  }

  private async lookupList(): Promise<ComputerSummary[]> {
    const { computers } = await this.lookupData()
    return rankComputers(
      '',
      computers.map((c) => summarize(c, this.isConnected))
    )
  }

  private async lookupProfile(target: LookupTarget): Promise<ComputerProfile> {
    const started = performance.now()
    const { notes, computers } = await this.lookupData()
    const profile = buildProfile({
      target,
      computers,
      notes,
      settings: this.settings,
      connected: this.isConnected,
      vaultError: this.vaultIndex.error
    })
    return { ...profile, tookMs: Math.round(performance.now() - started) }
  }

  /**
   * A note the renderer named, checked: a Markdown file the vault index knows, inside the vault
   * folder, a regular file (the index skips symlinks and junctions), no null bytes.
   */
  private async knownNote(file: string): Promise<{ note: IndexedNote; notes: IndexedNote[] }> {
    const name = String(file)
    if (name.includes('\0')) throw new Error('not a note inside the vault')
    const root = resolve(this.settings.vaultPath)
    const abs = resolve(root, name)
    const inside = isWindows
      ? abs.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`)
      : abs.startsWith(`${root}${sep}`)
    if (!inside || !/\.md$/i.test(abs)) throw new Error('not a note inside the vault')
    const notes = await this.vaultIndex.notes(this.settings.vaultPath)
    const note = notes.find((n) => resolve(n.abs) === abs)
    if (!note || !existsSync(abs)) throw new Error(`note not found: ${name}`)
    return { note, notes }
  }

  /** The dashboard's own reader: the note parsed, its links resolved, and what links to it. */
  private async readNote(file: string): Promise<NoteView> {
    const { note, notes } = await this.knownNote(file)
    return noteView(note, notes)
  }

  /** Opens a vault note in Obsidian: only on request, from the viewer's "Open in Obsidian". */
  private async openNote(file: string): Promise<void> {
    const { note } = await this.knownNote(file)
    const abs = resolve(note.abs)
    try {
      await shell.openExternal(`obsidian://open?path=${encodeURIComponent(abs)}`)
    } catch {
      const err = await shell.openPath(abs)
      if (err) throw new Error(err)
    }
  }

  /* ---------- settings ---------- */

  private async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const before = this.settings
    this.settings = mergeSettings(this.settings, patch)
    await saveSettings(this.paths.settingsFile, this.settings)
    this.writer.setLive(this.settings.vaultLive && this.settings.schemaApproved)
    if (before.beaconAllAdapters !== this.settings.beaconAllAdapters)
      void this.beaconer?.setInterfaces(
        beaconInterfaces(this.adapters, this.settings.beaconAllAdapters)
      )
    if (before.linkPort !== this.settings.linkPort)
      this.log('link', 'link port changes take effect after a restart')
    this.pushLink()
    return this.settings
  }

  /* ---------- IPC ---------- */

  registerIpc(): void {
    ipcMain.handle(IPC.settingsGet, (): Settings => this.settings)
    ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<Settings>) => this.updateSettings(patch))
    ipcMain.handle(
      IPC.appInfo,
      (): AppInfo => ({
        version: app.getVersion(),
        platform: process.platform,
        powerShell: isWindows ? 'powershell.exe' : 'n/a',
        settingsFile: this.paths.settingsFile,
        appDataDir: this.paths.appDataDir,
        agentBinary: this.paths.agentBinary,
        profilesDir: this.paths.profilesDir
      })
    )

    ipcMain.handle(IPC.devicesList, (): DeviceView[] => this.deviceViews())
    ipcMain.handle(IPC.devicesRemove, async (_e, id: string) => {
      await this.devices.remove(id)
      this.pushDevices()
    })
    ipcMain.handle(IPC.devicesRename, async (_e, id: string, displayName: string) => {
      await this.devices.touch(id, {
        displayName: displayName.trim() || this.devices.get(id)?.hostname || id.slice(0, 8)
      })
      this.pushDevices()
    })

    ipcMain.handle(IPC.linkStatus, (): LinkStatus => this.linkStatus())
    ipcMain.handle(IPC.linkRefresh, async (): Promise<LinkStatus> => {
      await Promise.all([
        this.linkWatcher?.refresh(),
        this.usb?.refresh(),
        this.checkFirewallRule()
      ])
      return this.linkStatus()
    })
    ipcMain.handle(IPC.linkEnableFirewall, () => this.enableFirewall())

    ipcMain.handle(IPC.enrollNew, (_e, label?: string): EnrollmentView => {
      if (!this.identity) throw new Error(this.lastLinkError ?? 'link not started')
      return this.enrollmentView(this.tokens.issue(this.identity.fingerprint, label))
    })
    ipcMain.handle(IPC.enrollCancel, (_e, token: string) => this.tokens.revoke(token))
    ipcMain.handle(IPC.enrollList, (): EnrollmentView[] =>
      this.tokens.active().map((t) => this.enrollmentView(t))
    )

    ipcMain.handle(IPC.scanStart, (_e, deviceId: string, purpose: Purpose): ScanRun => {
      const device = this.devices.get(deviceId)
      if (!device) throw new Error('unknown device')
      const run = this.runner.start(device, purpose, this.link?.isConnected(deviceId) ?? false)
      this.log(
        'scan',
        `${run.profile} v${run.version} started on ${device.displayName} by ${run.technician}`
      )
      return run
    })
    ipcMain.handle(IPC.scanAbort, (_e, runId: string) => this.runner.abort(runId))
    ipcMain.handle(
      IPC.scanGet,
      (_e, runId: string): ScanRun | null =>
        this.runner.get(runId) ?? this.runStore.get(runId) ?? null
    )
    ipcMain.handle(IPC.scanList, (): ScanRun[] =>
      this.recentRuns().concat(this.runner.list().filter((r) => r.status === 'running'))
    )
    ipcMain.handle(
      IPC.scanHistory,
      (_e, deviceId?: string): Promise<ScanHistoryEntry[]> =>
        this.scanLog.list({ deviceId, limit: 100 })
    )
    ipcMain.handle(IPC.profilesList, (): ProfileSummary[] => this.catalog.summaries())

    ipcMain.handle(IPC.vaultStatus, () => this.vaultStatus())
    ipcMain.handle(IPC.vaultPreview, (_e, runId: string | null) => this.vaultPreview(runId))
    ipcMain.handle(IPC.vaultApply, () => this.vaultApply())
    ipcMain.handle(IPC.vaultOpenLoops, () => this.openLoops())
    ipcMain.handle(IPC.vaultWorkLog, (_e, limit?: number) => this.workLog(limit ?? 30))
    ipcMain.handle(
      IPC.vaultSearch,
      (_e, query: string): Promise<SearchHit[]> =>
        searchVault(this.settings.vaultPath, query, { limit: 100 })
    )
    ipcMain.handle(IPC.vaultOpenNote, (_e, file: string) => this.openNote(file))
    ipcMain.handle(IPC.vaultReadNote, (_e, file: string) => this.readNote(file))
    ipcMain.handle(IPC.lookupSearch, (_e, query: string) => this.lookupSearch(String(query ?? '')))
    ipcMain.handle(IPC.lookupList, () => this.lookupList())
    ipcMain.handle(IPC.lookupProfile, (_e, target: LookupTarget) => this.lookupProfile(target))
    ipcMain.handle(IPC.vaultOpen, async () => {
      const result = await shell.openPath(this.settings.vaultPath)
      if (result) throw new Error(result)
    })
  }
}

/** Where the bundled agent binary for this host lives (packaged resources or the dev build). */
export function locateAgentBinary(
  appPath: string,
  resourcesPath: string,
  packaged: boolean
): { binary: string | null; distDir: string | null } {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const name = `arh-agent-${os}-${arch}${process.platform === 'win32' ? '.exe' : ''}`
  const candidates = packaged
    ? [join(resourcesPath, 'agent', name)]
    : [join(appPath, 'agent', 'dist', name)]
  for (const c of candidates) if (existsSync(c)) return { binary: c, distDir: join(c, '..') }
  return { binary: null, distDir: null }
}

export function hostLabel(): string {
  return hostname()
}
