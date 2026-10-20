import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ScanRun, Settings } from '../../../shared/types.ts'
import type { EnrolledDevice } from '../link/devices.ts'
import {
  BLOCK_KEYS,
  DEFAULT_CONTENT_OPTIONS,
  deviceFacts,
  deviceKey,
  devicesBlock,
  healthBlock,
  mergeLog,
  mergeLoops,
  type ContentOptions,
  type DeviceRow
} from './content.ts'
import { getBlock } from './markers.ts'
import type { WritePlan } from './writer.ts'

type NoteSettings = Pick<
  Settings,
  'vaultPath' | 'hubNote' | 'workLogNote' | 'openLoopsNote' | 'assetNote'
>

const md = (n: string): string => (n.toLowerCase().endsWith('.md') ? n : `${n}.md`)
const baseName = (n: string): string => n.replace(/\.md$/i, '').split(/[\\/]/).pop() ?? n

/** Resolves the target notes from settings. An empty hub note name means "do not write the hub". */
export function notePaths(settings: NoteSettings): {
  hub: string | null
  workLog: string
  openLoops: string
  assets: string
} {
  return {
    hub: settings.hubNote.trim() ? join(settings.vaultPath, md(settings.hubNote.trim())) : null,
    workLog: join(settings.vaultPath, md(settings.workLogNote)),
    openLoops: join(settings.vaultPath, md(settings.openLoopsNote)),
    assets: join(settings.vaultPath, md(settings.assetNote))
  }
}

export interface PlanInput {
  settings: Settings
  devices: EnrolledDevice[]
  /** Finished and persisted runs, any order. */
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

function safeBlock(text: string | null, key: string): string | null {
  if (!text) return null
  try {
    return getBlock(text, key)
  } catch {
    return null
  }
}

export function contentOptions(settings: Settings): ContentOptions {
  return {
    ...DEFAULT_CONTENT_OPTIONS,
    dueStyle: settings.dueStyle,
    assetNoteName: baseName(settings.assetNote),
    openLoopsNoteName: baseName(settings.openLoopsNote),
    workLogNoteName: baseName(settings.workLogNote)
  }
}

/** Builds every managed block. Pure apart from reading the current text of the notes. */
export async function buildWritePlans(input: PlanInput): Promise<WritePlan[]> {
  const read = input.readNote ?? defaultRead
  const paths = notePaths(input.settings)
  const opts = contentOptions(input.settings)
  const finished = input.runs.filter((r) => r.status !== 'running')

  const rows: DeviceRow[] = input.devices.map((device) => {
    const key = deviceKey(device.serial, device.hostname)
    const mine = finished.filter(
      (r) => r.deviceId === device.id || deviceKey(r.serial, r.hostname) === key
    )
    return { device, facts: deviceFacts(mine, opts) }
  })

  const [assetsText, loopsText, logText] = await Promise.all([
    read(paths.assets),
    read(paths.openLoops),
    read(paths.workLog)
  ])
  const assetsBlock = safeBlock(assetsText, BLOCK_KEYS.devices)
  const loopsBlock = safeBlock(loopsText, BLOCK_KEYS.loops)
  const logBlock = safeBlock(logText, BLOCK_KEYS.log)
  const loops = mergeLoops(loopsBlock, finished, opts, input.now, input.devices)

  const plans: WritePlan[] = [
    {
      notePath: paths.assets,
      key: BLOCK_KEYS.devices,
      body: devicesBlock(assetsBlock, rows, opts),
      basedOn: assetsBlock
    },
    { notePath: paths.openLoops, key: BLOCK_KEYS.loops, body: loops.body, basedOn: loopsBlock },
    {
      notePath: paths.workLog,
      key: BLOCK_KEYS.log,
      body: mergeLog(logBlock, finished, opts).body,
      basedOn: logBlock
    }
  ]
  if (paths.hub)
    plans.push({
      notePath: paths.hub,
      key: BLOCK_KEYS.health,
      body: healthBlock(rows, loops.body, opts)
    })
  return plans
}
