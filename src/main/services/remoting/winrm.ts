import { encodePowerShellCommand, runPowerShell } from './powershell.ts'
import type { RemoteExecutor, RunOptions, RunResult } from './types.ts'

/**
 * WinRM remoting from a Windows host: the dashboard drives the local PowerShell, which runs
 * Invoke-Command against the target. Secrets travel in the child's environment block, never on
 * the command line, and the target script is base64-encoded to survive quoting.
 *
 * Target prerequisites (one-time, as admin on the target): Enable-PSRemoting -Force.
 * Host prerequisite for workgroup targets reached by name/IP with Negotiate auth: the target must
 * be listed in WSMan:\localhost\Client\TrustedHosts (see trustedHostsCommand), or use HTTPS/Kerberos.
 */

export type WinRmAuth = 'Default' | 'Negotiate' | 'Kerberos' | 'Basic' | 'CredSSP'

export interface WinRmTarget {
  host: string
  username: string
  password: string
  port?: number
  useSsl?: boolean
  skipCertCheck?: boolean
  authentication?: WinRmAuth
}

export const WINRM_HOST_SCRIPT = String.raw`
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ARH_TARGET_SCRIPT_B64))
$secure = ConvertTo-SecureString -String $env:ARH_TARGET_PASSWORD -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($env:ARH_TARGET_USER, $secure)
$params = @{
  ComputerName = $env:ARH_TARGET_HOST
  Credential = $cred
  ScriptBlock = [scriptblock]::Create($script)
  Authentication = $env:ARH_TARGET_AUTH
  ErrorAction = 'Continue'
  ErrorVariable = 'remoteErrors'
}
if ($env:ARH_TARGET_PORT) { $params.Port = [int]$env:ARH_TARGET_PORT }
if ($env:ARH_TARGET_USESSL -eq '1') { $params.UseSSL = $true }
if ($env:ARH_TARGET_SKIPCERT -eq '1') { $params.SessionOption = New-PSSessionOption -SkipCACheck -SkipCNCheck }
Invoke-Command @params
$transport = @($remoteErrors | Where-Object { $_.Exception -is [System.Management.Automation.Remoting.PSRemotingTransportException] })
if ($transport.Count -gt 0) {
  foreach ($e in $transport) { [Console]::Error.WriteLine('WinRM: ' + $e.Exception.Message) }
  exit 1
}
exit 0
`

export function winRmEnv(target: WinRmTarget, targetScript: string): Record<string, string> {
  const env: Record<string, string> = {
    ARH_TARGET_HOST: target.host,
    ARH_TARGET_USER: target.username,
    ARH_TARGET_PASSWORD: target.password,
    ARH_TARGET_AUTH: target.authentication ?? 'Default',
    ARH_TARGET_SCRIPT_B64: Buffer.from(targetScript, 'utf8').toString('base64')
  }
  if (target.port) env['ARH_TARGET_PORT'] = String(target.port)
  if (target.useSsl) env['ARH_TARGET_USESSL'] = '1'
  if (target.skipCertCheck) env['ARH_TARGET_SKIPCERT'] = '1'
  return env
}

export function runWinRm(
  target: WinRmTarget,
  targetScript: string,
  opts: RunOptions = {}
): Promise<RunResult> {
  return runPowerShell(WINRM_HOST_SCRIPT, {
    ...opts,
    env: { ...opts.env, ...winRmEnv(target, targetScript) }
  })
}

export function createWinRmExecutor(target: WinRmTarget): RemoteExecutor {
  return {
    exec: (script, opts) => runWinRm(target, script, opts),
    close: () => undefined
  }
}

export const TRUSTED_HOSTS_SCRIPT = String.raw`try { [string](Get-Item WSMan:\localhost\Client\TrustedHosts -ErrorAction Stop).Value } catch { '' }`

/** Mirrors WinRM's TrustedHosts matching: comma-separated entries, "*" wildcards, case-insensitive. */
export function trustedHostsCovers(value: string, host: string): boolean {
  const target = host.trim().toLowerCase()
  if (!target) return false
  return value
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true
      const re = new RegExp(`^${entry.split('*').map(escapeRegExp).join('.*')}$`)
      return re.test(target)
    })
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function trustedHostsCommand(host: string): string {
  return `Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value '${host.replace(/'/g, "''")}' -Concatenate -Force`
}

export async function getTrustedHosts(run: typeof runPowerShell = runPowerShell): Promise<string> {
  const r = await run(TRUSTED_HOSTS_SCRIPT, { timeoutMs: 20_000 })
  return r.stdout.trim()
}

export function testWsmanScript(host: string, port?: number, useSsl?: boolean): string {
  const parts = [`Test-WSMan -ComputerName '${host.replace(/'/g, "''")}'`]
  if (port) parts.push(`-Port ${port}`)
  if (useSsl) parts.push('-UseSSL')
  return `${parts.join(' ')} -ErrorAction Stop | Select-Object ProductVendor, ProductVersion | Format-List | Out-String`
}

/** Encoded form of a script, useful for logging what was sent without exposing credentials. */
export function describeTargetScript(script: string): string {
  return `${script.split('\n').length} lines, ${encodePowerShellCommand(script).length} base64 chars`
}
