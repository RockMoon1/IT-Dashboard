import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarize } from '../src/main/services/diagnostics/summary.ts'
import { asArray, tryParseJson } from '../src/main/services/util/json.ts'
import type { CommandResult } from '../src/shared/types.ts'

const now = new Date('2026-10-14T12:00:00Z')

function result(id: string, stdout: unknown, extra: Partial<CommandResult> = {}): CommandResult {
  return {
    id,
    title: id,
    format: typeof stdout === 'string' ? 'text' : 'json',
    exitCode: 0,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
    durationMs: 10,
    timedOut: false,
    optional: false,
    ...extra
  }
}

test('tryParseJson tolerates a BOM and warning lines before the JSON', () => {
  assert.deepEqual(tryParseJson('\uFEFF{"a":1}'), { a: 1 })
  assert.deepEqual(tryParseJson('WARNING: something\n[1,2]'), [1, 2])
  assert.equal(tryParseJson(''), null)
  assert.deepEqual(asArray({ x: 1 }), [{ x: 1 }])
  assert.deepEqual(asArray(null), [])
})

test('system diagnostics flags low disk, high RAM, long uptime and problem devices', () => {
  const overview = {
    os: 'Microsoft Windows 11 Pro',
    version: '10.0.26100',
    arch: '64-bit',
    cpu: 'Intel Core i7',
    cores: 4,
    logicalProcessors: 8,
    cpuLoadPct: 12,
    ramTotalGB: 16,
    ramUsedPct: 95.2,
    uptimeHours: 400,
    lastBoot: '2026-09-27T20:00:00',
    biosVersion: '1.2.3',
    biosDate: '2024-01-01',
    serial: 'ABC',
    manufacturer: 'Dell',
    model: 'Latitude',
    disks: [
      { drive: 'C:', sizeGB: 256, freeGB: 12.3, freePct: 4.8 },
      { drive: 'D:', sizeGB: 500, freeGB: 400, freePct: 80 }
    ]
  }
  const problems = [
    { FriendlyName: 'Realtek Audio', Class: 'MEDIA', Status: 'Error', InstanceId: 'HDAUDIO\\1' }
  ]
  const { findings, metrics } = summarize(
    'system-diagnostics',
    'windows',
    [result('sys-overview', overview), result('problem-devices', problems)],
    now
  )
  assert.ok(findings.some((f) => f.startsWith('Disk C: has only 4.8% free')))
  assert.ok(findings.some((f) => f === 'RAM usage is 95.2%'))
  assert.ok(findings.some((f) => f.startsWith('Uptime is 17 days')))
  assert.ok(
    findings.some((f) =>
      f.startsWith('1 Plug and Play device(s) report a non-OK status: Realtek Audio (Error)')
    )
  )
  assert.equal(metrics['Disk C:'], '12.3 GB free of 256 GB (4.8%)')
  assert.equal(metrics['Problem devices'], '1')
  assert.ok(!findings.some((f) => f.includes('Disk D:')))
})

test('security check reads Defender, Security Center, firewall, hotfix age and BitLocker', () => {
  const results = [
    result('sec-defender', {
      available: true,
      antivirusEnabled: false,
      realTimeProtectionEnabled: false,
      signatureAgeDays: 12,
      tamperProtected: true
    }),
    result('sec-av-products', {
      name: 'Contoso AV',
      productState: 0x1010,
      enabled: true,
      upToDate: false
    }),
    result('sec-firewall', [
      { Name: 'Domain', Enabled: 'True' },
      { Name: 'Public', Enabled: 'False' }
    ]),
    result('sec-updates', {
      hotfixes: [{ HotFixID: 'KB5001', InstalledOn: '2026-06-01' }],
      rebootPending: true
    }),
    result('sec-bitlocker', {
      available: true,
      volumes: [{ MountPoint: 'C:', ProtectionStatus: 'Off', VolumeType: 'OperatingSystem' }]
    }),
    result('sec-policies', {
      uacEnabled: false,
      smb1Enabled: true,
      secureBoot: false,
      smartScreenExplorer: 'Off'
    })
  ]
  const { findings, metrics } = summarize('security-check', 'windows', results, now)
  for (const expected of [
    'Microsoft Defender antivirus is disabled',
    'Defender real-time protection is off',
    'Defender signatures are 12 days old',
    'Antivirus "Contoso AV" reports out-of-date definitions',
    'Firewall profile "Public" is disabled',
    'A reboot is pending to finish servicing/updates',
    'BitLocker protection is Off on the OS volume C:',
    'User Account Control is disabled',
    'SMBv1 server protocol is enabled',
    'Secure Boot is off',
    'SmartScreen for apps and files is turned off'
  ]) {
    assert.ok(findings.includes(expected), `missing finding: ${expected}\n${findings.join('\n')}`)
  }
  assert.ok(findings.some((f) => /^No Windows update installed for 13[56] days/.test(f)))
  assert.equal(metrics['Latest hotfix'], 'KB5001 on 2026-06-01')
})

test('hardware check flags unhealthy disks, SMART prediction and worn batteries', () => {
  const results = [
    result('hw-disks', {
      disks: [
        {
          name: 'NVMe X',
          health: 'Warning',
          sizeGB: 512,
          media: 'SSD',
          wearPct: 85,
          readErrorsTotal: 3,
          writeErrorsTotal: 0
        }
      ],
      smart: [{ instance: 'NVMe X', predictFailure: true }]
    }),
    result('hw-battery', { present: true, healthPct: 48.5, chargePct: 90, cycleCount: 900 }),
    result('hw-system-errors', 'No critical/error events in the System log in the last 7 days.')
  ]
  const { findings, metrics } = summarize('hardware-issues', 'windows', results, now)
  assert.ok(findings.includes('Disk "NVMe X" health is Warning'))
  assert.ok(findings.includes('Disk "NVMe X" reports 85% wear'))
  assert.ok(findings.includes('Disk "NVMe X" has 3 read / 0 write errors'))
  assert.ok(findings.includes('SMART predicts failure for NVMe X'))
  assert.ok(findings.includes('Battery health is 48.5% of design capacity'))
  assert.equal(metrics['System log errors (7d)'], '0')
})

test('phishing assessment flags broad extensions, proxies, hosts overrides and forwarding rules', () => {
  const results = [
    result('phish-extensions', [
      {
        browser: 'Chrome',
        id: 'abc',
        name: 'Coupon Helper',
        permissions: ['<all_urls>', 'cookies']
      },
      { browser: 'Edge', id: 'def', name: 'Dark Reader', permissions: ['storage'] }
    ]),
    result('phish-settings', {
      smartScreenExplorer: 'Warn',
      defenderPuaProtection: 0,
      wordVbaWarnings: 1
    }),
    result('phish-network', {
      proxyEnabled: true,
      proxyServer: '10.9.9.9:8080',
      hostsEntries: ['1.2.3.4 login.microsoftonline.com'],
      dns: []
    }),
    result(
      'phish-outlook-rules',
      'Backup | enabled=True | FORWARD to evil@example.com\nSort | enabled=True | MOVE to Archive'
    )
  ]
  const { findings, metrics } = summarize('phishing-assessment', 'windows', results, now)
  assert.equal(metrics['Browser extensions'], '2')
  assert.ok(
    findings.some((f) =>
      f.startsWith('1 extension(s) hold broad permissions: Coupon Helper [Chrome]')
    )
  )
  assert.ok(findings.includes('Defender potentially-unwanted-app blocking is off'))
  assert.ok(findings.includes('Word is configured to enable all macros (VBAWarnings=1)'))
  assert.ok(findings.includes('A manual proxy is configured: 10.9.9.9:8080'))
  assert.ok(findings.some((f) => f.startsWith('1 non-default hosts-file entries')))
  assert.ok(findings.some((f) => f.startsWith('1 Outlook rule(s) forward or redirect mail')))
})

test('slow performance thresholds', () => {
  const results = [
    result('perf-resources', {
      cpuPct: 92,
      ramTotalGB: 8,
      ramUsedPct: 60,
      committedPct: 95,
      diskQueueLength: 3.5,
      processCount: 120,
      uptimeHours: 5,
      disks: []
    }),
    result('perf-top-processes', {
      byCpu: [{ Name: 'chrome', cpuSeconds: 900 }],
      byMemory: [{ Name: 'chrome', workingSetMB: 2048 }]
    }),
    result(
      'perf-startup',
      Array.from({ length: 16 }, (_, i) => ({ Name: `app${i}` }))
    )
  ]
  const { findings, metrics } = summarize('slow-performance', 'windows', results, now)
  assert.ok(findings.includes('CPU is at 92% (3 s average)'))
  assert.ok(findings.includes('Committed memory at 95% (page file pressure)'))
  assert.ok(findings.includes('Disk queue length 3.5 (storage bottleneck)'))
  assert.ok(findings.includes('16 startup programs'))
  assert.equal(metrics['Top CPU'], 'chrome (900 s)')
})

test('posix text heuristics: macOS security and Linux disk usage', () => {
  const mac = summarize(
    'security-check',
    'macos',
    [
      result(
        'sec-status',
        'gatekeeper: assessments disabled\napp_firewall: Firewall is disabled. (State = 0)\nfilevault: FileVault is Off.\nsip: System Integrity Protection status: enabled.'
      )
    ],
    now
  )
  assert.ok(mac.findings.includes('Gatekeeper assessments are disabled'))
  assert.ok(mac.findings.includes('macOS application firewall is disabled'))
  assert.ok(mac.findings.includes('FileVault disk encryption is off'))
  assert.ok(!mac.findings.some((f) => f.includes('Integrity')))

  const linux = summarize(
    'system-diagnostics',
    'linux',
    [
      result(
        'sys-overview',
        'PRETTY_NAME="Ubuntu 24.04"\n--- disks\nFilesystem Size Used Avail Use% Mounted on\n/dev/sda1 100G 95G 5G 95% /\n/dev/sdb1 1T 100G 900G 10% /data'
      )
    ],
    now
  )
  assert.equal(linux.metrics['OS'], 'Ubuntu 24.04')
  assert.ok(linux.findings.includes('Filesystem / has only 5% free'))
})

test('failed required commands are findings; failed optional commands are not', () => {
  const { findings } = summarize(
    'other',
    'windows',
    [
      result('a', 'x', { exitCode: 1 }),
      result('b', 'y', { exitCode: 1, optional: true }),
      result('c', 'z', { timedOut: true, durationMs: 90000 })
    ],
    now
  )
  assert.deepEqual(findings, ['Command "a" failed (exit 1)', 'Command "c" timed out after 90s'])
})
