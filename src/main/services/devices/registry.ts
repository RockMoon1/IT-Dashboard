import type { Device, DeviceKind, ProbeResult } from '../../../shared/types.ts'
import { protocolsFromProbe } from './probe.ts'

/** Merges devices from every source into one list the renderer subscribes to. */
export class DeviceRegistry {
  private byId = new Map<string, Device>()
  private listeners = new Set<(devices: Device[]) => void>()

  /** Replaces every device of a kind with the given set (sources own their kind). */
  replaceKind(kind: DeviceKind, devices: Device[]): void {
    for (const [id, d] of this.byId) if (d.kind === kind) this.byId.delete(id)
    for (const d of devices) this.byId.set(d.id, d)
    this.emit()
  }

  upsert(device: Device): Device {
    this.byId.set(device.id, device)
    this.emit()
    return device
  }

  remove(id: string): void {
    if (this.byId.delete(id)) this.emit()
  }

  get(id: string): Device | undefined {
    return this.byId.get(id)
  }

  list(): Device[] {
    const order: Record<DeviceKind, number> = { local: 0, manual: 1, network: 2, usb: 3 }
    return [...this.byId.values()].sort((a, b) => {
      if (a.kind !== b.kind) return order[a.kind] - order[b.kind]
      if (a.present !== b.present) return a.present ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  onChange(cb: (devices: Device[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    const list = this.list()
    for (const cb of this.listeners) cb(list)
  }
}

export function makeLocalDevice(hostname: string, platform: NodeJS.Platform, now: string): Device {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux'
  return {
    id: 'local',
    kind: 'local',
    name: `${hostname} (this PC)`,
    present: true,
    firstSeen: now,
    lastSeen: now,
    os,
    osHint: 'Runs the command set locally; useful to test a purpose before remoting',
    protocols: ['local'],
    host: hostname
  }
}

export function makeManualDevice(
  host: string,
  label: string | undefined,
  probe: ProbeResult | undefined,
  now: string
): Device {
  return {
    id: `manual:${host.toLowerCase()}`,
    kind: 'manual',
    name: label?.trim() || host,
    present: probe ? probe.reachable : true,
    firstSeen: now,
    lastSeen: now,
    os: probe?.os ?? 'unknown',
    osHint: probe?.osHint ?? 'Added by hand; probe to detect the OS and protocol',
    protocols: probe ? protocolsFromProbe(probe) : ['winrm', 'ssh'],
    host
  }
}
