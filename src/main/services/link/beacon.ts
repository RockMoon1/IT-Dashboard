import dgram from 'node:dgram'

/**
 * Broadcasts the host beacon on each link adapter so agents learn where to connect.
 * One UDP socket per interface address; sent to the limited broadcast address and, when the
 * netmask is known, the directed broadcast of the subnet.
 */

export const BEACON_PORT = 47911

export interface BeaconInterface {
  family: 'IPv4' | 'IPv6'
  address: string
  /** IPv4: CIDR prefix length, used to compute the directed broadcast address. */
  prefixLength?: number
  /** IPv6: interface scope id for link-local multicast. */
  scopeId?: number
  name?: string
}

/** Link-local multicast group the agent joins on every interface (see docs/PROTOCOL.md). */
export const IPV6_BEACON_GROUP = 'ff02::4152:4831'

function key(i: BeaconInterface): string {
  return `${i.family}:${i.address}${i.scopeId != null ? `%${i.scopeId}` : ''}`
}

export interface BeaconOptions {
  tlsPort: number
  hostFingerprint: string
  hostId: string
  intervalMs?: number
  log?: (line: string) => void
}

export function directedBroadcast(address: string, prefixLength: number): string | null {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  if (prefixLength < 0 || prefixLength > 31) return null
  const ip = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
  const bcast = (ip | (~mask >>> 0)) >>> 0
  return [bcast >>> 24, (bcast >>> 16) & 255, (bcast >>> 8) & 255, bcast & 255].join('.')
}

export function beaconPayload(opts: BeaconOptions): string {
  return JSON.stringify({
    arh: 1,
    port: opts.tlsPort,
    fp: opts.hostFingerprint.slice(0, 16).toLowerCase(),
    hostId: opts.hostId
  })
}

export class Beaconer {
  private opts: BeaconOptions
  private sockets = new Map<string, { socket: dgram.Socket; iface: BeaconInterface }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private payload: Buffer

  constructor(opts: BeaconOptions) {
    this.opts = opts
    this.payload = Buffer.from(beaconPayload(opts), 'utf8')
  }

  interfaces(): BeaconInterface[] {
    return [...this.sockets.values()].map((s) => s.iface)
  }

  /** Replaces the set of interfaces to beacon on. Sockets are kept for unchanged addresses. */
  async setInterfaces(list: BeaconInterface[]): Promise<void> {
    const wanted = new Set(list.map(key))
    for (const [k, entry] of this.sockets) {
      if (!wanted.has(k)) {
        entry.socket.close()
        this.sockets.delete(k)
        this.opts.log?.(`beacon stopped on ${k}`)
      }
    }
    for (const iface of list) {
      const k = key(iface)
      if (this.sockets.has(k)) continue
      try {
        const socket =
          iface.family === 'IPv6' ? await bindMulticast6(iface) : await bindBroadcast(iface.address)
        this.sockets.set(k, { socket, iface })
        this.opts.log?.(`beacon started on ${k}${iface.name ? ` (${iface.name})` : ''}`)
      } catch (err) {
        this.opts.log?.(`beacon could not bind ${k}: ${(err as Error).message}`)
      }
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 2000)
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const entry of this.sockets.values()) entry.socket.close()
    this.sockets.clear()
  }

  private tick(): void {
    for (const { socket, iface } of this.sockets.values()) {
      const targets = new Set<string>()
      if (iface.family === 'IPv6') {
        targets.add(IPV6_BEACON_GROUP)
      } else {
        targets.add('255.255.255.255')
        if (iface.prefixLength != null) {
          const d = directedBroadcast(iface.address, iface.prefixLength)
          if (d) targets.add(d)
        }
      }
      for (const target of targets) {
        socket.send(this.payload, BEACON_PORT, target, (err) => {
          if (err)
            this.opts.log?.(`beacon send to ${target} via ${iface.address} failed: ${err.message}`)
        })
      }
    }
  }
}

function bindBroadcast(address: string): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.once('error', reject)
    socket.bind(0, address, () => {
      socket.off('error', reject)
      try {
        socket.setBroadcast(true)
      } catch (err) {
        socket.close()
        reject(err as Error)
        return
      }
      socket.on('error', () => undefined)
      resolve(socket)
    })
  })
}

function bindMulticast6(iface: BeaconInterface): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp6', reuseAddr: true })
    socket.once('error', reject)
    const scoped = iface.scopeId ? `${iface.address}%${iface.scopeId}` : iface.address
    socket.bind(0, scoped, () => {
      socket.off('error', reject)
      try {
        if (iface.scopeId) socket.setMulticastInterface(`::%${iface.scopeId}`)
        socket.setMulticastTTL(1)
      } catch (err) {
        socket.close()
        reject(err as Error)
        return
      }
      socket.on('error', () => undefined)
      resolve(socket)
    })
  })
}
