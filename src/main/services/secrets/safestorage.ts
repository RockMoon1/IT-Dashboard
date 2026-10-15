import { safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SecretStore } from './store.ts'

/**
 * Fallback when Credential Manager is unavailable (non-Windows development machines, or a
 * Credential Manager call that fails). Electron's safeStorage encrypts with DPAPI on Windows,
 * the Keychain on macOS and the desktop keyring on Linux; the ciphertext lives in app data.
 */
export class SafeStorageStore implements SecretStore {
  private file: string
  private cache: Record<string, string> | null = null

  constructor(file: string) {
    this.file = file
  }

  static available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(this.cache ?? {}, null, 2), 'utf8')
  }

  async get(name: string): Promise<string | null> {
    const data = await this.load()
    const enc = data[name]
    if (!enc) return null
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }

  async set(name: string, value: string): Promise<void> {
    const data = await this.load()
    data[name] = safeStorage.encryptString(value).toString('base64')
    await this.persist()
  }

  async delete(name: string): Promise<boolean> {
    const data = await this.load()
    const had = name in data
    delete data[name]
    await this.persist()
    return had
  }

  describe(): string {
    return `Electron safeStorage (${process.platform === 'win32' ? 'DPAPI' : 'OS keyring'}) ciphertext in ${this.file}`
  }
}
