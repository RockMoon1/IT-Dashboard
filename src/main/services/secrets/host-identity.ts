import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, X509Certificate } from 'node:crypto'
import { runProcess } from '../remoting/powershell.ts'
import type { SecretStore } from './store.ts'

/**
 * The dashboard's TLS identity. The private key lives only in the secret store; the certificate
 * (public) is a file in app data. Generation is delegated to the bundled agent binary
 * (`arh-agent host-cert`) so both ends use the same certificate conventions.
 */

export const HOST_KEY_SECRET = 'host-tls-key'
export const HOST_CERT_FILE = 'host.crt'

export interface HostIdentity {
  certPem: string
  keyPem: string
  fingerprint: string
  notAfter: string
}

export function certificateFingerprint(certPem: string): string {
  const cert = new X509Certificate(certPem)
  return createHash('sha256').update(cert.raw).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export interface EnsureOptions {
  dataDir: string
  secrets: SecretStore
  agentBinary: string
  commonName?: string
  /** Replace the identity even if one exists (invalidates every enrolled device). */
  rotate?: boolean
}

export async function ensureHostIdentity(opts: EnsureOptions): Promise<HostIdentity> {
  await mkdir(opts.dataDir, { recursive: true })
  const certPath = join(opts.dataDir, HOST_CERT_FILE)
  if (!opts.rotate && (await exists(certPath))) {
    const certPem = await readFile(certPath, 'utf8')
    const keyPem = await opts.secrets.get(HOST_KEY_SECRET)
    if (keyPem) {
      const cert = new X509Certificate(certPem)
      return {
        certPem,
        keyPem,
        fingerprint: certificateFingerprint(certPem),
        notAfter: new Date(cert.validTo).toISOString()
      }
    }
  }
  const r = await runProcess(
    opts.agentBinary,
    ['host-cert', '--cn', opts.commonName ?? 'ARH IT Dashboard'],
    { timeoutMs: 30_000 }
  )
  if (r.exitCode !== 0)
    throw new Error(`arh-agent host-cert failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
  const parsed = JSON.parse(r.stdout) as {
    certPem: string
    keyPem: string
    fingerprint: string
    notAfter: string
  }
  if (!parsed.certPem || !parsed.keyPem)
    throw new Error('arh-agent host-cert returned no certificate')
  const fingerprint = certificateFingerprint(parsed.certPem)
  if (fingerprint !== parsed.fingerprint.toLowerCase())
    throw new Error('host certificate fingerprint mismatch between agent and host')
  await opts.secrets.set(HOST_KEY_SECRET, parsed.keyPem)
  await writeFile(certPath, parsed.certPem, 'utf8')
  return { certPem: parsed.certPem, keyPem: parsed.keyPem, fingerprint, notAfter: parsed.notAfter }
}
