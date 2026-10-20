import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import tls from 'node:tls'
import type { DeviceCapabilities, DevicePolicy } from '../../../shared/types.ts'
import type { DeviceStore, EnrolledDevice } from './devices.ts'
import { normalizeOs } from './devices.ts'
import { encode, LineSplitter, type LinkMessage } from './ndjson.ts'
import { proof, type TokenStore } from './tokens.ts'

/**
 * The host side of docs/PROTOCOL.md: a TLS 1.3 server that requests a client certificate,
 * identifies devices by that certificate's fingerprint, performs enrollment with the one-time
 * token proof, and relays scan messages to whoever listens.
 */

export const DEFAULT_LINK_PORT = 47912
const PING_EVERY_MS = 20_000
const IDLE_TIMEOUT_MS = 60_000
const ENROLL_STEP_TIMEOUT_MS = 30_000

export interface LinkServerOptions {
  certPem: string
  keyPem: string
  hostFingerprint: string
  hostId: string
  devices: DeviceStore
  tokens: TokenStore
  port?: number
  log?: (line: string) => void
  now?: () => Date
}

export interface ConnectedDevice {
  device: EnrolledDevice
  address: string
  connectedAt: string
}

export type LinkEvent =
  | { type: 'connected'; device: EnrolledDevice; address: string }
  | { type: 'disconnected'; deviceId: string; reason: string }
  | { type: 'enrolled'; device: EnrolledDevice; address: string }
  | { type: 'rejected'; fingerprint: string; address: string; reason: string }
  | { type: 'message'; deviceId: string; message: LinkMessage }
  | { type: 'capabilities'; deviceId: string; capabilities: DeviceCapabilities }
  | { type: 'listening'; port: number }

function policyOf(v: unknown): DevicePolicy | null {
  if (!v || typeof v !== 'object') return null
  const p = v as Record<string, unknown>
  const flag = (k: string): boolean => p[k] === true
  return {
    write: flag('write'),
    execute: flag('execute'),
    custom: flag('custom'),
    lan: flag('lan'),
    interrupts: flag('interrupts'),
    deny: Array.isArray(p['deny'])
      ? p['deny'].filter((x): x is string => typeof x === 'string')
      : [],
    error: typeof p['error'] === 'string' && p['error'] ? p['error'] : undefined
  }
}

/** Reads the protocol-2 fields of hello or enroll. An older agent reports none: read only. */
export function capabilitiesOf(m: LinkMessage): DeviceCapabilities {
  const protocol = typeof m['protocol'] === 'number' ? m['protocol'] : 1
  const link = m['link'] === 'cable' || m['link'] === 'lan' ? m['link'] : 'unknown'
  const actions = (Array.isArray(m['actions']) ? m['actions'] : [])
    .map((a) => (a ?? {}) as Record<string, unknown>)
    .filter(
      (a) =>
        typeof a['name'] === 'string' &&
        typeof a['version'] === 'number' &&
        typeof a['sha256'] === 'string'
    )
    .map((a) => ({
      name: a['name'] as string,
      version: a['version'] as number,
      sha256: a['sha256'] as string
    }))
  const str = (k: string): string | undefined =>
    typeof m[k] === 'string' && m[k] ? (m[k] as string) : undefined
  return {
    protocol,
    link,
    bootTime: str('bootTime'),
    actions: protocol >= 2 ? actions : [],
    policy: protocol >= 2 ? policyOf(m['policy']) : null,
    running: str('running'),
    pendingRestartUntil: str('pendingRestartUntil')
  }
}

export function fingerprintOf(socket: tls.TLSSocket): string | null {
  const cert = socket.getPeerCertificate(false)
  if (!cert || !('raw' in cert) || !cert.raw) return null
  return createHash('sha256').update(cert.raw).digest('hex')
}

interface Session {
  socket: tls.TLSSocket
  address: string
  fingerprint: string
  deviceId: string | null
  lastSeen: number
  pingTimer?: ReturnType<typeof setInterval>
  idleTimer?: ReturnType<typeof setTimeout>
  stepTimer?: ReturnType<typeof setTimeout>
  state: 'new' | 'enrolling' | 'active'
  caps?: DeviceCapabilities
  pendingEnroll?: {
    token: string
    label?: string
    serial: string
    hostname: string
    os: EnrolledDevice['os']
    agentVersion: string
    profiles: EnrolledDevice['profiles']
  }
}

export class LinkServer extends EventEmitter {
  private opts: LinkServerOptions
  private server: tls.Server | null = null
  private sessions = new Map<tls.TLSSocket, Session>()
  private byDevice = new Map<string, Session>()
  port = 0

  constructor(opts: LinkServerOptions) {
    super()
    this.opts = opts
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }

  private emitEvent(e: LinkEvent): void {
    this.emit('event', e)
  }

  onEvent(cb: (e: LinkEvent) => void): () => void {
    this.on('event', cb)
    return () => this.off('event', cb)
  }

  async start(): Promise<number> {
    const server = tls.createServer(
      {
        cert: this.opts.certPem,
        key: this.opts.keyPem,
        requestCert: true,
        rejectUnauthorized: false, // identity is checked by fingerprint, not by a CA
        minVersion: 'TLSv1.3',
        handshakeTimeout: 15_000
      },
      (socket) => this.accept(socket)
    )
    this.server = server
    server.on('tlsClientError', (err, socket) => {
      this.log(`tls handshake failed from ${socket?.remoteAddress ?? '?'}: ${err.message}`)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.port ?? DEFAULT_LINK_PORT, '0.0.0.0', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const addr = server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : (this.opts.port ?? DEFAULT_LINK_PORT)
    this.emitEvent({ type: 'listening', port: this.port })
    return this.port
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) this.close(s, 'server stopping')
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    )
    this.server = null
  }

  connected(): ConnectedDevice[] {
    const out: ConnectedDevice[] = []
    for (const s of this.byDevice.values()) {
      const device = s.deviceId ? this.opts.devices.get(s.deviceId) : undefined
      if (device)
        out.push({ device, address: s.address, connectedAt: new Date(s.lastSeen).toISOString() })
    }
    return out
  }

  isConnected(deviceId: string): boolean {
    return this.byDevice.has(deviceId)
  }

  /** What the connected agent reported; undefined while it is not connected. */
  capabilities(deviceId: string): DeviceCapabilities | undefined {
    return this.byDevice.get(deviceId)?.caps
  }

  send(deviceId: string, message: LinkMessage): boolean {
    const s = this.byDevice.get(deviceId)
    if (!s || s.socket.destroyed) return false
    s.socket.write(encode(message))
    return true
  }

  private write(s: Session, message: LinkMessage): void {
    if (!s.socket.destroyed) s.socket.write(encode(message))
  }

  private accept(socket: tls.TLSSocket): void {
    const fingerprint = fingerprintOf(socket)
    const address = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`
    if (!fingerprint) {
      this.log(`connection from ${address} without a client certificate; closing`)
      socket.write(encode({ type: 'reject', reason: 'no client certificate' }))
      socket.destroy()
      return
    }
    const session: Session = {
      socket,
      address,
      fingerprint,
      deviceId: null,
      lastSeen: Date.now(),
      state: 'new'
    }
    this.sessions.set(socket, session)
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    const splitter = new LineSplitter(
      (m) => this.handle(session, m),
      (err) => this.close(session, `protocol error: ${err.message}`)
    )
    socket.on('data', (chunk: string) => {
      session.lastSeen = Date.now()
      this.armIdle(session)
      splitter.push(chunk)
    })
    socket.on('error', (err) => this.close(session, err.message))
    socket.on('close', () => this.close(session, 'socket closed'))
    this.armIdle(session)
    session.stepTimer = setTimeout(() => {
      if (session.state === 'new') this.close(session, 'no hello within 30 s')
    }, ENROLL_STEP_TIMEOUT_MS)
  }

  private armIdle(s: Session): void {
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.idleTimer = setTimeout(() => this.close(s, 'idle timeout'), IDLE_TIMEOUT_MS)
  }

  private close(s: Session, reason: string): void {
    if (!this.sessions.has(s.socket)) return
    this.sessions.delete(s.socket)
    if (s.pingTimer) clearInterval(s.pingTimer)
    if (s.idleTimer) clearTimeout(s.idleTimer)
    if (s.stepTimer) clearTimeout(s.stepTimer)
    if (!s.socket.destroyed) s.socket.destroy()
    if (s.deviceId && this.byDevice.get(s.deviceId) === s) {
      this.byDevice.delete(s.deviceId)
      this.emitEvent({ type: 'disconnected', deviceId: s.deviceId, reason })
      this.log(`device ${s.deviceId.slice(0, 16)} disconnected: ${reason}`)
    }
  }

  private activate(s: Session, device: EnrolledDevice): void {
    s.state = 'active'
    s.deviceId = device.id
    if (s.stepTimer) clearTimeout(s.stepTimer)
    const previous = this.byDevice.get(device.id)
    if (previous && previous !== s) this.close(previous, 'replaced by a new connection')
    this.byDevice.set(device.id, s)
    s.pingTimer = setInterval(() => this.write(s, { type: 'ping' }), PING_EVERY_MS)
    void this.opts.devices.touch(device.id, {
      lastSeen: (this.opts.now?.() ?? new Date()).toISOString()
    })
  }

  private handle(s: Session, m: LinkMessage): void {
    switch (s.state) {
      case 'new':
        if (m.type === 'hello') this.handleHello(s, m)
        else if (m.type === 'enroll') this.handleEnroll(s, m)
        else this.close(s, `expected hello or enroll, got ${m.type}`)
        return
      case 'enrolling':
        if (m.type === 'enroll-confirm') void this.finishEnroll(s)
        else this.close(s, `expected enroll-confirm, got ${m.type}`)
        return
      case 'active':
        if (m.type === 'ping') {
          this.write(s, { type: 'pong' })
          return
        }
        if (m.type === 'pong') return
        if (m.type === 'policy' && s.caps && s.deviceId) {
          s.caps = { ...s.caps, policy: policyOf(m['policy']) }
          this.emitEvent({ type: 'capabilities', deviceId: s.deviceId, capabilities: s.caps })
          return
        }
        if (m.type === 'state' && s.caps && s.deviceId) {
          const until = m['pendingRestartUntil']
          s.caps = {
            ...s.caps,
            pendingRestartUntil: typeof until === 'string' && until ? until : undefined
          }
          this.emitEvent({ type: 'capabilities', deviceId: s.deviceId, capabilities: s.caps })
          return
        }
        if (s.deviceId) this.emitEvent({ type: 'message', deviceId: s.deviceId, message: m })
        return
    }
  }

  private profilesOf(m: LinkMessage): EnrolledDevice['profiles'] {
    const list = Array.isArray(m['profiles'])
      ? (m['profiles'] as Array<{ name?: unknown; version?: unknown }>)
      : []
    return list
      .filter((p) => typeof p?.name === 'string' && typeof p?.version === 'number')
      .map((p) => ({ name: p.name as string, version: p.version as number }))
  }

  private handleHello(s: Session, m: LinkMessage): void {
    const device = this.opts.devices.get(s.fingerprint)
    if (!device) {
      this.write(s, { type: 'reject', reason: 'device is not enrolled with this dashboard' })
      this.emitEvent({
        type: 'rejected',
        fingerprint: s.fingerprint,
        address: s.address,
        reason: 'not enrolled'
      })
      this.close(s, 'not enrolled')
      return
    }
    void this.opts.devices.touch(device.id, {
      hostname: typeof m['hostname'] === 'string' ? m['hostname'] : device.hostname,
      serial: typeof m['serial'] === 'string' ? m['serial'] : device.serial,
      agentVersion: typeof m['agentVersion'] === 'string' ? m['agentVersion'] : device.agentVersion,
      profiles: this.profilesOf(m)
    })
    s.caps = capabilitiesOf(m)
    this.activate(s, device)
    this.write(s, {
      type: 'welcome',
      deviceId: device.id,
      hostTime: (this.opts.now?.() ?? new Date()).toISOString()
    })
    this.emitEvent({
      type: 'connected',
      device: this.opts.devices.get(device.id) ?? device,
      address: s.address
    })
    this.log(`device ${device.displayName} (${device.id.slice(0, 16)}) connected from ${s.address}`)
  }

  private handleEnroll(s: Session, m: LinkMessage): void {
    const tokenText = typeof m['token'] === 'string' ? m['token'] : ''
    const issued = this.opts.tokens.peek(tokenText)
    const nonceB64 = typeof m['nonce'] === 'string' ? m['nonce'] : ''
    const nonce = Buffer.from(nonceB64, 'base64')
    if (!issued || nonce.length < 16) {
      this.write(s, { type: 'reject', reason: 'invalid, used or expired enrollment token' })
      this.emitEvent({
        type: 'rejected',
        fingerprint: s.fingerprint,
        address: s.address,
        reason: 'bad token'
      })
      this.close(s, 'bad token')
      return
    }
    s.state = 'enrolling'
    s.pendingEnroll = {
      token: issued.token,
      label: issued.label,
      serial: typeof m['serial'] === 'string' ? m['serial'] : '',
      hostname: typeof m['hostname'] === 'string' ? m['hostname'] : 'unknown-host',
      os: normalizeOs(m['os']),
      agentVersion: typeof m['agentVersion'] === 'string' ? m['agentVersion'] : '',
      profiles: this.profilesOf(m)
    }
    s.caps = capabilitiesOf(m)
    if (s.stepTimer) clearTimeout(s.stepTimer)
    s.stepTimer = setTimeout(() => {
      if (s.state === 'enrolling') this.close(s, 'enrollment not confirmed within 30 s')
    }, ENROLL_STEP_TIMEOUT_MS)
    this.write(s, {
      type: 'enroll-proof',
      proof: proof(issued.secret, nonce, this.opts.hostFingerprint),
      hostFingerprint: this.opts.hostFingerprint
    })
  }

  private async finishEnroll(s: Session): Promise<void> {
    const p = s.pendingEnroll
    if (!p || !this.opts.tokens.consume(p.token)) {
      this.write(s, { type: 'reject', reason: 'token expired during enrollment' })
      this.close(s, 'token expired')
      return
    }
    const now = (this.opts.now?.() ?? new Date()).toISOString()
    // Same certificate: refresh. Different certificate but the same serial (or hostname when no
    // serial is reported): the agent was reinstalled, so carry the record over to the new key.
    const sameKey = this.opts.devices.get(s.fingerprint)
    const previous =
      sameKey ?? this.opts.devices.match(p.serial || undefined, p.serial ? undefined : p.hostname)
    if (previous && previous.id !== s.fingerprint) {
      await this.opts.devices.remove(previous.id)
      this.log(
        `re-enrollment: ${previous.displayName} moved from key ${previous.id.slice(0, 16)} to ${s.fingerprint.slice(0, 16)} (matched by ${p.serial ? 'serial' : 'hostname'})`
      )
    }
    const existing = previous
    const device: EnrolledDevice = {
      id: s.fingerprint,
      serial: p.serial,
      hostname: p.hostname,
      os: p.os,
      displayName: p.label?.trim() || existing?.displayName || p.hostname,
      enrolledAt: now,
      lastSeen: now,
      agentVersion: p.agentVersion,
      profiles: p.profiles,
      notes: existing?.notes
    }
    await this.opts.devices.upsert(device)
    this.activate(s, device)
    this.write(s, { type: 'enrolled', deviceId: device.id, displayName: device.displayName })
    this.emitEvent({ type: 'enrolled', device, address: s.address })
    this.log(
      `enrolled ${device.displayName} serial=${device.serial || 'n/a'} os=${device.os} from ${s.address}`
    )
  }
}
