import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** An enrolled target. The id is the SHA-256 fingerprint of the agent's certificate. */
export interface EnrolledDevice {
  id: string
  serial: string
  hostname: string
  os: 'windows' | 'macos' | 'linux' | 'unknown'
  displayName: string
  enrolledAt: string
  lastSeen: string
  agentVersion: string
  profiles: Array<{ name: string; version: number }>
  notes?: string
}

export function normalizeOs(value: unknown): EnrolledDevice['os'] {
  return value === 'windows' || value === 'macos' || value === 'linux' ? value : 'unknown'
}

/** JSON-file-backed registry of enrolled devices (no secrets: fingerprints are public). */
export class DeviceStore {
  private file: string
  private devices = new Map<string, EnrolledDevice>()
  private loaded = false

  constructor(file: string) {
    this.file = file
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (Array.isArray(raw)) {
        for (const d of raw as EnrolledDevice[])
          if (d && typeof d.id === 'string')
            this.devices.set(d.id, { ...d, os: normalizeOs(d.os), profiles: d.profiles ?? [] })
      }
    } catch {
      /* first run */
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.list(), null, 2), 'utf8')
  }

  get(id: string): EnrolledDevice | undefined {
    return this.devices.get(id)
  }

  list(): EnrolledDevice[] {
    return [...this.devices.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  /** Finds a device by serial first, then hostname (used to match link neighbours). */
  match(serial: string | undefined, hostname: string | undefined): EnrolledDevice | undefined {
    const all = this.list()
    if (serial) {
      const bySerial = all.find((d) => d.serial && d.serial.toLowerCase() === serial.toLowerCase())
      if (bySerial) return bySerial
    }
    if (hostname) return all.find((d) => d.hostname.toLowerCase() === hostname.toLowerCase())
    return undefined
  }

  async upsert(device: EnrolledDevice): Promise<EnrolledDevice> {
    if (!this.loaded) await this.load()
    this.devices.set(device.id, device)
    await this.save()
    return device
  }

  async touch(id: string, patch: Partial<EnrolledDevice>): Promise<void> {
    const d = this.devices.get(id)
    if (!d) return
    Object.assign(d, patch)
    await this.save()
  }

  async remove(id: string): Promise<boolean> {
    const had = this.devices.delete(id)
    if (had) await this.save()
    return had
  }
}
