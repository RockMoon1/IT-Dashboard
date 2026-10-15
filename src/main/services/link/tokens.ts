import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Enrollment tokens: ARH-<fp8>-<secret16>. Mirrors agent/internal/protocol/token.go exactly;
 * tests/link.test.ts holds the shared known-answer values.
 */

export const TOKEN_TTL_MS = 10 * 60 * 1000
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function encodeCrockford(bytes: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) >>> 0
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(acc >>> bits) & 31]
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31]
  return out
}

export function decodeCrockford(text: string): Uint8Array {
  const s = text.toUpperCase().replace(/-/g, '')
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (let ch of s) {
    if (ch === 'I' || ch === 'L') ch = '1'
    if (ch === 'O') ch = '0'
    const idx = CROCKFORD.indexOf(ch)
    if (idx < 0) throw new Error(`invalid base32 character ${JSON.stringify(ch)}`)
    acc = ((acc << 5) | idx) >>> 0
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >>> bits) & 255)
    }
  }
  return Uint8Array.from(out)
}

export interface ParsedToken {
  fp8: string
  secret: Uint8Array
}

export function formatToken(fp8: string, secret: Uint8Array): string {
  return `ARH-${fp8.toUpperCase()}-${encodeCrockford(secret)}`
}

export function parseToken(text: string): ParsedToken {
  const parts = text.trim().toUpperCase().split('-')
  if (parts.length !== 3 || parts[0] !== 'ARH')
    throw new Error('token must look like ARH-XXXXXXXX-XXXXXXXXXXXXXXXX')
  const fp8 = parts[1] ?? ''
  if (!/^[0-9A-F]{8}$/.test(fp8)) throw new Error('token fingerprint part must be 8 hex characters')
  const secret = decodeCrockford(parts[2] ?? '')
  if (secret.length !== 10)
    throw new Error(`token secret decodes to ${secret.length} bytes, want 10`)
  return { fp8, secret }
}

/** HMAC-SHA256(secret, nonce || lowercase(hostFingerprint)) as hex; identical to the agent. */
export function proof(secret: Uint8Array, nonce: Uint8Array, hostFingerprintHex: string): string {
  return createHmac('sha256', Buffer.from(secret))
    .update(Buffer.from(nonce))
    .update(hostFingerprintHex.toLowerCase(), 'utf8')
    .digest('hex')
}

export function proofEqual(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase())
  const y = Buffer.from(b.toLowerCase())
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface IssuedToken {
  token: string
  fp8: string
  secret: Uint8Array
  issuedAt: number
  expiresAt: number
  used: boolean
  /** Optional label the technician typed (e.g. the device they are enrolling). */
  label?: string
}

/** Single-use, time-limited token registry kept in memory only. */
export class TokenStore {
  private tokens = new Map<string, IssuedToken>()
  private now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  issue(hostFingerprint: string, label?: string): IssuedToken {
    this.purge()
    const fp8 = hostFingerprint.slice(0, 8).toUpperCase()
    const secret = Uint8Array.from(randomBytes(10))
    const token = formatToken(fp8, secret)
    const issued: IssuedToken = {
      token,
      fp8,
      secret,
      issuedAt: this.now(),
      expiresAt: this.now() + TOKEN_TTL_MS,
      used: false,
      label
    }
    this.tokens.set(token, issued)
    return issued
  }

  /** Returns the token if it is known, unused and unexpired; does not consume it. */
  peek(text: string): IssuedToken | null {
    this.purge()
    let parsed: ParsedToken
    try {
      parsed = parseToken(text)
    } catch {
      return null
    }
    const t = this.tokens.get(formatToken(parsed.fp8, parsed.secret))
    if (!t || t.used || t.expiresAt <= this.now()) return null
    return t
  }

  /** Marks a token used after enrollment completed; returns false if it was not valid. */
  consume(text: string): boolean {
    const t = this.peek(text)
    if (!t) return false
    t.used = true
    return true
  }

  revoke(token: string): void {
    this.tokens.delete(token)
  }

  active(): IssuedToken[] {
    this.purge()
    return [...this.tokens.values()].filter((t) => !t.used)
  }

  private purge(): void {
    const now = this.now()
    for (const [k, t] of this.tokens) if (t.used || t.expiresAt <= now) this.tokens.delete(k)
  }
}
