import { networkInterfaces } from 'node:os'
import { asArray, tryParseJson } from '../util/json.ts'
import type { BeaconInterface } from '../link/beacon.ts'

/**
 * Link-adapter detection on the Windows host. Adapter metadata (PnP id, description, state)
 * comes from Get-NetAdapter; addresses come from Node's os.networkInterfaces() keyed by the same
 * adapter name. A WMI event listener nudges a refresh whenever an adapter or PnP device changes.
 */

export interface NetAdapter {
  name: string
  description: string
  status: string
  mac: string
  pnpDeviceId: string
  ifIndex: number
  virtual: boolean
  hardware: boolean
  ipv4: Array<{ address: string; prefixLength: number }>
  ipv6LinkLocal: Array<{ address: string; scopeId: number }>
  isLink: boolean
  linkReason?: string
}

export const ADAPTERS_SCRIPT = String.raw`
$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{
    name = $_.Name
    description = $_.InterfaceDescription
    status = [string]$_.Status
    mac = $_.MacAddress
    pnpDeviceId = [string]$_.PnPDeviceID
    ifIndex = [int]$_.ifIndex
    virtual = [bool]$_.Virtual
    hardware = [bool]$_.HardwareInterface
  }
})
ConvertTo-Json -InputObject $adapters -Depth 2 -Compress
`

/** Long-running listener that prints one JSON line per device or adapter change. */
export const NET_EVENTS_SCRIPT = String.raw`
$null = Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_DeviceChangeEvent" -SourceIdentifier ARHDev
$null = Register-CimIndicationEvent -Namespace root/StandardCimv2 -Query "SELECT * FROM __InstanceCreationEvent WITHIN 2 WHERE TargetInstance ISA 'MSFT_NetAdapter'" -SourceIdentifier ARHNetAdd
$null = Register-CimIndicationEvent -Namespace root/StandardCimv2 -Query "SELECT * FROM __InstanceDeletionEvent WITHIN 2 WHERE TargetInstance ISA 'MSFT_NetAdapter'" -SourceIdentifier ARHNetDel
$null = Register-CimIndicationEvent -Namespace root/StandardCimv2 -Query "SELECT * FROM __InstanceModificationEvent WITHIN 2 WHERE TargetInstance ISA 'MSFT_NetAdapter' AND TargetInstance.State <> PreviousInstance.State" -SourceIdentifier ARHNetMod
[Console]::Out.WriteLine('{"event":"ready"}')
[Console]::Out.Flush()
while ($true) {
  $e = Wait-Event
  Remove-Event -EventIdentifier $e.EventIdentifier
  $name = $null
  $id = $null
  $ti = $null
  try { $ti = $e.SourceEventArgs.NewEvent.TargetInstance } catch {}
  if ($ti) {
    if ($ti.PSObject.Properties['InterfaceDescription']) { $name = [string]$ti.InterfaceDescription } elseif ($ti.PSObject.Properties['Name']) { $name = [string]$ti.Name }
    if ($ti.PSObject.Properties['PnPDeviceID']) { $id = [string]$ti.PnPDeviceID } elseif ($ti.PSObject.Properties['DeviceID']) { $id = [string]$ti.DeviceID }
  }
  $o = [pscustomobject]@{ event = 'change'; source = [string]$e.SourceIdentifier; name = $name; id = $id }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
  [Console]::Out.Flush()
}
`

const LINK_DESCRIPTION =
  /thunderbolt|usb4|host-to-host|usb ethernet|usb 3\.\d gigabit|rndis|\bncm\b|bridge cable|easy transfer|pl25a1|pl27a1|usb-c lan|usb-c ethernet|usb to ethernet/i

export function classifyLink(a: Pick<NetAdapter, 'pnpDeviceId' | 'description' | 'virtual'>): {
  isLink: boolean
  reason?: string
} {
  if (/^USB\\/i.test(a.pnpDeviceId)) return { isLink: true, reason: 'USB-attached network adapter' }
  if (!a.virtual && LINK_DESCRIPTION.test(a.description))
    return { isLink: true, reason: 'adapter description matches a cable/bridge link' }
  return { isLink: false }
}

export function parseAdaptersJson(
  text: string,
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): NetAdapter[] {
  const raws = asArray<Record<string, unknown>>(tryParseJson(text))
  return raws
    .filter((r) => typeof r['name'] === 'string')
    .map((r) => {
      const name = r['name'] as string
      const addrs = ifaces[name] ?? []
      const base = {
        name,
        description: typeof r['description'] === 'string' ? r['description'] : '',
        status: typeof r['status'] === 'string' ? r['status'] : '',
        mac: typeof r['mac'] === 'string' ? r['mac'] : '',
        pnpDeviceId: typeof r['pnpDeviceId'] === 'string' ? r['pnpDeviceId'] : '',
        ifIndex: typeof r['ifIndex'] === 'number' ? r['ifIndex'] : 0,
        virtual: r['virtual'] === true,
        hardware: r['hardware'] === true,
        ipv4: addrs
          .filter((x) => x.family === 'IPv4' && !x.internal)
          .map((x) => ({ address: x.address, prefixLength: cidrPrefix(x.netmask) })),
        ipv6LinkLocal: addrs
          .filter(
            (x) => x.family === 'IPv6' && !x.internal && x.address.toLowerCase().startsWith('fe80:')
          )
          .map((x) => ({ address: x.address, scopeId: x.scopeid ?? 0 }))
      }
      const link = classifyLink(base)
      return { ...base, isLink: link.isLink, linkReason: link.reason }
    })
}

export function cidrPrefix(netmask: string): number {
  return netmask
    .split('.')
    .map(Number)
    .reduce((n, octet) => n + ((octet >>> 0).toString(2).match(/1/g)?.length ?? 0), 0)
}

/** Interfaces the beacon should use: every Up link adapter (or every Up hardware adapter when includeAll). */
export function beaconInterfaces(adapters: NetAdapter[], includeAll = false): BeaconInterface[] {
  const out: BeaconInterface[] = []
  for (const a of adapters) {
    if (a.status.toLowerCase() !== 'up') continue
    if (!(a.isLink || (includeAll && !a.virtual))) continue
    for (const v4 of a.ipv4)
      out.push({ family: 'IPv4', address: v4.address, prefixLength: v4.prefixLength, name: a.name })
    for (const v6 of a.ipv6LinkLocal)
      out.push({ family: 'IPv6', address: v6.address, scopeId: v6.scopeId, name: a.name })
  }
  return out
}

export interface LinkWatcherOptions {
  enumerate: () => Promise<NetAdapter[]>
  watchEvents?: (onChange: () => void, onExit: (err?: Error) => void) => () => void
  pollMs: number
  onAdapters: (adapters: NetAdapter[]) => void
  onError?: (err: Error) => void
  debounceMs?: number
}

export class LinkWatcher {
  private opts: LinkWatcherOptions
  private adapters: NetAdapter[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private stopEvents: (() => void) | undefined
  private refreshing = false
  private pending = false
  private stopped = false
  private lastKey = ''

  constructor(opts: LinkWatcherOptions) {
    this.opts = opts
  }

  start(): void {
    this.stopped = false
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), Math.max(3000, this.opts.pollMs))
    this.startEvents()
  }

  private startEvents(): void {
    if (!this.opts.watchEvents || this.stopped) return
    try {
      this.stopEvents = this.opts.watchEvents(
        () => this.scheduleRefresh(),
        (err) => {
          this.stopEvents = undefined
          if (err) this.opts.onError?.(err)
          if (!this.stopped) setTimeout(() => this.startEvents(), 5000)
        }
      )
    } catch (err) {
      this.opts.onError?.(err as Error)
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.stopEvents?.()
    this.stopEvents = undefined
  }

  scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.refresh(), this.opts.debounceMs ?? 750)
  }

  list(): NetAdapter[] {
    return this.adapters
  }

  async refresh(): Promise<NetAdapter[]> {
    if (this.refreshing) {
      this.pending = true
      return this.adapters
    }
    this.refreshing = true
    try {
      const next = await this.opts.enumerate()
      const key = JSON.stringify(
        next.map((a) => [a.name, a.status, a.isLink, a.ipv4, a.ipv6LinkLocal])
      )
      this.adapters = next
      if (key !== this.lastKey) {
        this.lastKey = key
        this.opts.onAdapters(next)
      }
    } catch (err) {
      this.opts.onError?.(err as Error)
    } finally {
      this.refreshing = false
      if (this.pending) {
        this.pending = false
        void this.refresh()
      }
    }
    return this.adapters
  }
}
