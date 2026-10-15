import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beaconInterfaces,
  cidrPrefix,
  classifyLink,
  LinkWatcher,
  parseAdaptersJson,
  type NetAdapter
} from '../src/main/services/detection/adapters.ts'
import { groupUsbDevices, parseInstanceId, parsePnpJson } from '../src/main/services/devices/usb.ts'

const ifaces = {
  'Ethernet 3': [
    {
      address: 'fe80::1c2b:3d4e:5f60:7a8b',
      netmask: 'ffff:ffff:ffff:ffff::',
      family: 'IPv6' as const,
      mac: 'aa',
      internal: false,
      cidr: null,
      scopeid: 12
    },
    {
      address: '169.254.10.20',
      netmask: '255.255.0.0',
      family: 'IPv4' as const,
      mac: 'aa',
      internal: false,
      cidr: null
    }
  ],
  'Wi-Fi': [
    {
      address: '192.168.1.5',
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: 'bb',
      internal: false,
      cidr: null
    }
  ]
}

test('link classification: USB-backed and cable-bridge adapters count, virtual ones do not', () => {
  assert.equal(
    classifyLink({
      pnpDeviceId: 'USB\\VID_0BDA&PID_8153\\00E04C680001',
      description: 'Realtek USB GbE Family Controller',
      virtual: false
    }).isLink,
    true
  )
  assert.equal(
    classifyLink({
      pnpDeviceId: 'PCI\\VEN_8086&DEV_15F3\\3&11583659&0&FE',
      description: 'Intel(R) Ethernet Connection',
      virtual: false
    }).isLink,
    false
  )
  assert.equal(
    classifyLink({
      pnpDeviceId: 'ROOT\\NET\\0000',
      description: 'Thunderbolt(TM) Networking',
      virtual: false
    }).isLink,
    true
  )
  assert.equal(
    classifyLink({
      pnpDeviceId: 'ROOT\\VMS_MP\\0000',
      description: 'Hyper-V Virtual Ethernet Adapter',
      virtual: true
    }).isLink,
    false
  )
})

test('parseAdaptersJson merges PowerShell metadata with Node addresses, and beacon interfaces follow link adapters', () => {
  const adapters = parseAdaptersJson(
    JSON.stringify([
      {
        name: 'Ethernet 3',
        description: 'Realtek USB GbE Family Controller',
        status: 'Up',
        mac: 'AA',
        pnpDeviceId: 'USB\\VID_0BDA&PID_8153\\1',
        ifIndex: 12,
        virtual: false,
        hardware: true
      },
      {
        name: 'Wi-Fi',
        description: 'Intel Wi-Fi 6',
        status: 'Up',
        mac: 'BB',
        pnpDeviceId: 'PCI\\X',
        ifIndex: 5,
        virtual: false,
        hardware: true
      },
      {
        name: 'Ethernet 9',
        description: 'USB bridge',
        status: 'Disconnected',
        mac: 'CC',
        pnpDeviceId: 'USB\\Y',
        ifIndex: 9,
        virtual: false,
        hardware: true
      }
    ]),
    ifaces
  )
  assert.equal(adapters.length, 3)
  const link = adapters.find((a) => a.name === 'Ethernet 3')!
  assert.equal(link.isLink, true)
  assert.deepEqual(link.ipv4, [{ address: '169.254.10.20', prefixLength: 16 }])
  assert.deepEqual(link.ipv6LinkLocal, [{ address: 'fe80::1c2b:3d4e:5f60:7a8b', scopeId: 12 }])
  const b = beaconInterfaces(adapters)
  assert.deepEqual(
    b.map((i) => [i.family, i.address]),
    [
      ['IPv4', '169.254.10.20'],
      ['IPv6', 'fe80::1c2b:3d4e:5f60:7a8b']
    ]
  )
  assert.equal(beaconInterfaces(adapters, true).length, 3, 'includeAll adds the Wi-Fi address')
  assert.equal(cidrPrefix('255.255.255.0'), 24)
  assert.equal(parseAdaptersJson('garbage', ifaces).length, 0)
})

test('LinkWatcher emits only when the adapter set changes and refreshes on events', async () => {
  let snapshot: NetAdapter[] = []
  const seen: number[] = []
  let fire: (() => void) | undefined
  const w = new LinkWatcher({
    enumerate: async () => snapshot,
    watchEvents: (onChange) => {
      fire = onChange
      return () => undefined
    },
    pollMs: 60_000,
    debounceMs: 0,
    onAdapters: (a) => seen.push(a.length)
  })
  try {
    w.start()
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(seen, [0])
    snapshot = parseAdaptersJson(
      JSON.stringify([
        {
          name: 'Ethernet 3',
          description: 'x',
          status: 'Up',
          mac: '',
          pnpDeviceId: 'USB\\1',
          ifIndex: 1,
          virtual: false,
          hardware: true
        }
      ]),
      ifaces
    )
    fire?.()
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(seen, [0, 1])
    await w.refresh()
    assert.deepEqual(seen, [0, 1], 'unchanged set does not emit')
  } finally {
    w.stop()
  }
})

test('USB peripheral grouping still works', () => {
  const raws = parsePnpJson(
    JSON.stringify([
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
      }
    ])
  )
  const devices = groupUsbDevices(raws, '2026-10-14T10:00:00Z')
  assert.equal(devices.length, 1)
  assert.equal(devices[0]?.name, 'Logitech USB Receiver')
  assert.equal(parseInstanceId('USB\\VID_046D&PID_C52B\\ABC123').serial, 'ABC123')
})
