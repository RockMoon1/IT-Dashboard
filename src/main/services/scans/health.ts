import { asArray, tryParseJson, type Json } from '../util/json.ts'
import type { ScanProfile } from './profiles.ts'
import type { HealthFinding, HealthReport, Severity } from '../../../shared/types.ts'

export type { HealthFinding, HealthReport, Severity }

/**
 * Health evaluation: turns check output into findings with a severity, plus a metrics table.
 * Findings with `loop: true` are the ones that become Open Loop candidates once the vault
 * schema is approved. Every rule is a threshold listed here, not a judgement call hidden in code.
 */

export const THRESHOLDS = {
  diskFreePctLow: 15,
  ramUsedPctHigh: 90,
  cpuPctHigh: 85,
  committedPctHigh: 90,
  diskQueueHigh: 2,
  uptimeDaysLong: 14,
  signatureAgeDaysStale: 7,
  updateAgeDaysStale: 30,
  batteryHealthPctLow: 60,
  ssdWearPctHigh: 80,
  startupItemsMany: 15,
  processCountMany: 300,
  failedLogins24hSpike: 20,
  systemErrorsMany: 20
}

export interface CheckOutcome {
  id: string
  title: string
  category: string
  format: 'json' | 'text'
  optional: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

const BROAD_EXTENSION_PERMISSIONS = [
  '<all_urls>',
  '*://*/*',
  'http://*/*',
  'https://*/*',
  'webRequest',
  'webRequestBlocking',
  'cookies',
  'history',
  'clipboardRead',
  'nativeMessaging',
  'debugger',
  'proxy'
]

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value)
  return null
}
function str(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
function daysSince(iso: unknown, now: Date): number | null {
  const t = Date.parse(str(iso))
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : null
}

class Report {
  findings: HealthFinding[] = []
  metrics: Record<string, string> = {}
  add(
    severity: Severity,
    category: string,
    message: string,
    loop = severity !== 'info',
    checkId?: string
  ): void {
    const id = `${category}:${message}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 80)
    if (this.findings.some((f) => f.id === id)) return
    // Only warnings and criticals go to ARH Open Loops: that note is the technician's working
    // list, and info items (reboot pending, long uptime, startup count) stay in the dashboard.
    this.findings.push({
      id,
      severity,
      category,
      message,
      loop: loop && severity !== 'info',
      checkId
    })
  }
  metric(key: string, value: string): void {
    if (value && value !== 'undefined' && value !== 'null') this.metrics[key] = value
  }
  /** Numbers kept per scan for the computer view's trends (disk-free:<drive>, ram-used …). */
  values: Record<string, number> = {}
  /**
   * Stores a value rounded to 0.1 and returns that same number. Threshold checks compare the
   * returned number, so a trend card and its health finding always judge the same value.
   */
  value(key: string, v: number | null | undefined): number | null {
    if (v == null || !Number.isFinite(v)) return null
    const x = Math.round(v * 10) / 10
    this.values[key] = x
    return x
  }
}

export function evaluateHealth(
  profile: Pick<ScanProfile, 'os' | 'purpose'>,
  outcomes: CheckOutcome[],
  now: Date = new Date()
): HealthReport {
  const r = new Report()
  for (const o of outcomes) {
    if (o.timedOut)
      r.add(o.optional ? 'info' : 'warning', 'Scan', `Check "${o.title}" timed out`, false, o.id)
    else if (o.exitCode !== 0 && !o.optional)
      r.add(
        'warning',
        'Scan',
        `Check "${o.title}" failed (exit ${o.exitCode ?? 'n/a'})`,
        false,
        o.id
      )
  }
  const json = (id: string): unknown => {
    const o = outcomes.find((x) => x.id === id)
    return o && o.format === 'json' ? tryParseJson(o.stdout) : null
  }
  const text = (id: string): string => outcomes.find((x) => x.id === id)?.stdout ?? ''
  const has = (id: string): boolean => outcomes.some((x) => x.id === id)

  if (profile.os === 'windows') windows(r, json, text, has, now)
  else posix(r, text, has)

  const critical = r.findings.some((f) => f.severity === 'critical')
  const warning = r.findings.some((f) => f.severity === 'warning')
  return {
    findings: r.findings,
    metrics: r.metrics,
    values: r.values,
    score: critical ? 'critical' : warning ? 'attention' : 'healthy'
  }
}

function checkDisks(r: Report, disks: Json[]): void {
  for (const d of disks) {
    const free = r.value(`disk-free:${str(d['drive'])}`, num(d['freePct']))
    if (free != null && free < THRESHOLDS.diskFreePctLow) {
      r.add(
        free < 5 ? 'critical' : 'warning',
        'Storage',
        `Disk ${str(d['drive'])} has ${free}% free${d['freeGB'] != null ? ` (${str(d['freeGB'])} GB)` : ''}`
      )
    }
  }
}

function windows(
  r: Report,
  json: (id: string) => unknown,
  text: (id: string) => string,
  has: (id: string) => boolean,
  now: Date
): void {
  const problem = asArray(json('problem-devices'))
  if (has('problem-devices')) {
    r.metric('Problem devices', String(problem.length))
    if (problem.length) {
      const names = problem
        .slice(0, 3)
        .map((d) => `${str(d['FriendlyName']) || str(d['InstanceId'])} (${str(d['Status'])})`)
        .join(', ')
      r.add('warning', 'Devices', `${problem.length} device(s) report a non-OK status: ${names}`)
    }
  }
  const o = obj(json('sys-overview'))
  if (Object.keys(o).length) {
    r.metric('OS', `${str(o['os'])} ${str(o['version'])} (${str(o['arch'])})`.trim())
    r.metric('Model', `${str(o['manufacturer'])} ${str(o['model'])}`.trim())
    r.metric('CPU', `${str(o['cpu'])} (${str(o['cores'])}C/${str(o['logicalProcessors'])}T)`)
    if (num(o['cpuLoadPct']) != null) r.metric('CPU load', `${str(o['cpuLoadPct'])}%`)
    r.metric('RAM', `${str(o['ramUsedPct'])}% of ${str(o['ramTotalGB'])} GB used`)
    r.metric('Uptime', `${str(o['uptimeHours'])} h (since ${str(o['lastBoot'])})`)
    r.metric('BIOS', `${str(o['biosVersion'])} (${str(o['biosDate']) || 'date n/a'})`)
    r.metric('Serial', str(o['serial']))
    for (const d of asArray(o['disks']))
      r.metric(
        `Disk ${str(d['drive'])}`,
        `${str(d['freeGB'])} GB free of ${str(d['sizeGB'])} GB (${str(d['freePct'])}%)`
      )
    checkDisks(r, asArray(o['disks']))
    const ram = r.value('ram-used', num(o['ramUsedPct']))
    if (ram != null && ram >= THRESHOLDS.ramUsedPctHigh)
      r.add('warning', 'Performance', `RAM usage is ${ram}%`)
    const up = num(o['uptimeHours'])
    const upDays = r.value('uptime-days', up != null ? up / 24 : null)
    if (upDays != null && upDays >= THRESHOLDS.uptimeDaysLong)
      r.add('info', 'System', `Uptime is ${Math.round(upDays)} days; a restart is overdue`, true)
  }
  const th = obj(json('sys-thermal'))
  if (th['supported'] === true) {
    const hottest = Math.max(...asArray(th['zones']).map((z) => num(z['celsius']) ?? -Infinity))
    if (Number.isFinite(hottest)) {
      r.metric('Hottest ACPI zone', `${hottest} C`)
      if (hottest >= 90) r.add('warning', 'Thermal', `ACPI thermal zone at ${hottest} C`)
    }
  } else if (th['supported'] === false) r.metric('Thermal', 'not exposed by firmware')

  const d = obj(json('sec-defender'))
  const av = asArray(json('sec-av-products'))
  // Defender steps back (passive mode) when another antivirus is registered and on: then its
  // own switches being off is expected, not a finding, and turning it on would not help
  const mode = str(d['amRunningMode'])
  const otherAv = av.filter((p) => p['enabled'] === true && !/defender/i.test(str(p['name'])))
  const passive = (mode !== '' && !/^normal$/i.test(mode)) || otherAv.length > 0
  if (d['available'] === true) {
    r.metric('Defender AV', d['antivirusEnabled'] === true ? 'enabled' : 'DISABLED')
    r.metric('Real-time protection', d['realTimeProtectionEnabled'] === true ? 'on' : 'OFF')
    r.metric('Signature age', `${str(d['signatureAgeDays'])} day(s)`)
    r.metric('Tamper protection', d['tamperProtected'] === true ? 'on' : 'off')
    if (mode) r.metric('Defender mode', mode)
    if (passive && (d['antivirusEnabled'] !== true || d['realTimeProtectionEnabled'] !== true))
      r.add(
        'info',
        'Antivirus',
        `Defender is ${mode && !/^normal$/i.test(mode) ? `in ${mode}` : 'stepped back'}: ${otherAv.map((p) => str(p['name'])).join(', ') || 'another antivirus'} provides protection`
      )
    else {
      if (d['antivirusEnabled'] !== true)
        r.add('critical', 'Antivirus', 'Microsoft Defender antivirus is disabled')
      if (d['realTimeProtectionEnabled'] !== true)
        r.add('critical', 'Antivirus', 'Defender real-time protection is off')
    }
    const age = r.value('av-signature-age', num(d['signatureAgeDays']))
    if (age != null && age > THRESHOLDS.signatureAgeDaysStale)
      r.add('warning', 'Antivirus', `Defender signatures are ${age} days old`)
  } else if (d['available'] === false)
    r.metric('Defender AV', 'not available (third-party AV or Server without the Defender module)')
  if (av.length) {
    r.metric(
      'AV products',
      av.map((p) => `${str(p['name'])}${p['enabled'] ? '' : ' (disabled)'}`).join('; ')
    )
    for (const p of av) {
      // Security Center shows a passive Defender as disabled; that is the same expected state
      if (p['enabled'] === false && !(passive && /defender/i.test(str(p['name']))))
        r.add('critical', 'Antivirus', `Antivirus "${str(p['name'])}" is registered but disabled`)
      if (p['upToDate'] === false)
        r.add(
          'warning',
          'Antivirus',
          `Antivirus "${str(p['name'])}" reports out-of-date definitions`
        )
    }
  } else if (has('sec-av-products') && d['available'] !== true)
    r.add('critical', 'Antivirus', 'No antivirus product registered with Security Center')
  const fw = asArray(json('sec-firewall'))
  if (fw.length) {
    r.metric('Firewall', fw.map((p) => `${str(p['Name'])}: ${str(p['Enabled'])}`).join(', '))
    for (const p of fw)
      if (str(p['Enabled']).toLowerCase() === 'false')
        r.add('critical', 'Firewall', `Firewall profile "${str(p['Name'])}" is disabled`)
  }
  const up = obj(json('sec-updates'))
  const hot = asArray(up['hotfixes'])
  if (hot[0]) {
    r.metric('Latest hotfix', `${str(hot[0]['HotFixID'])} on ${str(hot[0]['InstalledOn'])}`)
    const age = r.value('update-age', daysSince(hot[0]['InstalledOn'], now))
    if (age != null && age > THRESHOLDS.updateAgeDaysStale)
      r.add(
        'warning',
        'Updates',
        `No Windows update installed for ${Math.round(age)} days (latest ${str(hot[0]['HotFixID'])})`
      )
  } else if (Object.keys(up).length)
    r.add('warning', 'Updates', 'Get-HotFix returned no dated updates')
  if (up['lastInstallSuccess']) r.metric('WU last install', str(up['lastInstallSuccess']))
  if (up['rebootPending'] === true)
    r.add('info', 'Updates', 'A reboot is pending to finish servicing/updates', true)
  const bl = obj(json('sec-bitlocker'))
  if (bl['available'] === true) {
    const vols = asArray(bl['volumes'])
    r.metric(
      'BitLocker',
      vols.map((v) => `${str(v['MountPoint'])} ${str(v['ProtectionStatus'])}`).join(', ') ||
        'no volumes'
    )
    for (const v of vols)
      if (str(v['VolumeType']) === 'OperatingSystem' && str(v['ProtectionStatus']) !== 'On')
        r.add(
          'warning',
          'Encryption',
          `BitLocker protection is ${str(v['ProtectionStatus']) || 'off'} on the OS volume ${str(v['MountPoint'])}`
        )
  } else if (bl['available'] === false) r.metric('BitLocker', 'not readable')
  const pol = obj(json('sec-policies'))
  if (Object.keys(pol).length) {
    r.metric('UAC', pol['uacEnabled'] === true ? 'enabled' : 'DISABLED')
    r.metric('RDP', pol['rdpEnabled'] === true ? 'enabled' : 'disabled')
    if (pol['secureBoot'] != null)
      r.metric('Secure Boot', pol['secureBoot'] === true ? 'on' : 'off')
    if (pol['uacEnabled'] !== true)
      r.add('critical', 'Hardening', 'User Account Control is disabled')
    if (pol['smb1Enabled'] === true)
      r.add('warning', 'Hardening', 'SMBv1 server protocol is enabled')
    if (pol['secureBoot'] === false) r.add('warning', 'Hardening', 'Secure Boot is off')
    if (str(pol['smartScreenExplorer']).toLowerCase() === 'off' || pol['smartScreenPolicy'] === 0)
      r.add('warning', 'Hardening', 'SmartScreen for apps and files is turned off')
  }
  const lg = obj(json('sec-logins'))
  if (Object.keys(lg).length) {
    const f24 = r.value('failed-logins-24h', num(lg['failedLogins24h']))
    r.metric(
      'Failed sign-ins (24 h / 7 d)',
      `${str(lg['failedLogins24h'])} / ${str(lg['failedLogins7d'])}`
    )
    if (f24 != null && f24 >= THRESHOLDS.failedLogins24hSpike) {
      const top = asArray(lg['topFailedAccounts'])
        .slice(0, 3)
        .map((a) => `${str(a['account'])} (${str(a['failures'])})`)
        .join(', ')
      r.add('critical', 'Accounts', `${f24} failed sign-ins in 24 hours${top ? `: ${top}` : ''}`)
    }
  }
  const sv = obj(json('sec-services-failed'))
  const stopped = asArray(sv['autoServicesNotRunning'])
  if (Object.keys(sv).length) {
    r.metric('Auto services not running', String(stopped.length))
    if (stopped.length)
      r.add(
        'warning',
        'Services',
        `${stopped.length} automatic service(s) not running: ${stopped
          .slice(0, 3)
          .map((s) => str(s['Name']))
          .join(', ')}`
      )
    const scm = asArray(sv['scmErrors'])
    const total = scm.reduce((n, e) => n + (num(e['count']) ?? 0), 0)
    if (total >= 10)
      r.add('info', 'Services', `${total} Service Control Manager errors in 7 days`, true)
  }
  const sw = asArray(json('sec-software'))
  if (has('sec-software')) r.metric('Installed software', String(sw.length))

  const m = obj(json('mail-outlook'))
  if (Object.keys(m).length) {
    r.metric(
      'Classic Outlook',
      m['classicOutlookInstalled'] === true
        ? `installed${m['outlookRunning'] ? ', running' : ''}`
        : 'not installed'
    )
    r.metric('New Outlook', m['newOutlookInstalled'] === true ? 'installed' : 'not installed')
    r.metric(
      'M365 apps',
      m['m365Products']
        ? `${str(m['m365Products'])} ${str(m['m365Version'])}`.trim()
        : 'not detected'
    )
    const users = asArray(m['users'])
    for (const u of users) {
      const profiles = asArray<string>(u['profiles'])
      if (u['hiveLoaded'] === true)
        r.metric(
          `Outlook profiles (${str(u['user'])})`,
          profiles.length ? profiles.join(', ') : 'none'
        )
      for (const ost of asArray(u['ostFiles'])) {
        const gb = num(ost['sizeGB'])
        if (gb != null && gb > 40)
          r.add('warning', 'Email', `OST ${str(ost['name'])} for ${str(u['user'])} is ${gb} GB`)
      }
    }
    if (m['classicOutlookInstalled'] !== true && m['newOutlookInstalled'] !== true)
      r.add('warning', 'Email', 'No Outlook client installed')
  }
  const conn = asArray(json('mail-connectivity'))
  if (conn.length) {
    const down = conn.filter((c) => c['reachable'] !== true)
    r.metric('M365 endpoints', `${conn.length - down.length}/${conn.length} reachable`)
    for (const c of down)
      r.add('warning', 'Email', `Cannot reach ${str(c['host'])}:${str(c['port'])} from the device`)
  }

  const hd = obj(json('hw-disks'))
  for (const dk of asArray(hd['disks'])) {
    const label = `Disk "${str(dk['name'])}"`
    const parts = [str(dk['health']), `${str(dk['sizeGB'])} GB`, str(dk['media'])]
    if (dk['temperatureC'] != null) parts.push(`${str(dk['temperatureC'])} C`)
    if (dk['wearPct'] != null) parts.push(`wear ${str(dk['wearPct'])}%`)
    r.metric(label, parts.filter(Boolean).join(', '))
    if (str(dk['health']) && str(dk['health']) !== 'Healthy')
      r.add('critical', 'Storage', `${label} health is ${str(dk['health'])}`)
    const wear = num(dk['wearPct'])
    if (wear != null && wear >= THRESHOLDS.ssdWearPctHigh)
      r.add('warning', 'Storage', `${label} reports ${wear}% wear`)
    if ((num(dk['readErrorsTotal']) ?? 0) > 0 || (num(dk['writeErrorsTotal']) ?? 0) > 0)
      r.add(
        'warning',
        'Storage',
        `${label} has ${num(dk['readErrorsTotal']) ?? 0} read / ${num(dk['writeErrorsTotal']) ?? 0} write errors`
      )
  }
  for (const s of asArray(hd['smart']))
    if (s['predictFailure'] === true)
      r.add('critical', 'Storage', `SMART predicts failure for ${str(s['instance'])}`)
  const b = obj(json('hw-battery'))
  if (b['present'] === true) {
    const health = r.value('battery-health', num(b['healthPct']))
    r.metric(
      'Battery',
      `${health != null ? `${health}% health` : 'health n/a'}, ${str(b['chargePct'])}% charge${b['cycleCount'] != null ? `, ${str(b['cycleCount'])} cycles` : ''}`
    )
    if (health != null && health < THRESHOLDS.batteryHealthPctLow)
      r.add('warning', 'Power', `Battery health is ${health}% of design capacity`)
  } else if (b['present'] === false) r.metric('Battery', 'none (desktop)')
  const errText = text('hw-system-errors')
  if (errText && !errText.startsWith('No critical/error events')) {
    const count = errText.split(/\r?\n/).filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l.trim())).length
    r.metric('System log errors (7d)', String(count))
    r.value('system-errors-7d', count)
    if (count >= THRESHOLDS.systemErrorsMany)
      r.add('warning', 'Events', `${count}+ critical/error events in the System log in 7 days`)
  } else if (errText) r.metric('System log errors (7d)', '0')

  const pr = obj(json('perf-resources'))
  if (Object.keys(pr).length) {
    const cpu = r.value('cpu', num(pr['cpuPct']))
    if (cpu != null) r.metric('CPU', `${cpu}%`)
    r.metric('RAM', `${str(pr['ramUsedPct'])}% of ${str(pr['ramTotalGB'])} GB`)
    if (pr['committedPct'] != null) r.metric('Committed memory', `${str(pr['committedPct'])}%`)
    if (pr['diskQueueLength'] != null) r.metric('Disk queue', str(pr['diskQueueLength']))
    r.metric('Processes', str(pr['processCount']))
    if (cpu != null && cpu >= THRESHOLDS.cpuPctHigh)
      r.add('warning', 'Performance', `CPU is at ${cpu}% (3 s average)`)
    const ram = r.value('ram-used', num(pr['ramUsedPct']))
    if (ram != null && ram >= THRESHOLDS.ramUsedPctHigh)
      r.add('warning', 'Performance', `RAM usage is ${ram}%`)
    const committed = num(pr['committedPct'])
    if (committed != null && committed >= THRESHOLDS.committedPctHigh)
      r.add('warning', 'Performance', `Committed memory at ${committed}% (page file pressure)`)
    const q = num(pr['diskQueueLength'])
    if (q != null && q >= THRESHOLDS.diskQueueHigh)
      r.add('warning', 'Performance', `Disk queue length ${q} (storage bottleneck)`)
    const pc = num(pr['processCount'])
    if (pc != null && pc >= THRESHOLDS.processCountMany)
      r.add('info', 'Performance', `${pc} processes running`, false)
    checkDisks(r, asArray(pr['disks']))
  }
  const top = obj(json('perf-top-processes'))
  const byCpu = asArray(top['byCpu'])
  if (byCpu.length)
    r.metric(
      'Top CPU',
      byCpu
        .slice(0, 3)
        .map((p) => `${str(p['Name'])} (${str(p['cpuSeconds'])} s)`)
        .join(', ')
    )
  const byMem = asArray(top['byMemory'])
  if (byMem.length)
    r.metric(
      'Top memory',
      byMem
        .slice(0, 3)
        .map((p) => `${str(p['Name'])} (${str(p['workingSetMB'])} MB)`)
        .join(', ')
    )
  const startup = asArray(json('perf-startup'))
  if (has('perf-startup')) {
    r.metric('Startup items', String(startup.length))
    r.value('startup-items', startup.length)
    if (startup.length >= THRESHOLDS.startupItemsMany)
      r.add('info', 'Startup', `${startup.length} startup programs`, true)
  }

  const exts = asArray(json('phish-extensions'))
  if (has('phish-extensions')) {
    r.metric('Browser extensions', String(exts.length))
    const broad = exts.filter((e) =>
      asArray<string>(e['permissions']).some((p) => BROAD_EXTENSION_PERMISSIONS.includes(str(p)))
    )
    if (broad.length)
      r.add(
        'warning',
        'Browser',
        `${broad.length} extension(s) hold broad permissions: ${broad
          .slice(0, 4)
          .map(
            (e) =>
              `${str(e['name']) || str(e['id'])} [${str(e['browser'])}${e['user'] ? `, ${str(e['user'])}` : ''}]`
          )
          .join(', ')}`
      )
  }
  const s = obj(json('phish-settings'))
  if (Object.keys(s).length) {
    r.metric('SmartScreen (Explorer)', str(s['smartScreenExplorer']) || 'default')
    if (s['defenderPuaProtection'] != null)
      r.metric(
        'Defender PUA',
        s['defenderPuaProtection'] === 1
          ? 'block'
          : s['defenderPuaProtection'] === 2
            ? 'audit'
            : 'off'
      )
    if (str(s['smartScreenExplorer']).toLowerCase() === 'off' || s['smartScreenPolicy'] === 0)
      r.add('warning', 'Protection', 'SmartScreen for apps and files is turned off')
    if (s['defenderPuaProtection'] === 0)
      r.add('warning', 'Protection', 'Defender potentially-unwanted-app blocking is off')
    if (s['defenderNetworkProtection'] === 0)
      r.add('info', 'Protection', 'Defender network protection is off', true)
    for (const u of asArray(s['users'])) {
      if (u['wordVbaWarnings'] === 1 || u['excelVbaWarnings'] === 1)
        r.add(
          'critical',
          'Protection',
          `Office is configured to enable all macros for ${str(u['user'])}`
        )
      if (u['outlookBlockExternalContent'] === 0)
        r.add(
          'warning',
          'Protection',
          `Outlook downloads external content automatically for ${str(u['user'])}`
        )
    }
  }
  const n = obj(json('phish-network'))
  if (Object.keys(n).length) {
    const hosts = asArray<string>(n['hostsEntries'])
    r.metric('hosts overrides', String(hosts.length))
    const dns = asArray(n['dns'])
    if (dns.length)
      r.metric(
        'DNS',
        dns
          .map((x) => `${str(x['interface'])}: ${asArray<string>(x['servers']).join(' ')}`)
          .join('; ')
      )
    for (const u of asArray(n['users'])) {
      if (u['proxyEnabled'] === true)
        r.add(
          'warning',
          'Network',
          `A manual proxy is configured for ${str(u['user'])}: ${str(u['proxyServer'])}`
        )
      if (u['autoConfigUrl'])
        r.add(
          'warning',
          'Network',
          `A proxy auto-config URL is set for ${str(u['user'])}: ${str(u['autoConfigUrl'])}`
        )
    }
    if (hosts.length)
      r.add(
        'warning',
        'Network',
        `${hosts.length} non-default hosts-file entries (possible pharming): ${hosts.slice(0, 3).join(' | ')}`
      )
  }
  const dl = asArray(json('phish-downloads'))
  if (dl.length) {
    const execs = dl.reduce((acc, u) => acc + asArray(u['executableFiles']).length, 0)
    r.metric('Executable downloads (14d)', String(execs))
    if (execs)
      r.add(
        'info',
        'Downloads',
        `${execs} executable/script download(s) in the last 14 days`,
        false
      )
  }
}

function posix(r: Report, text: (id: string) => string, has: (id: string) => boolean): void {
  const all = [
    'sys-overview',
    'sys-profiler',
    'sec-status',
    'sec-firewall',
    'sec-updates',
    'sec-hardening',
    'sec-softwareupdate',
    'sec-logins',
    'sec-services-failed',
    'mail-connectivity',
    'hw-storage',
    'hw-battery',
    'hw-diskutil-root',
    'perf-resources',
    'phish-settings',
    'phish-extensions'
  ]
    .map(text)
    .join('\n')
  const grab = (re: RegExp): string => all.match(re)?.[1]?.trim() ?? ''

  const product =
    grab(/ProductName:\s*(.+)/) ||
    grab(/PRETTY_NAME="?([^"\n]+)/) ||
    grab(/Operating System:\s*(.+)/) ||
    grab(/"os_version"\s*:\s*"([^"]+)"/)
  if (product) r.metric('OS', `${product} ${grab(/ProductVersion:\s*(.+)/)}`.trim())
  const cpu =
    grab(/cpu:\s*(.+)/) || grab(/Model name:\s*(.+)/) || grab(/"chip_type"\s*:\s*"([^"]+)"/)
  if (cpu) r.metric('CPU', cpu)
  const mem = grab(/memory_gb:\s*(\d+)/)
  if (mem) r.metric('RAM', `${mem} GB`)
  const memLine = all.match(/^Mem:\s+(\S+)\s+(\S+)/m)
  if (memLine) r.metric('RAM', `${memLine[2]} used of ${memLine[1]}`)
  for (const m of all.matchAll(/^(\/dev\/\S+|\S+)\s+\S+\s+\S+\s+\S+\s+(\d+)%\s+(\/\S*)$/gm)) {
    const pct = Number(m[2])
    const mount = m[3] ?? ''
    if (mount === '/' || mount === '/System/Volumes/Data' || mount === '/home') {
      r.metric(`Disk ${mount}`, `${100 - pct}% free`)
      r.value(`disk-free:${mount}`, 100 - pct)
      if (100 - pct < THRESHOLDS.diskFreePctLow)
        r.add(
          100 - pct < 5 ? 'critical' : 'warning',
          'Storage',
          `Filesystem ${mount} has only ${100 - pct}% free`
        )
    }
  }
  const gk = grab(/gatekeeper:\s*(.+)/)
  if (gk) {
    r.metric('Gatekeeper', gk)
    if (/disabled/i.test(gk)) r.add('critical', 'Hardening', 'Gatekeeper assessments are disabled')
  }
  const fw = grab(/app_firewall:\s*(.+)/)
  if (fw) {
    r.metric('Application firewall', fw)
    if (/disabled|State = 0/i.test(fw))
      r.add('warning', 'Firewall', 'macOS application firewall is disabled')
  }
  const fv = grab(/filevault:\s*(.+)/)
  if (fv) {
    r.metric('FileVault', fv)
    if (/Off/i.test(fv)) r.add('warning', 'Encryption', 'FileVault disk encryption is off')
  }
  const sip = grab(/sip:\s*(.+)/)
  if (sip && /disabled/i.test(sip))
    r.add('critical', 'Hardening', 'System Integrity Protection is disabled')
  if (/^Status: inactive/m.test(all)) r.add('warning', 'Firewall', 'ufw firewall is inactive')
  if (/^not running$/m.test(all)) r.add('warning', 'Firewall', 'firewalld is not running')
  if (/^\s*PermitRootLogin\s+yes/im.test(all))
    r.add('warning', 'Hardening', 'sshd permits root login')
  if (/^\s*PasswordAuthentication\s+yes/im.test(all))
    r.add('info', 'Hardening', 'sshd allows password authentication', false)
  if (/REBOOT REQUIRED/.test(all))
    r.add('info', 'Updates', 'A reboot is required to finish package updates', true)
  const upgradable = all.split(/\r?\n/).filter((l) => /\[upgradable from/.test(l)).length
  if (upgradable) {
    r.metric('Upgradable packages', String(upgradable))
    if (upgradable >= 20) r.add('warning', 'Updates', `${upgradable} packages have pending updates`)
  }
  const macUpdates = all.split(/\r?\n/).filter((l) => /^\s*\*\s+Label:/.test(l)).length
  if (macUpdates) r.add('warning', 'Updates', `${macUpdates} macOS update(s) available`)
  const failedUnits = all.split(/\r?\n/).filter((l) => /\.service\s+loaded\s+failed/.test(l)).length
  if (has('sec-services-failed')) {
    r.metric('Failed systemd units', String(failedUnits))
    if (failedUnits) r.add('warning', 'Services', `${failedUnits} systemd unit(s) failed`)
  }
  const failedAuth = grab(/failed ssh\/pam \(journal, 24h\)\n(\d+)/)
  if (failedAuth && Number(failedAuth) >= THRESHOLDS.failedLogins24hSpike)
    r.add('critical', 'Accounts', `${failedAuth} failed authentications in the last 24 hours`)
  const down = all.split(/\r?\n/).filter((l) => /UNREACHABLE/.test(l))
  const up = all.split(/\r?\n/).filter((l) => / reachable$/.test(l))
  if (up.length + down.length)
    r.metric('M365 endpoints', `${up.length}/${up.length + down.length} reachable`)
  for (const d of down)
    r.add('warning', 'Email', `Cannot reach ${d.replace(' UNREACHABLE', '')} from the device`)
  if (/SMART Status:\s*(?!Verified)/.test(all))
    r.add('critical', 'Storage', 'A disk reports a SMART status other than Verified')
  if (/overall-health[^\n]*:\s*(?!PASSED)\S+/i.test(all))
    r.add('critical', 'Storage', 'smartctl reports a disk that is not PASSED')
  const cond = grab(/Condition:\s*(.+)/)
  if (cond) {
    r.metric('Battery condition', cond)
    if (!/Normal/i.test(cond)) r.add('warning', 'Power', `Battery condition is "${cond}"`)
  }
  const maxCap = grab(/Maximum Capacity:\s*(\d+)%/)
  if (maxCap) {
    r.metric('Battery max capacity', `${maxCap}%`)
    if (Number(maxCap) < THRESHOLDS.batteryHealthPctLow)
      r.add('warning', 'Power', `Battery maximum capacity is ${maxCap}%`)
  }
  const cap = grab(/capacity:\s*([\d.]+)%/)
  if (cap && Number(cap) < THRESHOLDS.batteryHealthPctLow)
    r.add('warning', 'Power', `Battery capacity is ${cap}% of design`)
  const load = grab(/^([\d.]+)\s+[\d.]+\s+[\d.]+\s+\d+\/\d+/m) || grab(/Load Avg:\s*([\d.]+)/)
  if (load) r.metric('Load (1m)', load)
  const cpuIdle = grab(/CPU usage:.*?([\d.]+)% idle/)
  if (cpuIdle) {
    const busy = Math.round((100 - Number(cpuIdle)) * 10) / 10
    r.metric('CPU', `${busy}%`)
    if (busy >= THRESHOLDS.cpuPctHigh) r.add('warning', 'Performance', `CPU is at ${busy}%`)
  }
  const pressure = grab(/System-wide memory free percentage:\s*(\d+)%/)
  if (pressure) {
    r.metric('Memory free', `${pressure}%`)
    if (Number(pressure) < 100 - THRESHOLDS.ramUsedPctHigh)
      r.add('warning', 'Performance', `Only ${pressure}% of memory is free`)
  }
  const psi = grab(/memory:\s*some avg10=([\d.]+)/)
  if (psi && Number(psi) > 10)
    r.add('warning', 'Performance', `Memory pressure stall avg10 is ${psi}%`)
  const extCount = all.split(/\r?\n/).filter((l) => /^[a-p]{32} \| /.test(l)).length
  if (has('phish-extensions')) r.metric('Chromium extensions', String(extCount))
  const proxyLines = all
    .split(/\r?\n/)
    .filter(
      (l) =>
        /^(HTTPProxy|HTTPSProxy|SOCKSProxy|ProxyAutoConfigURLString)\s*:/.test(l) ||
        /^(http|https|all)_proxy=/i.test(l)
    )
  if (proxyLines.length)
    r.add('warning', 'Network', `Proxy configured: ${proxyLines.slice(0, 2).join(' | ')}`)
  const hostsBlock = all.split('--- hosts overrides')[1]?.split('---')[0] ?? ''
  const hostsLines = hostsBlock
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) => l && !/^(#|broadcasthost|::1|127\.0\.0\.1\s+localhost|255\.255\.255\.255)/.test(l)
    )
  if (hostsLines.length)
    r.add(
      'warning',
      'Network',
      `${hostsLines.length} hosts-file override(s): ${hostsLines.slice(0, 3).join(' | ')}`
    )
}
