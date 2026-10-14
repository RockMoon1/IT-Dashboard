import { createConnection } from 'node:net'
import type { ProbeResult, Protocol, TargetOS } from '../../../shared/types.ts'

/**
 * Lightweight TCP probe used to propose a remoting protocol and guess the target OS.
 * Heuristics only: the technician can override the OS in the UI.
 */

export const PORTS = {
  ssh: 22,
  winrmHttp: 5985,
  winrmHttps: 5986,
  rdp: 3389,
  smb: 445
} as const

export const DEFAULT_PROBE_PORTS: number[] = [
  PORTS.ssh,
  PORTS.winrmHttp,
  PORTS.winrmHttps,
  PORTS.rdp,
  PORTS.smb
]

export interface PortCheck {
  port: number
  open: boolean
  banner?: string
}

export function checkPort(
  host: string,
  port: number,
  timeoutMs = 2000,
  bannerWaitMs = 1500
): Promise<PortCheck> {
  return new Promise((resolve) => {
    let settled = false
    let banner = ''
    const socket = createConnection({ host, port })
    const done = (open: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ port, open, banner: banner.trim() || undefined })
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('error', () => done(false))
    socket.once('connect', () => {
      if (port !== PORTS.ssh) {
        done(true)
        return
      }
      socket.setEncoding('utf8')
      const bannerTimer = setTimeout(() => done(true), bannerWaitMs)
      socket.on('data', (chunk: string) => {
        banner += chunk
        if (banner.includes('\n')) {
          clearTimeout(bannerTimer)
          done(true)
        }
      })
    })
  })
}

export interface OsGuess {
  os: TargetOS
  hint: string
  suggestedProtocol: Protocol | null
}

/** Decides OS and protocol from open ports and the SSH banner. Exported for tests. */
export function inferOs(openPorts: number[], banner?: string): OsGuess {
  const has = (p: number): boolean => openPorts.includes(p)
  const winrm = has(PORTS.winrmHttp) || has(PORTS.winrmHttps)
  const ssh = has(PORTS.ssh)
  const b = (banner ?? '').trim()

  if (/windows/i.test(b)) {
    return {
      os: 'windows',
      hint: `OpenSSH for Windows banner (${b})`,
      suggestedProtocol: winrm ? 'winrm' : 'ssh'
    }
  }
  const distro =
    /ubuntu|debian|raspbian|fedora|centos|rhel|red ?hat|suse|alpine|arch|rocky|alma|amzn|amazon/i.exec(
      b
    )
  if (distro) {
    return { os: 'linux', hint: `SSH banner names ${distro[0]} (${b})`, suggestedProtocol: 'ssh' }
  }
  if (winrm) {
    return {
      os: 'windows',
      hint: `WinRM port ${has(PORTS.winrmHttps) ? '5986' : '5985'} open`,
      suggestedProtocol: 'winrm'
    }
  }
  if ((has(PORTS.rdp) || has(PORTS.smb)) && !ssh) {
    return {
      os: 'windows',
      hint: `RDP/SMB open but WinRM closed; run Enable-PSRemoting -Force on the target`,
      suggestedProtocol: null
    }
  }
  if (ssh) {
    return {
      os: 'unknown',
      hint: b
        ? `SSH available (${b}); macOS or Linux, choose the OS`
        : 'SSH available; macOS or Linux, choose the OS',
      suggestedProtocol: 'ssh'
    }
  }
  return { os: 'unknown', hint: 'No remoting ports open (22, 5985, 5986)', suggestedProtocol: null }
}

export async function probeHost(
  host: string,
  opts: { timeoutMs?: number; ports?: number[] } = {}
): Promise<ProbeResult> {
  const started = Date.now()
  const ports = opts.ports ?? DEFAULT_PROBE_PORTS
  const checks = await Promise.all(ports.map((p) => checkPort(host, p, opts.timeoutMs ?? 2000)))
  const openPorts = checks.filter((c) => c.open).map((c) => c.port)
  const sshBanner = checks.find((c) => c.port === PORTS.ssh && c.open)?.banner
  const guess = inferOs(openPorts, sshBanner)
  return {
    host,
    reachable: openPorts.length > 0,
    openPorts,
    sshBanner,
    os: guess.os,
    osHint: guess.hint,
    suggestedProtocol: guess.suggestedProtocol,
    durationMs: Date.now() - started
  }
}

export function protocolsFromProbe(probe: ProbeResult): Protocol[] {
  const out: Protocol[] = []
  if (probe.openPorts.includes(PORTS.winrmHttp) || probe.openPorts.includes(PORTS.winrmHttps))
    out.push('winrm')
  if (probe.openPorts.includes(PORTS.ssh)) out.push('ssh')
  return out
}
