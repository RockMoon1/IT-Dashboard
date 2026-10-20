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
  mergeChanges,
  mergeLog,
  mergeLoops,
  type ActionEntry,
  type ContentOptions,
  type DeviceRow
} from './content.ts'
import { getBlock } from './markers.ts'
import type { WritePlan } from './writer.ts'

type NoteSettings = Pick<
  Settings,
  'vaultPath' | 'hubNote' | 'workLogNote' | 'openLoopsNote' | 'assetNote' | 'changeLogNote'
>

const md = (n: string): string => (n.toLowerCase().endsWith('.md') ? n : `${n}.md`)
const baseName = (n: string): string => n.replace(/\.md$/i, '').split(/[\\/]/).pop() ?? n

/**
 * Resolves the target notes from settings. An empty hub or Change Log note name means "do not
 * write that note".
 */
export function notePaths(settings: NoteSettings): {
  hub: string | null
  workLog: string
  openLoops: string
  assets: string
  changeLog: string | null
} {
  const opt = (name: string): string | null =>
    name.trim() ? join(settings.vaultPath, md(name.trim())) : null
  return {
    hub: opt(settings.hubNote),
    changeLog: opt(settings.changeLogNote ?? ''),
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
  /** Actions and custom commands from the action log, with their definitions. */
  actions?: ActionEntry[]
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
    workLogNoteName: baseName(settings.workLogNote),
    changeLogNoteName: baseName(settings.changeLogNote || 'ARH Change Log')
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

  const [assetsText, loopsText, logText, changesText] = await Promise.all([
    read(paths.assets),
    read(paths.openLoops),
    read(paths.workLog),
    paths.changeLog ? read(paths.changeLog) : Promise.resolve(null)
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
      body: mergeLog(logBlock, finished, opts, input.actions ?? []).body,
      basedOn: logBlock
    }
  ]
  if (paths.changeLog) {
    // the Change Log gets the dashboard's block only once there is a first change to record
    const changesBlock = safeBlock(changesText, BLOCK_KEYS.changes)
    const changes = mergeChanges(changesBlock, input.actions ?? [], opts)
    if (changesBlock !== null || changes.added > 0)
      plans.push({
        notePath: paths.changeLog,
        key: BLOCK_KEYS.changes,
        body: changes.body,
        basedOn: changesBlock
      })
  }
  if (paths.hub)
    plans.push({
      notePath: paths.hub,
      key: BLOCK_KEYS.health,
      body: healthBlock(rows, loops.body, opts)
    })
  return plans
}
