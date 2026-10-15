import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface TestCert {
  certPem: string
  keyPem: string
  fingerprint: string
}

const root = join(import.meta.dirname, '..', '..')

/** Generates a certificate with the agent binary (or `go run`); returns null when neither exists. */
export function makeCert(cn: string): TestCert | null {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const built = join(root, 'agent', 'dist', `arh-agent-${os}-${arch}${ext}`)
  try {
    const out = existsSync(built)
      ? execFileSync(built, ['host-cert', '--cn', cn], { encoding: 'utf8' })
      : execFileSync('go', ['run', './agent/cmd/arh-agent', 'host-cert', '--cn', cn], {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, CGO_ENABLED: '0' }
        })
    return JSON.parse(out) as TestCert
  } catch {
    return null
  }
}
