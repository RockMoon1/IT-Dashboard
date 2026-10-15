import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ScanRun, Settings } from '../../../shared/types.ts'
import type { EnrolledDevice } from '../link/devices.ts'
import {
  BLOCK_KEYS,
  DEFAULT_CONTENT_OPTIONS,
  devicesTable,
  mergeLog,
  mergeLoops,
  scansBlock,
  type ContentOptions,
  type DeviceRow
} from './content.ts'
import { getBlock } from './markers.ts'
import type { WritePlan } from './writer.ts'

/** Resolves the three target notes from settings. */
export function notePaths(
  settings: Pick<Settings, 'vaultPath' | 'hubNote' | 'workLogNote' | 'openLoopsNote'>
): { hub: string; workLog: string; openLoops: string } {
  const md = (n: string): string => (n.toLowerCase().endsWith('.md') ? n : `${n}.md`)
  return {
    hub: join(settings.vaultPath, md(settings.hubNote)),
    workLog: join(settings.vaultPath, md(settings.workLogNote)),
    openLoops: join(settings.vaultPath, md(settings.openLoopsNote))
  }
}

export interface PlanInput {
  settings: Settings
  devices: EnrolledDevice[]
  connected: (deviceId: string) => boolean
  /** Recent runs, newest first (persisted + current). */
  runs: ScanRun[]
  now?: Date
  readNote?: (path: string) => Promise<string | null>
}

async function defaultRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Builds every managed block for the three notes. Pure apart from reading current note text. */
export async function buildWritePlans(input: PlanInput): Promise<WritePlan[]> {
  const read = input.readNote ?? defaultRead
  const paths = notePaths(input.settings)
  const opts: ContentOptions = {
    ...DEFAULT_CONTENT_OPTIONS,
    dueStyle: input.settings.dueStyle,
    hubNoteName: input.settings.hubNote.replace(/\.md$/i, ''),
    workLogNoteName: input.settings.workLogNote.replace(/\.md$/i, '')
  }
  const rows: DeviceRow[] = input.devices.map((device) => {
    const last = input.runs.find((r) => r.deviceId === device.id)
    return {
      device,
      connected: input.connected(device.id),
      lastScan: last
        ? {
            purpose: last.purpose,
            at: last.finishedAt ?? last.startedAt,
            status: last.status,
            score: last.health?.score
          }
        : undefined
    }
  })
  const finished = input.runs.filter((r) => r.status !== 'running')
  const [loopsText, logText] = await Promise.all([read(paths.openLoops), read(paths.workLog)])
  const loopsBody = loopsText ? safeBlock(loopsText, BLOCK_KEYS.loops) : null
  const logBody = logText ? safeBlock(logText, BLOCK_KEYS.log) : null
  return [
    { notePath: paths.hub, key: BLOCK_KEYS.devices, body: devicesTable(rows) },
    { notePath: paths.hub, key: BLOCK_KEYS.scans, body: scansBlock(finished, opts) },
    {
      notePath: paths.openLoops,
      key: BLOCK_KEYS.loops,
      body: mergeLoops(loopsBody, finished, opts, input.now).body
    },
    { notePath: paths.workLog, key: BLOCK_KEYS.log, body: mergeLog(logBody, finished).body }
  ]
}

function safeBlock(text: string, key: string): string | null {
  try {
    return getBlock(text, key)
  } catch {
    return null
  }
}
