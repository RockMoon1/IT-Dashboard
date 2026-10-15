import type { CommandResult, Purpose, TargetOS } from '../../../shared/types.ts'
import { asArray, tryParseJson, type Json } from '../util/json.ts'

/**
 * Turns raw command output into (a) a short list of findings worth a technician's attention and
 * (b) a metrics table for the Obsidian hub entry. Every rule here is a threshold, not a verdict;
 * the raw output is kept in the session so the technician can check the reasoning.
 */

export interface Summary {
  findings: string[]
  metrics: Record<string, string>
}

// Thresholds. Kept in one place so they are easy to tune.
export const THRESHOLDS = {
  diskFreePctLow: 10,
  ramUsedPctHigh: 90,
  cpuPctHigh: 85,
  committedPctHigh: 90,
  diskQueueHigh: 2,
  uptimeDaysLong: 14,
  signatureAgeDaysStale: 7,
  updateAgeDaysStale: 45,
  batteryHealthPctLow: 60,
  ssdWearPctHigh: 80,
  startupItemsMany: 15,
  processCountMany: 300
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
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

function str(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function daysSince(iso: unknown, now: Date): number | null {
  const s = str(iso)
  if (!s) return null
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return null
  return (now.getTime() - t) / 86_400_000
}

function resultById(results: CommandResult[], id: string): CommandResult | undefined {
  return results.find((r) => r.id === id)
}

function jsonOf(results: CommandResult[], id: string): unknown {
  const r = resultById(results, id)
  if (!r || r.format !== 'json') return null
  return tryParseJson(r.stdout)
}

function textOf(results: CommandResult[], id: string): string {
  return resultById(results, id)?.stdout ?? ''
}

export function summarize(
  purpose: Purpose,
  os: TargetOS,
  results: CommandResult[],
  now: Date = new Date()
): Summary {
  const findings: string[] = []
  const metrics: Record<string, string> = {}

  for (const r of results) {
    if (r.timedOut)
      findings.push(`Command "${r.title}" timed out after ${Math.round(r.durationMs / 1000)}s`)
    else if (r.exitCode !== 0 && !r.optional)
      findings.push(`Command "${r.title}" failed (exit ${r.exitCode ?? 'n/a'})`)
  }

  if (os === 'windows') summarizeWindows(purpose, results, findings, metrics, now)
  else summarizePosix(purpose, results, findings, metrics)

  return { findings: dedupe(findings), metrics }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

function summarizeWindows(
  purpose: Purpose,
  results: CommandResult[],
  findings: string[],
  metrics: Record<string, string>,
  now: Date
): void {
  const problem = asArray(jsonOf(results, 'problem-devices'))
  if (resultById(results, 'problem-devices')) {
    metrics['Problem devices'] = String(problem.length)
    if (problem.length > 0) {
      const names = problem
        .slice(0, 3)
        .map((d) => `${str(d.FriendlyName) || str(d.InstanceId)} (${str(d.Status)})`)
        .join(', ')
      findings.push(`${problem.length} Plug and Play device(s) report a non-OK status: ${names}`)
    }
  }

  if (purpose === 'system-diagnostics') {
    const o = obj(jsonOf(results, 'sys-overview'))
    if (Object.keys(o).length) {
      metrics['OS'] = `${str(o.os)} ${str(o.version)} (${str(o.arch)})`.trim()
      metrics['Model'] = `${str(o.manufacturer)} ${str(o.model)}`.trim()
      metrics['CPU'] = `${str(o.cpu)} (${str(o.cores)}C/${str(o.logicalProcessors)}T)`
      const load = num(o.cpuLoadPct)
      if (load != null) metrics['CPU load'] = `${load}%`
      metrics['RAM'] = `${str(o.ramUsedPct)}% of ${str(o.ramTotalGB)} GB used`
      metrics['Uptime'] = `${str(o.uptimeHours)} h (since ${str(o.lastBoot)})`
      metrics['BIOS'] = `${str(o.biosVersion)} (${str(o.biosDate) || 'date n/a'})`
      metrics['Serial'] = str(o.serial)
      for (const d of asArray(o.disks)) {
        metrics[`Disk ${str(d.drive)}`] =
          `${str(d.freeGB)} GB free of ${str(d.sizeGB)} GB (${str(d.freePct)}%)`
      }
      checkDisks(asArray(o.disks), findings)
      checkRam(num(o.ramUsedPct), findings)
      checkUptime(num(o.uptimeHours), findings)
    }
    const th = obj(jsonOf(results, 'sys-thermal'))
    if (th.supported === true) {
      const zones = asArray(th.zones)
      const hottest = Math.max(...zones.map((z) => num(z.celsius) ?? -Infinity))
      if (Number.isFinite(hottest)) {
        metrics['Hottest ACPI zone'] = `${hottest} C`
        if (hottest >= 90) findings.push(`ACPI thermal zone at ${hottest} C`)
      }
    } else if (th.supported === false) {
      metrics['Thermal'] = 'not exposed by firmware'
    }
  }

  if (purpose === 'security-check') {
    const d = obj(jsonOf(results, 'sec-defender'))
    if (d.available === true) {
      metrics['Defender AV'] = d.antivirusEnabled === true ? 'enabled' : 'DISABLED'
      metrics['Real-time protection'] = d.realTimeProtectionEnabled === true ? 'on' : 'OFF'
      metrics['Signature age'] = `${str(d.signatureAgeDays)} day(s)`
      metrics['Tamper protection'] = d.tamperProtected === true ? 'on' : 'off'
      if (d.antivirusEnabled !== true) findings.push('Microsoft Defender antivirus is disabled')
      if (d.realTimeProtectionEnabled !== true)
        findings.push('Defender real-time protection is off')
      const age = num(d.signatureAgeDays)
      if (age != null && age > THRESHOLDS.signatureAgeDaysStale)
        findings.push(`Defender signatures are ${age} days old`)
    } else if (d.available === false) {
      metrics['Defender AV'] = 'not available (third-party AV or Server without Defender module)'
    }
    const av = asArray(jsonOf(results, 'sec-av-products'))
    if (av.length) {
      metrics['AV products'] = av
        .map((p) => `${str(p.name)}${p.enabled ? '' : ' (disabled)'}`)
        .join('; ')
      for (const p of av) {
        if (p.enabled === false)
          findings.push(`Antivirus "${str(p.name)}" is registered but disabled`)
        if (p.upToDate === false)
          findings.push(`Antivirus "${str(p.name)}" reports out-of-date definitions`)
      }
    } else if (resultById(results, 'sec-av-products') && d.available !== true) {
      findings.push('No antivirus product registered with Security Center')
    }
    const fw = asArray(jsonOf(results, 'sec-firewall'))
    if (fw.length) {
      metrics['Firewall'] = fw.map((p) => `${str(p.Name)}: ${str(p.Enabled)}`).join(', ')
      for (const p of fw) {
        if (str(p.Enabled).toLowerCase() === 'false')
          findings.push(`Firewall profile "${str(p.Name)}" is disabled`)
      }
    }
    const up = obj(jsonOf(results, 'sec-updates'))
    const hot = asArray(up.hotfixes)
    const latest = hot[0]
    if (latest) {
      metrics['Latest hotfix'] = `${str(latest.HotFixID)} on ${str(latest.InstalledOn)}`
      const age = daysSince(latest.InstalledOn, now)
      if (age != null && age > THRESHOLDS.updateAgeDaysStale) {
        findings.push(
          `No Windows update installed for ${Math.round(age)} days (latest ${str(latest.HotFixID)})`
        )
      }
    } else if (Object.keys(up).length) {
      findings.push('Get-HotFix returned no dated updates')
    }
    if (up.lastInstallSuccess) metrics['WU last install'] = str(up.lastInstallSuccess)
    if (up.rebootPending === true) findings.push('A reboot is pending to finish servicing/updates')
    const bl = obj(jsonOf(results, 'sec-bitlocker'))
    if (bl.available === true) {
      const vols = asArray(bl.volumes)
      metrics['BitLocker'] =
        vols.map((v) => `${str(v.MountPoint)} ${str(v.ProtectionStatus)}`).join(', ') ||
        'no volumes'
      for (const v of vols) {
        if (str(v.VolumeType) === 'OperatingSystem' && str(v.ProtectionStatus) !== 'On') {
          findings.push(
            `BitLocker protection is ${str(v.ProtectionStatus) || 'off'} on the OS volume ${str(v.MountPoint)}`
          )
        }
      }
    } else if (bl.available === false) {
      metrics['BitLocker'] = 'not readable (needs admin)'
    }
    const pol = obj(jsonOf(results, 'sec-policies'))
    if (Object.keys(pol).length) {
      metrics['UAC'] = pol.uacEnabled === true ? 'enabled' : 'DISABLED'
      metrics['RDP'] = pol.rdpEnabled === true ? 'enabled' : 'disabled'
      if (pol.secureBoot != null) metrics['Secure Boot'] = pol.secureBoot === true ? 'on' : 'off'
      if (pol.uacEnabled !== true) findings.push('User Account Control is disabled')
      if (pol.smb1Enabled === true) findings.push('SMBv1 server protocol is enabled')
      if (pol.secureBoot === false) findings.push('Secure Boot is off')
      if (str(pol.smartScreenExplorer).toLowerCase() === 'off' || pol.smartScreenPolicy === 0) {
        findings.push('SmartScreen for apps and files is turned off')
      }
    }
  }

  if (purpose === 'email-setup') {
    const m = obj(jsonOf(results, 'mail-outlook'))
    if (Object.keys(m).length) {
      metrics['Evaluated as'] = str(m.evaluatedAs)
      metrics['Classic Outlook'] =
        m.classicOutlookInstalled === true
          ? `installed${m.outlookRunning ? ', running' : ''}`
          : 'not installed'
      metrics['New Outlook'] = m.newOutlookInstalled === true ? 'installed' : 'not installed'
      metrics['M365 apps'] = m.m365Products
        ? `${str(m.m365Products)} ${str(m.m365Version)}`.trim()
        : 'not detected'
      const profiles = asArray<string>(m.profiles)
      metrics['Outlook profiles'] = profiles.length ? profiles.join(', ') : 'none'
      const ost = asArray(m.ostFiles)
      if (ost.length)
        metrics['OST files'] = ost.map((o) => `${str(o.name)} ${str(o.sizeGB)} GB`).join(', ')
      if (m.classicOutlookInstalled !== true && m.newOutlookInstalled !== true)
        findings.push('No Outlook client installed')
      if (m.classicOutlookInstalled === true && profiles.length === 0) {
        findings.push('Classic Outlook is installed but the evaluated account has no mail profile')
      }
      for (const o of ost) {
        const gb = num(o.sizeGB)
        if (gb != null && gb > 40)
          findings.push(
            `OST file ${str(o.name)} is ${gb} GB (performance and sync risk above ~50 GB)`
          )
      }
    }
    const conn = asArray(jsonOf(results, 'mail-connectivity'))
    if (conn.length) {
      const down = conn.filter((c) => c.reachable !== true)
      metrics['M365 endpoints'] = `${conn.length - down.length}/${conn.length} reachable`
      for (const c of down)
        findings.push(`Cannot reach ${str(c.host)}:${str(c.port)} from the device`)
    }
  }

  if (purpose === 'hardware-issues') {
    const hd = obj(jsonOf(results, 'hw-disks'))
    const disks = asArray(hd.disks)
    for (const d of disks) {
      const label = `Disk "${str(d.name)}"`
      const parts = [str(d.health), `${str(d.sizeGB)} GB`, str(d.media)]
      if (d.temperatureC != null) parts.push(`${str(d.temperatureC)} C`)
      if (d.wearPct != null) parts.push(`wear ${str(d.wearPct)}%`)
      metrics[label] = parts.filter(Boolean).join(', ')
      if (str(d.health) && str(d.health) !== 'Healthy')
        findings.push(`${label} health is ${str(d.health)}`)
      const wear = num(d.wearPct)
      if (wear != null && wear >= THRESHOLDS.ssdWearPctHigh)
        findings.push(`${label} reports ${wear}% wear`)
      const re = num(d.readErrorsTotal)
      const we = num(d.writeErrorsTotal)
      if ((re ?? 0) > 0 || (we ?? 0) > 0)
        findings.push(`${label} has ${re ?? 0} read / ${we ?? 0} write errors`)
    }
    for (const s of asArray(hd.smart)) {
      if (s.predictFailure === true) findings.push(`SMART predicts failure for ${str(s.instance)}`)
    }
    const b = obj(jsonOf(results, 'hw-battery'))
    if (b.present === true) {
      const health = num(b.healthPct)
      metrics['Battery'] =
        `${health != null ? `${health}% health` : 'health n/a'}, ${str(b.chargePct)}% charge${b.cycleCount != null ? `, ${str(b.cycleCount)} cycles` : ''}`
      if (health != null && health < THRESHOLDS.batteryHealthPctLow)
        findings.push(`Battery health is ${health}% of design capacity`)
    } else if (b.present === false) {
      metrics['Battery'] = 'none (desktop)'
    }
    const errText = textOf(results, 'hw-system-errors')
    if (errText && !errText.startsWith('No critical/error events')) {
      const count = errText
        .split(/\r?\n/)
        .filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l.trim())).length
      metrics['System log errors (7d)'] = String(count)
      if (count >= 20) findings.push(`${count}+ critical/error events in the System log in 7 days`)
    } else if (errText) {
      metrics['System log errors (7d)'] = '0'
    }
  }

  if (purpose === 'slow-performance') {
    const r = obj(jsonOf(results, 'perf-resources'))
    if (Object.keys(r).length) {
      const cpu = num(r.cpuPct)
      if (cpu != null) metrics['CPU'] = `${cpu}%`
      metrics['RAM'] = `${str(r.ramUsedPct)}% of ${str(r.ramTotalGB)} GB`
      if (r.committedPct != null) metrics['Committed memory'] = `${str(r.committedPct)}%`
      if (r.diskQueueLength != null) metrics['Disk queue'] = str(r.diskQueueLength)
      if (r.diskTimePct != null) metrics['Disk time'] = `${str(r.diskTimePct)}%`
      metrics['Processes'] = str(r.processCount)
      metrics['Uptime'] = `${str(r.uptimeHours)} h`
      if (cpu != null && cpu >= THRESHOLDS.cpuPctHigh)
        findings.push(`CPU is at ${cpu}% (3 s average)`)
      checkRam(num(r.ramUsedPct), findings)
      const committed = num(r.committedPct)
      if (committed != null && committed >= THRESHOLDS.committedPctHigh)
        findings.push(`Committed memory at ${committed}% (page file pressure)`)
      const q = num(r.diskQueueLength)
      if (q != null && q >= THRESHOLDS.diskQueueHigh)
        findings.push(`Disk queue length ${q} (storage bottleneck)`)
      const pc = num(r.processCount)
      if (pc != null && pc >= THRESHOLDS.processCountMany) findings.push(`${pc} processes running`)
      checkUptime(num(r.uptimeHours), findings)
      checkDisks(asArray(r.disks), findings)
    }
    const top = obj(jsonOf(results, 'perf-top-processes'))
    const byCpu = asArray(top.byCpu)
    if (byCpu.length)
      metrics['Top CPU'] = byCpu
        .slice(0, 3)
        .map((p) => `${str(p.Name)} (${str(p.cpuSeconds)} s)`)
        .join(', ')
    const byMem = asArray(top.byMemory)
    if (byMem.length)
      metrics['Top memory'] = byMem
        .slice(0, 3)
        .map((p) => `${str(p.Name)} (${str(p.workingSetMB)} MB)`)
        .join(', ')
    const startup = asArray(jsonOf(results, 'perf-startup'))
    if (resultById(results, 'perf-startup')) {
      metrics['Startup items'] = String(startup.length)
      if (startup.length >= THRESHOLDS.startupItemsMany)
        findings.push(`${startup.length} startup programs`)
    }
  }

  if (purpose === 'phishing-assessment') {
    const exts = asArray(jsonOf(results, 'phish-extensions'))
    if (resultById(results, 'phish-extensions')) {
      metrics['Browser extensions'] = String(exts.length)
      const broad = exts.filter((e) =>
        asArray<string>(e.permissions).some((p) => BROAD_EXTENSION_PERMISSIONS.includes(str(p)))
      )
      if (broad.length) {
        findings.push(
          `${broad.length} extension(s) hold broad permissions: ${broad
            .slice(0, 4)
            .map((e) => `${str(e.name) || str(e.id)} [${str(e.browser)}]`)
            .join(', ')}`
        )
      }
    }
    const s = obj(jsonOf(results, 'phish-settings'))
    if (Object.keys(s).length) {
      metrics['Evaluated as'] = str(s.evaluatedAs)
      metrics['SmartScreen (Explorer)'] = str(s.smartScreenExplorer) || 'default'
      if (s.defenderPuaProtection != null)
        metrics['Defender PUA'] =
          s.defenderPuaProtection === 1 ? 'block' : s.defenderPuaProtection === 2 ? 'audit' : 'off'
      if (s.defenderNetworkProtection != null)
        metrics['Network protection'] =
          s.defenderNetworkProtection === 1
            ? 'block'
            : s.defenderNetworkProtection === 2
              ? 'audit'
              : 'off'
      if (str(s.smartScreenExplorer).toLowerCase() === 'off' || s.smartScreenPolicy === 0)
        findings.push('SmartScreen for apps and files is turned off')
      if (s.defenderPuaProtection === 0)
        findings.push('Defender potentially-unwanted-app blocking is off')
      if (s.defenderNetworkProtection === 0) findings.push('Defender network protection is off')
      if (s.wordVbaWarnings === 1)
        findings.push('Word is configured to enable all macros (VBAWarnings=1)')
      if (s.outlookBlockExternalContent === 0)
        findings.push('Outlook downloads external content in HTML mail automatically')
    }
    const n = obj(jsonOf(results, 'phish-network'))
    if (Object.keys(n).length) {
      metrics['Proxy'] =
        n.proxyEnabled === true
          ? `enabled (${str(n.proxyServer)})`
          : n.autoConfigUrl
            ? `PAC ${str(n.autoConfigUrl)}`
            : 'none'
      const hosts = asArray<string>(n.hostsEntries)
      metrics['hosts overrides'] = String(hosts.length)
      const dns = asArray(n.dns)
      if (dns.length)
        metrics['DNS'] = dns
          .map((d) => `${str(d.interface)}: ${asArray<string>(d.servers).join(' ')}`)
          .join('; ')
      if (n.proxyEnabled === true)
        findings.push(`A manual proxy is configured: ${str(n.proxyServer)}`)
      if (n.autoConfigUrl) findings.push(`A proxy auto-config URL is set: ${str(n.autoConfigUrl)}`)
      if (hosts.length)
        findings.push(
          `${hosts.length} non-default hosts-file entries (possible pharming): ${hosts.slice(0, 3).join(' | ')}`
        )
    }
    const rules = textOf(results, 'phish-outlook-rules')
    const forwarders = rules.split(/\r?\n/).filter((l) => /FORWARD|REDIRECT/.test(l))
    if (forwarders.length)
      findings.push(
        `${forwarders.length} Outlook rule(s) forward or redirect mail: ${forwarders.slice(0, 2).join(' | ')}`
      )
    const dl = textOf(results, 'phish-downloads')
    if (dl && !dl.startsWith('No executable')) {
      const rows = dl.split(/\r?\n/).filter((l) => /\d{4}-\d{2}-\d{2}T/.test(l))
      metrics['Risky downloads (14d)'] = String(rows.length)
      if (rows.length)
        findings.push(`${rows.length} executable/script/archive download(s) in the last 14 days`)
    }
  }
}

function summarizePosix(
  purpose: Purpose,
  results: CommandResult[],
  findings: string[],
  metrics: Record<string, string>
): void {
  const all = results.map((r) => r.stdout).join('\n')
  const grab = (re: RegExp): string => {
    const m = all.match(re)
    return m?.[1]?.trim() ?? ''
  }

  if (purpose === 'system-diagnostics') {
    const product =
      grab(/ProductName:\s*(.+)/) ||
      grab(/PRETTY_NAME="?([^"\n]+)/) ||
      grab(/Operating System:\s*(.+)/)
    if (product) metrics['OS'] = `${product} ${grab(/ProductVersion:\s*(.+)/)}`.trim()
    const cpu = grab(/cpu:\s*(.+)/) || grab(/Model name:\s*(.+)/)
    if (cpu) metrics['CPU'] = cpu
    const mem = grab(/memory_gb:\s*(\d+)/)
    if (mem) metrics['RAM'] = `${mem} GB`
    const memLine = all.match(/^Mem:\s+(\S+)\s+(\S+)/m)
    if (memLine) metrics['RAM'] = `${memLine[2]} used of ${memLine[1]}`
    for (const m of all.matchAll(/^(\/dev\/\S+|\S+)\s+\S+\s+\S+\s+\S+\s+(\d+)%\s+(\/\S*)$/gm)) {
      const pct = Number(m[2])
      const mount = m[3] ?? ''
      if (mount === '/' || mount === '/System/Volumes/Data' || mount === '/home') {
        metrics[`Disk ${mount}`] = `${100 - pct}% free`
        if (100 - pct < THRESHOLDS.diskFreePctLow)
          findings.push(`Filesystem ${mount} has only ${100 - pct}% free`)
      }
    }
  }

  if (purpose === 'security-check') {
    const gk = grab(/gatekeeper:\s*(.+)/)
    if (gk) {
      metrics['Gatekeeper'] = gk
      if (/disabled/i.test(gk)) findings.push('Gatekeeper assessments are disabled')
    }
    const fw = grab(/app_firewall:\s*(.+)/)
    if (fw) {
      metrics['Application firewall'] = fw
      if (/disabled|State = 0/i.test(fw)) findings.push('macOS application firewall is disabled')
    }
    const fv = grab(/filevault:\s*(.+)/)
    if (fv) {
      metrics['FileVault'] = fv
      if (/Off/i.test(fv)) findings.push('FileVault disk encryption is off')
    }
    const sip = grab(/sip:\s*(.+)/)
    if (sip && /disabled/i.test(sip)) findings.push('System Integrity Protection is disabled')
    if (/Status:\s*inactive/i.test(all) || /^Status: inactive/m.test(all))
      findings.push('ufw firewall is inactive')
    if (/firewall-cmd[^\n]*\n\s*not running/i.test(all) || /^not running$/m.test(all))
      findings.push('firewalld is not running')
    if (/^\s*PermitRootLogin\s+yes/im.test(all))
      findings.push('sshd permits root login with PermitRootLogin yes')
    if (/^\s*PasswordAuthentication\s+yes/im.test(all))
      findings.push('sshd allows password authentication')
    if (/REBOOT REQUIRED/.test(all)) findings.push('A reboot is required to finish package updates')
    const upgradable = all.split(/\r?\n/).filter((l) => /\[upgradable from/.test(l)).length
    if (upgradable) {
      metrics['Upgradable packages'] = String(upgradable)
      if (upgradable >= 20) findings.push(`${upgradable} packages have pending updates`)
    }
  }

  if (purpose === 'email-setup') {
    const down = all.split(/\r?\n/).filter((l) => /UNREACHABLE/.test(l))
    const up = all.split(/\r?\n/).filter((l) => / reachable$/.test(l))
    if (up.length + down.length)
      metrics['M365 endpoints'] = `${up.length}/${up.length + down.length} reachable`
    for (const d of down)
      findings.push(`Cannot reach ${d.replace(' UNREACHABLE', '')} from the device`)
  }

  if (purpose === 'hardware-issues') {
    if (/SMART Status:\s*(?!Verified)/.test(all))
      findings.push('A disk reports a SMART status other than Verified')
    if (/overall-health[^\n]*:\s*(?!PASSED)\S+/i.test(all))
      findings.push('smartctl reports a disk that is not PASSED')
    const cond = grab(/Condition:\s*(.+)/)
    if (cond) {
      metrics['Battery condition'] = cond
      if (!/Normal/i.test(cond)) findings.push(`Battery condition is "${cond}"`)
    }
    const maxCap = grab(/Maximum Capacity:\s*(\d+)%/)
    if (maxCap) {
      metrics['Battery max capacity'] = `${maxCap}%`
      if (Number(maxCap) < THRESHOLDS.batteryHealthPctLow)
        findings.push(`Battery maximum capacity is ${maxCap}%`)
    }
    const cap = grab(/capacity:\s*([\d.]+)%/)
    if (cap && Number(cap) < THRESHOLDS.batteryHealthPctLow)
      findings.push(`Battery capacity is ${cap}% of design`)
  }

  if (purpose === 'slow-performance') {
    const load = grab(/^([\d.]+)\s+[\d.]+\s+[\d.]+\s+\d+\/\d+/m) || grab(/Load Avg:\s*([\d.]+)/)
    if (load) metrics['Load (1m)'] = load
    const cpuIdle = grab(/CPU usage:.*?([\d.]+)% idle/)
    if (cpuIdle) {
      const busy = Math.round((100 - Number(cpuIdle)) * 10) / 10
      metrics['CPU'] = `${busy}%`
      if (busy >= THRESHOLDS.cpuPctHigh) findings.push(`CPU is at ${busy}%`)
    }
    const pressure = grab(/System-wide memory free percentage:\s*(\d+)%/)
    if (pressure) {
      metrics['Memory free'] = `${pressure}%`
      if (Number(pressure) < 100 - THRESHOLDS.ramUsedPctHigh)
        findings.push(`Only ${pressure}% of memory is free`)
    }
    const memLine = all.match(/^Mem:\s+(\S+)\s+(\S+)/m)
    if (memLine) metrics['RAM'] = `${memLine[2]} used of ${memLine[1]}`
    const psi = grab(/memory:\s*some avg10=([\d.]+)/)
    if (psi && Number(psi) > 10) findings.push(`Memory pressure stall avg10 is ${psi}%`)
  }

  if (purpose === 'phishing-assessment') {
    const gk = grab(/gatekeeper:\s*(.+)/)
    if (gk && /disabled/i.test(gk)) findings.push('Gatekeeper assessments are disabled')
    const extCount = all.split(/\r?\n/).filter((l) => /^[a-p]{32} \| /.test(l)).length
    if (resultById(results, 'phish-extensions')) metrics['Chromium extensions'] = String(extCount)
    const proxyLines = all
      .split(/\r?\n/)
      .filter(
        (l) =>
          /^(HTTPProxy|HTTPSProxy|SOCKSProxy|ProxyAutoConfigURLString)\s*:/.test(l) ||
          /^(http|https|all)_proxy=/i.test(l)
      )
    if (proxyLines.length) findings.push(`Proxy configured: ${proxyLines.slice(0, 2).join(' | ')}`)
    const hostsBlock = all.split('--- hosts overrides')[1]?.split('---')[0] ?? ''
    const hostsLines = hostsBlock
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) => l && !/^(#|broadcasthost|::1|127\.0\.0\.1\s+localhost|255\.255\.255\.255)/.test(l)
      )
    if (hostsLines.length)
      findings.push(
        `${hostsLines.length} hosts-file override(s): ${hostsLines.slice(0, 3).join(' | ')}`
      )
  }
}

function checkDisks(disks: Json[], findings: string[]): void {
  for (const d of disks) {
    const free = num(d.freePct)
    if (free != null && free < THRESHOLDS.diskFreePctLow) {
      findings.push(
        `Disk ${str(d.drive)} has only ${free}% free${d.freeGB != null ? ` (${str(d.freeGB)} GB)` : ''}`
      )
    }
  }
}

function checkRam(usedPct: number | null, findings: string[]): void {
  if (usedPct != null && usedPct >= THRESHOLDS.ramUsedPctHigh)
    findings.push(`RAM usage is ${usedPct}%`)
}

function checkUptime(hours: number | null, findings: string[]): void {
  if (hours != null && hours >= THRESHOLDS.uptimeDaysLong * 24) {
    findings.push(`Uptime is ${Math.round(hours / 24)} days; a restart is overdue`)
  }
}
