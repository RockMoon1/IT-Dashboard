/**
 * Secret storage on the host. Production is Windows Credential Manager; the fallback is
 * Electron's safeStorage (DPAPI on Windows). Nothing here ever writes a secret in plaintext.
 */
export interface SecretStore {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<boolean>
  describe(): string
}

/** In-memory store for tests and for environments without any keystore (never persists). */
export class MemoryStore implements SecretStore {
  private values = new Map<string, string>()
  async get(name: string): Promise<string | null> {
    return this.values.get(name) ?? null
  }
  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value)
  }
  async delete(name: string): Promise<boolean> {
    return this.values.delete(name)
  }
  describe(): string {
    return 'memory only (not persisted)'
  }
}
