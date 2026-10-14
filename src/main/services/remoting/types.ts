export interface RunOptions {
  timeoutMs?: number
  env?: Record<string, string>
  cwd?: string
  signal?: AbortSignal
  /** Content written to the child's stdin before it is closed. */
  stdin?: string
  /** Which interpreter the command is written for; local executors use it to pick the shell. */
  shell?: 'powershell' | 'sh'
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
}

export interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  durationMs: number
}

export interface RemoteExecutor {
  exec(script: string, opts?: RunOptions): Promise<RunResult>
  close(): Promise<void> | void
}
