import { effectScope, reactive, watch } from 'vue'
import type {
  ActionDef,
  ActionEvent,
  ActionOffer,
  ActionRecord,
  ActionRequest,
  FixContext
} from '@shared/actions'
import type { DeviceCapabilities } from '@shared/types'
import { useDashboard } from './store'
import { plain } from './plain'

/**
 * Actions and custom commands in the page: what each device offers, the open dialog, and every
 * run's record as the main process reports it. Nothing here decides whether something may run;
 * main checks every request again.
 */

export interface DialogState {
  deviceId: string
  action: string
  fix?: FixContext
  reason: string
  params: Record<string, string>
  previewId: string | null
  runId: string | null
  confirmName: string
  showScript: boolean
  error: string | null
  busy: boolean
}

interface ActionsState {
  offers: Record<string, ActionOffer[]>
  offersError: Record<string, string>
  records: Record<string, ActionRecord>
  output: Record<string, string>
  history: ActionRecord[]
  dialog: DialogState | null
  /** A past run opened from the history. */
  view: string | null
  exec: {
    deviceId: string
    script: string
    timeoutSeconds: number
    reason: string
    runId: string | null
    error: string | null
    busy: boolean
  } | null
}

const MAX_OUTPUT = 200_000

const astate = reactive<ActionsState>({
  offers: {},
  offersError: {},
  records: {},
  output: {},
  history: [],
  dialog: null,
  view: null,
  exec: null
})

let subscribed = false

/**
 * Why the device would refuse a custom command, as main and the agent decide it (custom, write
 * and execute all allowed, the cable unless the policy allows the network, no restart pending).
 */
export function execBlocker(caps: DeviceCapabilities | undefined): string | null {
  const p = caps?.policy
  if (!caps) return 'The device is not connected.'
  if (!p || p.error || !p.custom || !p.write || !p.execute)
    return 'This device does not allow custom commands. On the device, as administrator: arh-agent policy --allow custom,write,execute'
  if (caps.link !== 'cable' && !p.lan) return 'Custom commands run only over the USB cable.'
  if (caps.pendingRestartUntil) return 'A restart is scheduled: cancel it or wait for it.'
  return null
}

/** The agent's limit on a reason, in UTF-8 bytes. */
export const MAX_REASON_BYTES = 500
const utf8 = new TextEncoder()
export const utf8Length = (s: string): number => utf8.encode(s).length
function clipUtf8(s: string, max: number): string {
  let out = ''
  for (const ch of s) {
    if (utf8Length(out + ch) > max) break
    out += ch
  }
  return out
}

function message(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors thrown in main
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function onEvent(e: ActionEvent): void {
  if (e.type === 'update' && e.record) {
    astate.records[e.record.runId] = e.record
    const i = astate.history.findIndex((r) => r.runId === e.record!.runId)
    if (i >= 0) astate.history[i] = e.record
    else astate.history.unshift(e.record)
    if (e.record.endedAt) {
      void loadOffers(e.record.deviceId)
      const dash = useDashboard()
      if (e.record.mode === 'apply' && dash.state.profile?.summary.deviceId === e.record.deviceId)
        void dash.refreshProfile()
    }
  } else if (e.type === 'output' && e.runId && e.data) {
    const prev = astate.output[e.runId] ?? ''
    if (prev.length < MAX_OUTPUT) astate.output[e.runId] = prev + e.data
  }
}

async function ensure(): Promise<void> {
  if (subscribed || typeof window.arh === 'undefined') return
  subscribed = true
  window.arh.actions.onEvent(onEvent)
  // what Settings allow is part of each offer: ask main again once they change. The watch has a
  // scope of its own: the first call may come from a page's onMounted, whose scope would stop it
  // when the page closes
  effectScope(true).run(() =>
    watch(
      () => useDashboard().state.settings,
      () => Object.keys(astate.offers).forEach((id) => void loadOffers(id))
    )
  )
  try {
    astate.history = await window.arh.actions.list(300)
    for (const r of astate.history) astate.records[r.runId] = r
  } catch {
    /* shown when a dialog opens */
  }
}

async function loadOffers(deviceId: string): Promise<void> {
  await ensure()
  try {
    astate.offers[deviceId] = await window.arh.actions.offers(deviceId)
    delete astate.offersError[deviceId]
  } catch (err) {
    astate.offersError[deviceId] = message(err)
  }
}

function offer(deviceId: string, action: string): ActionOffer | undefined {
  return astate.offers[deviceId]?.find((o) => o.def.name === action)
}

/** Actions whose `fixes` pattern matches a finding, for the Fix buttons. */
function fixesFor(deviceId: string, category: string, message: string): ActionDef[] {
  const text = `${category}: ${message}`
  return (astate.offers[deviceId] ?? [])
    .map((o) => o.def)
    .filter((d) =>
      d.fixes.some((f) => {
        try {
          return new RegExp(f).test(text)
        } catch {
          return false
        }
      })
    )
}

/** Opens the dialog and runs the preview at once (it only measures). */
function openAction(
  deviceId: string,
  action: string,
  fix?: FixContext,
  preset: { params?: Record<string, string>; reason?: string } = {}
): void {
  const o = offer(deviceId, action)
  const params: Record<string, string> = {}
  for (const p of o?.def.params ?? []) params[p.name] = preset.params?.[p.name] ?? p.default
  astate.dialog = {
    deviceId,
    action,
    fix,
    reason: preset.reason ?? (fix ? `Fix: ${fix.message}` : ''),
    params,
    previewId: null,
    runId: null,
    confirmName: '',
    showScript: false,
    error: null,
    busy: false
  }
  void preview()
}

function closeDialog(): void {
  astate.dialog = null
}

function request(d: DialogState): ActionRequest {
  return {
    deviceId: d.deviceId,
    action: d.action,
    params: { ...d.params },
    reason: d.reason,
    fix: d.fix ? plain(d.fix) : undefined
  }
}

async function preview(): Promise<void> {
  const d = astate.dialog
  if (!d) return
  d.error = null
  d.busy = true
  d.runId = null
  try {
    const r = await window.arh.actions.preview(request(d))
    astate.records[r.runId] = r
    d.previewId = r.runId
  } catch (err) {
    // the preview shown before stays: one still measuring reports its result when it ends
    d.error = message(err)
  } finally {
    d.busy = false
  }
}

async function run(): Promise<void> {
  const d = astate.dialog
  if (!d) return
  d.error = null
  d.busy = true
  try {
    const r = await window.arh.actions.run(request(d), {
      previewOf: d.previewId ?? undefined,
      confirmName: d.confirmName || undefined
    })
    astate.records[r.runId] = r
    d.runId = r.runId
  } catch (err) {
    d.error = message(err)
  } finally {
    d.busy = false
  }
}

async function abort(runId: string): Promise<void> {
  try {
    await window.arh.actions.abort(runId)
  } catch (err) {
    if (astate.dialog) astate.dialog.error = message(err)
  }
}

function openExec(deviceId: string): void {
  astate.exec = {
    deviceId,
    script: '',
    timeoutSeconds: 300,
    reason: '',
    runId: null,
    error: null,
    busy: false
  }
}

async function runExec(): Promise<void> {
  const x = astate.exec
  if (!x) return
  x.error = null
  x.busy = true
  try {
    const r = await window.arh.actions.exec({
      deviceId: x.deviceId,
      script: x.script,
      timeoutSeconds: x.timeoutSeconds,
      reason: x.reason
    })
    astate.records[r.runId] = r
    x.runId = r.runId
  } catch (err) {
    x.error = message(err)
  } finally {
    x.busy = false
  }
}

/** Undo: the action's own undo action with the values measured before the change. */
function openUndo(record: ActionRecord): void {
  const o = record.action ? offer(record.deviceId, record.action) : undefined
  const undo = o?.def.undo
  if (!undo) return
  astate.view = null // the record this was opened from would cover the dialog
  openAction(record.deviceId, undo, undefined, {
    params: record.result?.before?.restore ?? {},
    reason: clipUtf8(`Undo of run ${record.runId}: ${record.reason}`, MAX_REASON_BYTES)
  })
}

export function useActions() {
  return {
    astate,
    ensure,
    loadOffers,
    offer,
    fixesFor,
    openAction,
    closeDialog,
    preview,
    run,
    abort,
    openExec,
    runExec,
    openUndo,
    closeExec: () => {
      astate.exec = null
    },
    viewRun: (runId: string | null) => {
      astate.view = runId
    }
  }
}
