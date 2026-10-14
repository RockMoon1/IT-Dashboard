import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RunOptions, RunResult } from './types.ts'

/** Prepended to every PowerShell script so output is UTF-8 and progress bars never block. */
export const PS_PREAMBLE =
  "$ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'; try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}"

export function preparePowerShellScript(script: string): string {
  return `${PS_PREAMBLE}\n${script}\n`
}

/** -EncodedCommand expects base64 of UTF-16LE text. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function decodePowerShellCommand(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

export function powerShellArgs(script: string): string[] {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-OutputFormat',
    'Text',
    '-EncodedCommand',
    encodePowerShellCommand(script)
  ]
}

/** Command line that runs a PowerShell script on a Windows target reached through OpenSSH. */
export function windowsSshCommandLine(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand ${encodePowerShellCommand(script)}`
}

let cachedExe: string | null = null

/** Prefers PowerShell 7 (pwsh) when installed, else Windows PowerShell 5.1. */
export function resolvePowerShellExe(): string {
  if (cachedExe) return cachedExe
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
    const candidates = [
      join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    ]
    cachedExe = candidates.find((c) => existsSync(c)) ?? 'powershell.exe'
  } else {
    cachedExe = 'pwsh'
  }
  return cachedExe
}

export function runProcess(
  file: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const child = spawn(file, args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      windowsHide: true,
      stdio: [opts.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })

    const kill = (): void => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    const onAbort = (): void => {
      aborted = true
      kill()
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          kill()
        }, opts.timeoutMs)
      : undefined

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ exitCode, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started })
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => {
      stdout += text
      opts.onStdout?.(text)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (text: string) => {
      stderr += text
      opts.onStderr?.(text)
    })
    child.on('error', (err) => {
      stderr += `${stderr ? '\n' : ''}${err.message}`
      finish(null)
    })
    child.on('close', (code) => finish(code))

    if (opts.stdin != null && child.stdin) {
      child.stdin.on('error', () => {
        /* target closed early */
      })
      child.stdin.end(opts.stdin)
    }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Runs a PowerShell script on this machine. */
export function runPowerShell(script: string, opts: RunOptions = {}): Promise<RunResult> {
  return runProcess(resolvePowerShellExe(), powerShellArgs(preparePowerShellScript(script)), opts)
}

/** Spawns a long-running PowerShell script and returns the child for line-oriented reading. */
export function spawnPowerShell(script: string): ReturnType<typeof spawn> {
  return spawn(resolvePowerShellExe(), powerShellArgs(preparePowerShellScript(script)), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}
