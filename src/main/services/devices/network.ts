import { promises as dns } from 'node:dns'
import type { Device, ProbeResult } from '../../../shared/types.ts'
import { asArray, tryParseJson } from '../util/json.ts'
import { protocolsFromProbe } from './probe.ts'

/**
 * Passive LAN discovery from the host's IPv4 neighbour (ARP) table, plus reverse DNS and a port
 * probe per host. Nothing is scanned beyond hosts the OS has already talked to.
 *
 * Link-local 169.254.x.x neighbours are kept on purpose: a direct Ethernet or Thunderbolt/USB4
 * cable between the technician's PC and a device gives both ends an address in that range, so
 * it is exactly how a "cabled" device shows up.
 */

export const NET_NEIGHBOR_SCRIPT = String.raw`
$local = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress })
$n = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object {
    ([string]$_.State -in @('Reachable', 'Stale', 'Permanent', 'Delay', 'Probe')) -and
    $_.LinkLayerAddress -and
    ([string]$_.LinkLayerAddress -notin @('00-00-00-00-00-00', 'FF-FF-FF-FF-FF-FF', 'ff-ff-ff-ff-ff-ff')) -and
    $_.IPAddress -notlike '224.*' -and $_.IPAddress -notlike '239.*' -and $_.IPAddress -notlike '*.255' -and
    $_.IPAddress -ne '255.255.255.255'
  } |
  Select-Object IPAddress, LinkLayerAddress, @{ n = 'State'; e = { [string]$_.State } }, InterfaceAlias)
ConvertTo-Json -InputObject ([pscustomobject]@{ hostname = $env:COMPUTERNAME; local = $local; neighbors = $n }) -Depth 3 -Compress
`

export interface RawNeighbor {
  IPAddress: string
  LinkLayerAddress?: string | null
  State?: string | null
  InterfaceAlias?: string | null
}

export interface NeighborSnapshot {
  hostname: string
  local: string[]
  neighbors: RawNeighbor[]
}

export function parseNeighborJson(text: string): NeighborSnapshot {
  const parsed = tryParseJson(text) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object') return { hostname: '', local: [], neighbors: [] }
  const neighbors = asArray<RawNeighbor>(parsed['neighbors']).filter(
    (n) => typeof n?.IPAddress === 'string'
  )
  const local = asArray<string>(parsed['local']).filter((s) => typeof s === 'string')
  return {
    hostname: typeof parsed['hostname'] === 'string' ? parsed['hostname'] : '',
    local,
    neighbors
  }
}

export function networkDeviceId(ip: string): string {
  return `net:${ip}`
}

export function isLinkLocal(ip: string): boolean {
  return ip.startsWith('169.254.')
}

export function neighborToDevice(
  n: RawNeighbor,
  now: string,
  opts: { name?: string | null; probe?: ProbeResult; previous?: Device } = {}
): Device {
  const probe = opts.probe
  const os = probe?.os ?? opts.previous?.os ?? 'unknown'
  const baseHint =
    probe?.osHint ??
    opts.previous?.osHint ??
    `Neighbour state ${n.State ?? 'unknown'} on ${n.InterfaceAlias ?? 'unknown interface'}`
  const osHint = isLinkLocal(n.IPAddress)
    ? `${baseHint} · link-local address (direct cable or no DHCP)`
    : baseHint
  return {
    id: networkDeviceId(n.IPAddress),
    kind: 'network',
    name: opts.name?.trim() || opts.previous?.name || n.IPAddress,
    present: true,
    firstSeen: opts.previous?.firstSeen ?? now,
    lastSeen: now,
    os,
    osHint,
    protocols: probe ? protocolsFromProbe(probe) : (opts.previous?.protocols ?? []),
    host: n.IPAddress,
    mac: n.LinkLayerAddress ?? undefined,
    status: n.State ?? undefined
  }
}

export async function reverseLookup(ip: string, timeoutMs = 1500): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const names = await Promise.race([dns.reverse(ip), timeout])
    return Array.isArray(names) && names.length ? (names[0] ?? null) : null
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i] as T)
    }
  })
  await Promise.all(workers)
  return results
}

export interface NetworkDiscoveryOptions {
  enumerate: () => Promise<NeighborSnapshot>
  resolveName: (ip: string) => Promise<string | null>
  probe: (host: string) => Promise<ProbeResult>
  refreshMs: number
  probeOnDiscovery?: boolean
  maxHosts?: number
  onDevices: (devices: Device[]) => void
  onError?: (err: Error) => void
  now?: () => string
}

export class NetworkDiscovery {
  private opts: NetworkDiscoveryOptions
  private devices = new Map<string, Device>()
  private timer: ReturnType<typeof setInterval> | undefined
  private refreshing = false

  constructor(opts: NetworkDiscoveryOptions) {
    this.opts = opts
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), Math.max(10_000, this.opts.refreshMs))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  list(): Device[] {
    return [...this.devices.values()]
  }

  async refresh(): Promise<Device[]> {
    if (this.refreshing) return this.list()
    this.refreshing = true
    try {
      const now = (this.opts.now ?? (() => new Date().toISOString()))()
      const snapshot = await this.opts.enumerate()
      const local = new Set(snapshot.local)
      const neighbors = snapshot.neighbors
        .filter((n) => !local.has(n.IPAddress))
        .slice(0, this.opts.maxHosts ?? 64)
      const built = await mapLimit(neighbors, 8, async (n) => {
        const previous = this.devices.get(networkDeviceId(n.IPAddress))
        const name = await this.opts.resolveName(n.IPAddress)
        const probe =
          this.opts.probeOnDiscovery === false
            ? undefined
            : await this.opts.probe(n.IPAddress).catch(() => undefined)
        return neighborToDevice(n, now, { name, probe, previous })
      })
      const ids = new Set(built.map((d) => d.id))
      for (const d of built) this.devices.set(d.id, d)
      for (const [id, d] of this.devices)
        if (!ids.has(id) && d.present) this.devices.set(id, { ...d, present: false })
      this.opts.onDevices(this.list())
    } catch (err) {
      this.opts.onError?.(err as Error)
    } finally {
      this.refreshing = false
    }
    return this.list()
  }
}
