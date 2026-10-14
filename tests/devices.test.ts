import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  groupUsbDevices,
  isNoiseDevice,
  parseInstanceId,
  parsePnpJson,
  UsbWatcher,
  type RawPnpDevice
} from '../src/main/services/devices/usb.ts'
import { inferOs, protocolsFromProbe } from '../src/main/services/devices/probe.ts'
import {
  NET_NEIGHBOR_SCRIPT,
  isLinkLocal,
  mapLimit,
  neighborToDevice,
  parseNeighborJson
} from '../src/main/services/devices/network.ts'
import {
  DeviceRegistry,
  makeLocalDevice,
  makeManualDevice
} from '../src/main/services/devices/registry.ts'

const raws: RawPnpDevice[] = [
  {
    InstanceId: 'USB\\ROOT_HUB30\\4&1&0',
    FriendlyName: 'USB Root Hub (USB 3.0)',
    Class: 'USB',
    Status: 'OK',
    Manufacturer: '(Standard USB HUBs)'
  },
  {
    InstanceId: 'USB\\VID_046D&PID_C52B\\ABC123',
    FriendlyName: 'USB Composite Device',
    Class: 'USB',
    Status: 'OK',
    Manufacturer: '(Standard USB Host Controller)'
  },
  {
    InstanceId: 'USB\\VID_046D&PID_C52B&MI_00\\7&1a2b&0&0000',
    FriendlyName: 'Logitech USB Receiver',
    Class: 'HIDClass',
    Status: 'OK',
    Manufacturer: 'Logitech'
  },
  {
    InstanceId: 'HID\\VID_046D&PID_C52B&MI_01\\8&2c3d&0&0000',
    FriendlyName: 'HID-compliant mouse',
    Class: 'Mouse',
    Status: 'OK',
    Manufacturer: 'Microsoft'
  },
  {
    InstanceId: 'USB\\VID_0781&PID_5567\\4C530001234',
    FriendlyName: 'USB Mass Storage Device',
    Class: 'USB',
    Status: 'OK',
    Manufacturer: 'Compatible USB storage device'
  },
  {
    InstanceId: 'USBSTOR\\DISK&VEN_SANDISK&PROD_CRUZER&REV_1.00\\4C530001234&0',
    FriendlyName: 'SanDisk Cruzer USB Device',
    Class: 'DiskDrive',
    Status: 'OK',
    Manufacturer: '(Standard disk drives)'
  },
  {
    InstanceId: 'USB\\VID_18D1&PID_4EE1\\R58M1234',
    FriendlyName: 'Pixel 7',
    Class: 'WPD',
    Status: 'Error',
    Manufacturer: 'Google'
  }
]

test('parseInstanceId extracts bus, VID/PID, interface and real serials', () => {
  assert.deepEqual(parseInstanceId('USB\\VID_046D&PID_C52B\\ABC123'), {
    bus: 'USB',
    vendorId: '046D',
    productId: 'C52B',
    interfaceId: undefined,
    serial: 'ABC123',
    instance: 'ABC123'
  })
  const child = parseInstanceId('USB\\VID_046D&PID_C52B&MI_00\\7&1a2b&0&0000')
  assert.equal(child.interfaceId, '00')
  assert.equal(child.serial, undefined)
  assert.equal(
    parseInstanceId('USBSTOR\\DISK&VEN_SANDISK&PROD_CRUZER&REV_1.00\\4C530001234&0').serial,
    '4C530001234'
  )
  assert.equal(parseInstanceId('USBSTOR\\DISK&VEN_X&PROD_Y&REV_1\\7&1234&0').serial, undefined)
})

test('hubs and host controllers are noise', () => {
  assert.equal(isNoiseDevice(raws[0]!), true)
  assert.equal(isNoiseDevice(raws[1]!), false)
})

test('groupUsbDevices collapses interfaces and storage children into one device each', () => {
  const devices = groupUsbDevices(raws, '2026-10-14T10:00:00Z')
  assert.deepEqual(devices.map((d) => d.id).sort(), [
    'usb:046D:C52B:ABC123',
    'usb:0781:5567:4C530001234',
    'usb:18D1:4EE1:R58M1234'
  ])
  const logi = devices.find((d) => d.id === 'usb:046D:C52B:ABC123')!
  assert.equal(logi.name, 'Logitech USB Receiver')
  assert.equal(logi.deviceClass, 'HIDClass')
  assert.equal(logi.manufacturer, 'Logitech')
  assert.equal(logi.serial, 'ABC123')
  assert.equal(logi.status, 'OK')
  const sandisk = devices.find((d) => d.id === 'usb:0781:5567:4C530001234')!
  assert.equal(sandisk.name, 'SanDisk Cruzer USB Device')
  assert.equal(sandisk.deviceClass, 'DiskDrive')
  const pixel = devices.find((d) => d.id === 'usb:18D1:4EE1:R58M1234')!
  assert.equal(pixel.status, 'Error')
  assert.ok(pixel.osHint?.includes('Android'))
  assert.deepEqual(pixel.protocols, [])
})

test('parsePnpJson accepts a single object or an array', () => {
  assert.equal(parsePnpJson(JSON.stringify(raws[1])).length, 1)
  assert.equal(parsePnpJson(JSON.stringify(raws)).length, raws.length)
  assert.equal(parsePnpJson('').length, 0)
})

test('UsbWatcher reports arrivals, removals and keeps firstSeen', async () => {
  let snapshot: RawPnpDevice[] = raws.slice(1, 4)
  let now = '2026-10-14T10:00:00Z'
  const seen: string[][] = []
  let fire: (() => void) | undefined
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(ok(), 'condition not met in time')
  }
  const watcher = new UsbWatcher({
    enumerate: async () => snapshot,
    watchEvents: (onChange) => {
      fire = onChange
      return () => undefined
    },
    pollMs: 60_000,
    debounceMs: 0,
    now: () => now,
    onDevices: (devices) => seen.push(devices.map((d) => `${d.id}:${d.present ? 'in' : 'out'}`))
  })
  try {
    watcher.start()
    await until(() => seen.length === 1)
    assert.deepEqual(seen, [['usb:046D:C52B:ABC123:in']])
    assert.ok(fire, 'event listener installed by start()')

    now = '2026-10-14T10:01:00Z'
    snapshot = raws.slice(1, 7)
    fire?.()
    await until(() => seen.length === 2)
    assert.deepEqual(seen[1]?.sort(), [
      'usb:046D:C52B:ABC123:in',
      'usb:0781:5567:4C530001234:in',
      'usb:18D1:4EE1:R58M1234:in'
    ])
    assert.equal(
      watcher.list().find((d) => d.id === 'usb:046D:C52B:ABC123')?.firstSeen,
      '2026-10-14T10:00:00Z'
    )

    snapshot = []
    await watcher.refresh()
    assert.equal(seen.length, 3)
    assert.ok(seen[2]?.every((s) => s.endsWith(':out')))
    await watcher.refresh()
    assert.equal(seen.length, 3, 'no change means no event')
  } finally {
    watcher.stop()
  }
})

test('inferOs uses banners first, then WinRM, then RDP/SMB, then SSH', () => {
  assert.equal(inferOs([22], 'SSH-2.0-OpenSSH_for_Windows_9.5').os, 'windows')
  assert.equal(inferOs([22], 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13').os, 'linux')
  assert.deepEqual(inferOs([5985, 445]).suggestedProtocol, 'winrm')
  assert.equal(inferOs([3389]).os, 'windows')
  assert.equal(inferOs([3389]).suggestedProtocol, null)
  const mac = inferOs([22], 'SSH-2.0-OpenSSH_9.8')
  assert.equal(mac.os, 'unknown')
  assert.equal(mac.suggestedProtocol, 'ssh')
  assert.equal(inferOs([]).suggestedProtocol, null)
  assert.deepEqual(
    protocolsFromProbe({
      host: 'h',
      reachable: true,
      openPorts: [22, 5986],
      os: 'windows',
      osHint: '',
      suggestedProtocol: 'winrm',
      durationMs: 1
    }),
    ['winrm', 'ssh']
  )
})

test("neighbour JSON becomes network devices without the host's own addresses", () => {
  const snap = parseNeighborJson(
    JSON.stringify({
      hostname: 'HOST',
      local: ['192.168.1.10'],
      neighbors: {
        IPAddress: '192.168.1.20',
        LinkLayerAddress: 'AA-BB',
        State: 'Reachable',
        InterfaceAlias: 'Ethernet'
      }
    })
  )
  assert.deepEqual(snap.local, ['192.168.1.10'])
  assert.equal(snap.neighbors.length, 1)
  const d = neighborToDevice(snap.neighbors[0]!, '2026-10-14T10:00:00Z', { name: 'laptop-01.lan' })
  assert.equal(d.id, 'net:192.168.1.20')
  assert.equal(d.name, 'laptop-01.lan')
  assert.equal(d.host, '192.168.1.20')
  assert.equal(d.os, 'unknown')
  assert.deepEqual(parseNeighborJson('garbage'), { hostname: '', local: [], neighbors: [] })
})

test('link-local neighbours (direct cable) are kept and labelled', () => {
  assert.ok(
    !NET_NEIGHBOR_SCRIPT.includes('169.254'),
    'script must not filter out link-local addresses'
  )
  const d = neighborToDevice(
    {
      IPAddress: '169.254.12.34',
      LinkLayerAddress: 'AA-BB',
      State: 'Reachable',
      InterfaceAlias: 'Ethernet 2'
    },
    '2026-10-14T10:00:00Z'
  )
  assert.equal(isLinkLocal(d.host ?? ''), true)
  assert.ok(d.osHint?.includes('link-local address (direct cable or no DHCP)'))
  assert.equal(isLinkLocal('192.168.1.5'), false)
})

test('mapLimit preserves order while bounding concurrency', async () => {
  let active = 0
  let peak = 0
  const out = await mapLimit([3, 1, 2], 2, async (n) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, n * 5))
    active--
    return n * 10
  })
  assert.deepEqual(out, [30, 10, 20])
  assert.equal(peak, 2)
})

test('DeviceRegistry orders local, manual, network, usb and replaces by kind', () => {
  const reg = new DeviceRegistry()
  const now = '2026-10-14T10:00:00Z'
  const events: number[] = []
  reg.onChange((list) => events.push(list.length))
  reg.upsert(makeLocalDevice('HOST', 'win32', now))
  reg.replaceKind('usb', groupUsbDevices(raws, now))
  reg.upsert(makeManualDevice('10.0.0.9', 'Server', undefined, now))
  assert.deepEqual(
    reg.list().map((d) => d.kind),
    ['local', 'manual', 'usb', 'usb', 'usb']
  )
  reg.replaceKind('usb', [])
  assert.deepEqual(
    reg.list().map((d) => d.kind),
    ['local', 'manual']
  )
  assert.deepEqual(events, [1, 4, 5, 2])
  assert.equal(makeLocalDevice('H', 'darwin', now).os, 'macos')
  assert.deepEqual(makeManualDevice('h', undefined, undefined, now).protocols, ['winrm', 'ssh'])
})
