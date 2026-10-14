/** Pure host-key pinning logic shared by the SSH session and the tests (no ssh2 dependency). */

export function hostKeyId(host: string, port = 22): string {
  return `${host.toLowerCase()}:${port}`
}

export type HostKeyDecision = 'known' | 'recorded' | 'mismatch' | 'unknown-strict'

export function decideHostKey(
  knownHosts: Record<string, string>,
  id: string,
  fingerprint: string,
  strict: boolean
): HostKeyDecision {
  const known = knownHosts[id]
  if (!known) return strict ? 'unknown-strict' : 'recorded'
  return known === fingerprint ? 'known' : 'mismatch'
}
