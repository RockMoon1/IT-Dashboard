import type { Device, TargetOS } from '../../../shared/types.ts'
import { asArray, tryParseJson } from '../util/json.ts'

/**
 * USB device detection on the Windows host through the PnP/WMI layer.
 *
 * Fact worth stating plainly: USB is a host/device bus. Another computer plugged in with a plain
 * USB cable does not enumerate as a device, so what shows up here are peripherals (storage,
 * phones, adapters, HID). Remote diagnostics always go over the network; the USB list exists for
 * hardware triage and for spotting tethered phones or USB network adapters.
 */

export interface RawPnpDevice {
  InstanceId?: string | null
  FriendlyName?: string | null
  Class?: string | null
  Status?: string | null
  Manufacturer?: string | null
}

export const USB_ENUM_SCRIPT = String.raw`
$devices = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { ($_.InstanceId -like 'USB\*') -or ($_.InstanceId -like 'USBSTOR\*') -or ($_.InstanceId -like 'WPD\*') -or ($_.InstanceId -like 'HID\VID_*') } |
  Select-Object InstanceId, FriendlyName, Class, Status, Manufacturer)
ConvertTo-Json -InputObject $devices -Compress
`

/** Long-running listener: prints one JSON line per Win32_DeviceChangeEvent. */
export const USB_EVENT_SCRIPT = String.raw`
$null = Register-CimIndicationEvent -ClassName Win32_DeviceChangeEvent -SourceIdentifier ARHDeviceChange
[Console]::Out.WriteLine('{"event":"ready"}')
[Console]::Out.Flush()
while ($true) {
  $e = Wait-Event -SourceIdentifier ARHDeviceChange
  Remove-Event -EventIdentifier $e.EventIdentifier
  $t = [int]$e.SourceEventArgs.NewEvent.EventType
  [Console]::Out.WriteLine('{"event":"change","type":' + $t + '}')
  [Console]::Out.Flush()
}
`

export function parsePnpJson(text: string): RawPnpDevice[] {
  return asArray<RawPnpDevice>(tryParseJson(text)).filter(
    (d) => typeof d?.InstanceId === 'string' && d.InstanceId.length > 0
  )
}

export interface ParsedInstanceId {
  bus: string
  vendorId?: string
  productId?: string
  interfaceId?: string
  serial?: string
  instance: string
}

/**
 * USB\VID_046D&PID_C52B\ABC123          -> parent, real serial "ABC123"
 * USB\VID_046D&PID_C52B&MI_00\7&1a2b&0&0000 -> interface 00, generated instance (no serial)
 * USBSTOR\DISK&VEN_X&PROD_Y&REV_1.0\4C53000123&0 -> serial "4C53000123"
 */
export function parseInstanceId(id: string): ParsedInstanceId {
  const parts = id.split('\\')
  const bus = (parts[0] ?? '').toUpperCase()
  const hw = parts[1] ?? ''
  const instance = parts.slice(2).join('\\')
  const vendorId = /VID_([0-9A-F]{4})/i.exec(hw)?.[1]?.toUpperCase()
  const productId = /PID_([0-9A-F]{4})/i.exec(hw)?.[1]?.toUpperCase()
  const interfaceId = /MI_([0-9A-F]{2})/i.exec(hw)?.[1]
  let serial: string | undefined
  if (bus === 'USB' && instance && !instance.includes('&')) serial = instance
  if (bus === 'USBSTOR') {
    const m = /^([^&]+)&\d+$/.exec(instance)
    if (m?.[1] && m[1].length >= 4) serial = m[1]
  }
  return { bus, vendorId, productId, interfaceId, serial, instance }
}

export function isNoiseDevice(d: RawPnpDevice): boolean {
  const name = d.FriendlyName ?? ''
  const cls = d.Class ?? ''
  if (/^USB Root Hub/i.test(name)) return true
  if (cls.toUpperCase() === 'USB' && /\bhub\b|host controller|xhci|ehci|ohci|uhci/i.test(name))
    return true
  return false
}

const GENERIC_NAME =
  /^(usb composite device|usb input device|usb mass storage device|usb device|usb attached scsi \(uas\) mass storage device|usb printing support|unknown usb device.*|hid-compliant .*|usb serial device.*)$/i

export function inferUsbOs(
  name: string,
  manufacturer: string,
  deviceClass: string
): { os: TargetOS; hint: string } {
  const text = `${name} ${manufacturer}`.toLowerCase()
  if (/apple|iphone|ipad/.test(text))
    return { os: 'unknown', hint: 'Apple mobile device over USB; not a remoting target' }
  if (/android|mtp|samsung|pixel|oneplus|xiaomi|motorola/.test(text))
    return { os: 'unknown', hint: 'Android device over USB; not a remoting target' }
  if (deviceClass.toLowerCase() === 'net' || /ethernet|\blan\b|rndis|\bncm\b|network/.test(text)) {
    return {
      os: 'unknown',
      hint: 'USB network adapter; the remote host is reached over the network, not USB'
    }
  }
  return { os: 'unknown', hint: 'USB peripheral; remote diagnostics need a network host' }
}

interface Entry {
  raw: RawPnpDevice
  parsed: ParsedInstanceId
}

function parentKey(e: Entry): string {
  const p = e.parsed
  return `usb:${p.vendorId}:${p.productId}:${p.serial ?? p.instance}`
}

/** Collapses interfaces/children into one Device per physical USB device. */
export function groupUsbDevices(
  raws: RawPnpDevice[],
  now: string,
  previous?: Map<string, Device>
): Device[] {
  const entries: Entry[] = raws
    .filter((r) => typeof r.InstanceId === 'string' && !isNoiseDevice(r))
    .map((r) => ({ raw: r, parsed: parseInstanceId(r.InstanceId as string) }))
  const parents = entries.filter(
    (e) =>
      e.parsed.bus === 'USB' && !e.parsed.interfaceId && e.parsed.vendorId && e.parsed.productId
  )
  const parentByVidPid = new Map<string, Entry[]>()
  for (const p of parents) {
    const k = `${p.parsed.vendorId}:${p.parsed.productId}`
    parentByVidPid.set(k, [...(parentByVidPid.get(k) ?? []), p])
  }

  const groups = new Map<string, { parent?: Entry; members: Entry[] }>()
  for (const e of entries) {
    let key: string
    let parent: Entry | undefined
    if (parents.includes(e)) {
      parent = e
      key = parentKey(e)
    } else {
      const cands = e.parsed.vendorId
        ? (parentByVidPid.get(`${e.parsed.vendorId}:${e.parsed.productId}`) ?? [])
        : parents.filter((p) => p.parsed.serial && p.parsed.serial === e.parsed.serial)
      if (cands.length > 0) {
        parent =
          cands.find(
            (c) => c.parsed.serial && e.parsed.serial && c.parsed.serial === e.parsed.serial
          ) ?? cands[0]
        key = parentKey(parent!)
      } else {
        key = `usb:${e.parsed.bus.toLowerCase()}:${e.raw.InstanceId}`
      }
    }
    const g = groups.get(key) ?? { members: [] }
    if (parent && !g.parent) g.parent = parent
    g.members.push(e)
    groups.set(key, g)
  }

  const devices: Device[] = []
  for (const [id, g] of groups) {
    const rep = g.parent ?? g.members[0]!
    const names = g.members.map((m) => (m.raw.FriendlyName ?? '').trim()).filter(Boolean)
    const name =
      names.find((n) => !GENERIC_NAME.test(n)) ??
      names[0] ??
      `USB device VID_${rep.parsed.vendorId ?? '????'} PID_${rep.parsed.productId ?? '????'}`
    const manufacturers = g.members.map((m) => (m.raw.Manufacturer ?? '').trim()).filter(Boolean)
    const manufacturer =
      manufacturers.find((m) => !/^\(standard|^microsoft$|^generic/i.test(m)) ?? manufacturers[0]
    const classes = g.members.map((m) => (m.raw.Class ?? '').trim()).filter(Boolean)
    const deviceClass = classes.find((c) => c.toUpperCase() !== 'USB') ?? classes[0] ?? 'USB'
    const bad = g.members.find((m) => (m.raw.Status ?? 'OK') !== 'OK')
    const status = bad ? (bad.raw.Status ?? 'Error') : 'OK'
    const serial = rep.parsed.serial ?? g.members.find((m) => m.parsed.serial)?.parsed.serial
    const { os, hint } = inferUsbOs(name, manufacturer ?? '', deviceClass)
    const prev = previous?.get(id)
    devices.push({
      id,
      kind: 'usb',
      name,
      present: true,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      os,
      osHint: hint,
      protocols: [],
      instanceId: rep.raw.InstanceId ?? undefined,
      vendorId: rep.parsed.vendorId,
      productId: rep.parsed.productId,
      serial,
      deviceClass,
      manufacturer,
      status
    })
  }
  return devices.sort((a, b) => a.name.localeCompare(b.name))
}

export interface UsbWatcherOptions {
  enumerate: () => Promise<RawPnpDevice[]>
  /** Starts an event listener; calls onChange on device arrival/removal and onExit when it dies. */
  watchEvents?: (onChange: () => void, onExit: (err?: Error) => void) => () => void
  pollMs: number
  onDevices: (devices: Device[]) => void
  onError?: (err: Error) => void
  now?: () => string
  debounceMs?: number
}

export class UsbWatcher {
  private opts: UsbWatcherOptions
  private devices = new Map<string, Device>()
  private timer: ReturnType<typeof setInterval> | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private stopEvents: (() => void) | undefined
  private refreshing = false
  private pending = false
  private stopped = false

  constructor(opts: UsbWatcherOptions) {
    this.opts = opts
  }

  start(): void {
    this.stopped = false
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), Math.max(2000, this.opts.pollMs))
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
    this.debounce = setTimeout(() => void this.refresh(), this.opts.debounceMs ?? 500)
  }

  list(): Device[] {
    return [...this.devices.values()]
  }

  async refresh(): Promise<Device[]> {
    if (this.refreshing) {
      this.pending = true
      return this.list()
    }
    this.refreshing = true
    try {
      const now = (this.opts.now ?? (() => new Date().toISOString()))()
      const raws = await this.opts.enumerate()
      const next = groupUsbDevices(raws, now, this.devices)
      const nextIds = new Set(next.map((d) => d.id))
      let changed = false
      for (const d of next) {
        const prev = this.devices.get(d.id)
        if (!prev || !prev.present || prev.status !== d.status || prev.name !== d.name)
          changed = true
        this.devices.set(d.id, d)
      }
      for (const [id, d] of this.devices) {
        if (!nextIds.has(id) && d.present) {
          this.devices.set(id, { ...d, present: false })
          changed = true
        }
      }
      if (changed) this.opts.onDevices(this.list())
    } catch (err) {
      this.opts.onError?.(err as Error)
    } finally {
      this.refreshing = false
      if (this.pending) {
        this.pending = false
        void this.refresh()
      }
    }
    return this.list()
  }
}
