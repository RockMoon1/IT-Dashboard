import { readFile } from 'node:fs/promises'
import { Client, type ConnectConfig } from 'ssh2'
import type { RemoteExecutor, RunOptions, RunResult } from './types.ts'
import { decideHostKey, hostKeyId } from './hostkeys.ts'

export { decideHostKey, hostKeyId } from './hostkeys.ts'

/**
 * SSH remoting for macOS, Linux and Windows (OpenSSH server) targets using the pure-JS ssh2 client.
 * Host keys are pinned per host:port in settings. First contact records the key (trust on first
 * use) unless strict mode is on; a changed key always aborts the connection.
 */

export interface SshTarget {
  host: string
  port?: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export interface SshOptions {
  knownHosts: Record<string, string>
  strictHostKeys?: boolean
  readyTimeoutMs?: number
  onStatus?: (text: string) => void
  /** Called when a new host key is recorded so the caller can persist it. */
  onHostKeyRecorded?: (id: string, fingerprint: string) => void
}

export class SshSession implements RemoteExecutor {
  private client: Client
  private target: SshTarget
  private opts: SshOptions
  private hostKeyProblem: string | null = null

  private constructor(target: SshTarget, opts: SshOptions) {
    this.client = new Client()
    this.target = target
    this.opts = opts
  }

  static async connect(target: SshTarget, opts: SshOptions): Promise<SshSession> {
    const session = new SshSession(target, opts)
    const port = target.port ?? 22
    const config: ConnectConfig = {
      host: target.host,
      port,
      username: target.username,
      readyTimeout: opts.readyTimeoutMs ?? 15_000,
      keepaliveInterval: 10_000,
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string) => session.verifyHost(fingerprint),
      tryKeyboard: Boolean(target.password)
    }
    if (target.privateKeyPath) {
      config.privateKey = await readFile(target.privateKeyPath)
      if (target.passphrase) config.passphrase = target.passphrase
    } else if (target.password) {
      config.password = target.password
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(session.hostKeyProblem ? new Error(session.hostKeyProblem) : err)
      }
      session.client.once('ready', () => {
        session.client.off('error', onError)
        resolve()
      })
      session.client.once('error', onError)
      session.client.on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
        finish([target.password ?? ''])
      })
      session.client.connect(config)
    })
    session.client.on('error', (err) => opts.onStatus?.(`SSH connection error: ${err.message}`))
    return session
  }

  private verifyHost(fingerprint: string): boolean {
    const id = hostKeyId(this.target.host, this.target.port ?? 22)
    const decision = decideHostKey(
      this.opts.knownHosts,
      id,
      fingerprint,
      Boolean(this.opts.strictHostKeys)
    )
    switch (decision) {
      case 'known':
        return true
      case 'recorded':
        this.opts.knownHosts[id] = fingerprint
        this.opts.onHostKeyRecorded?.(id, fingerprint)
        this.opts.onStatus?.(`Host key for ${id} recorded on first use (SHA256 ${fingerprint})`)
        return true
      case 'unknown-strict':
        this.hostKeyProblem = `Unknown host key for ${id} (SHA256 ${fingerprint}); strict host key checking is on`
        return false
      case 'mismatch':
        this.hostKeyProblem = `HOST KEY MISMATCH for ${id}: stored key differs from the key presented (SHA256 ${fingerprint}). Possible man-in-the-middle or reinstalled host; clear the stored key only if the change is expected.`
        return false
    }
  }

  exec(command: string, opts: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const started = Date.now()
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let aborted = false
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        resolve({ exitCode, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started })
      }
      let closeStream: () => void = () => undefined
      const onAbort = (): void => {
        aborted = true
        closeStream()
      }

      this.client.exec(command, (err, stream) => {
        if (err) {
          stderr += err.message
          finish(null)
          return
        }
        closeStream = (): void => {
          try {
            stream.close()
          } catch {
            /* already closed */
          }
        }
        if (opts.timeoutMs) {
          timer = setTimeout(() => {
            timedOut = true
            closeStream()
          }, opts.timeoutMs)
        }
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stdout += text
          opts.onStdout?.(text)
        })
        stream.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          stderr += text
          opts.onStderr?.(text)
        })
        stream.on('close', (code: number | null) =>
          finish(typeof code === 'number' ? code : timedOut || aborted ? null : 0)
        )
        if (opts.stdin != null) stream.end(opts.stdin)
        if (opts.signal?.aborted) onAbort()
        else opts.signal?.addEventListener('abort', onAbort, { once: true })
      })
    })
  }

  close(): void {
    this.client.end()
  }
}
