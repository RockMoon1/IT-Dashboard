import type { CommandSpec, Purpose, ShellKind, TargetOS } from '../../../shared/types.ts'
import { WINDOWS_COMMANDS } from './windows.ts'
import { LINUX_COMMANDS, MACOS_COMMANDS } from './posix.ts'

export const DEFAULT_COMMAND_TIMEOUT_MS = 90_000

export function shellFor(os: TargetOS): ShellKind {
  return os === 'windows' ? 'powershell' : 'sh'
}

/** Builds CommandSpecs from technician-supplied commands (purpose "Other"). */
export function customCommands(lines: string[], os: TargetOS): CommandSpec[] {
  const shell = shellFor(os)
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((script, i) => ({
      id: `custom-${i + 1}`,
      title: script.length > 70 ? `${script.slice(0, 67)}...` : script,
      shell,
      format: 'text' as const,
      script
    }))
}

/**
 * Returns the command set for a purpose on a target OS. Unknown targets reached over SSH get the
 * Linux set (the most portable one); unknown targets reached over WinRM must be Windows.
 */
export function getCommands(purpose: Purpose, os: TargetOS, custom: string[] = []): CommandSpec[] {
  if (purpose === 'other') return customCommands(custom, os)
  switch (os) {
    case 'windows':
      return WINDOWS_COMMANDS[purpose]
    case 'macos':
      return MACOS_COMMANDS[purpose]
    case 'linux':
    case 'unknown':
      return LINUX_COMMANDS[purpose]
  }
}

export function allCatalogs(): Array<{ os: TargetOS; purpose: Purpose; commands: CommandSpec[] }> {
  const out: Array<{ os: TargetOS; purpose: Purpose; commands: CommandSpec[] }> = []
  const sets: Array<[TargetOS, Record<Exclude<Purpose, 'other'>, CommandSpec[]>]> = [
    ['windows', WINDOWS_COMMANDS],
    ['macos', MACOS_COMMANDS],
    ['linux', LINUX_COMMANDS]
  ]
  for (const [os, set] of sets) {
    for (const purpose of Object.keys(set) as Array<Exclude<Purpose, 'other'>>) {
      out.push({ os, purpose, commands: set[purpose] })
    }
  }
  return out
}
