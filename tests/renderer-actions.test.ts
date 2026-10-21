import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

/*
  The page's action store (src/renderer/src/actions.ts) run under node against a fake preload
  bridge. Vue is not installed for these tests, so a stand-in takes its place with the effect
  scope rules that matter here, as Vue 3.5 has them: a watch made while a scope runs is stopped
  with that scope (Vue turns a component's scope on around its onMounted), a child scope stops
  with its parent, and effectScope(true) is not collected by the scope around it. Watchers run
  when flush() is called, as Vue's scheduler runs them before the next render.
*/

interface Stoppable {
  stop(): void
}
interface Scope extends Stoppable {
  run<T>(fn: () => T): T
}
interface Watcher {
  source: () => unknown
  cb: (value: unknown, old: unknown) => void
  value: unknown
  stopped: boolean
}

let activeScope: { effects: Stoppable[] } | undefined
const watchers: Watcher[] = []
const vue = {
  reactive: <T>(target: T): T => target,
  toRaw: <T>(value: T): T => value,
  computed: <T>(get: () => T) => ({
    get value(): T {
      return get()
    }
  }),
  effectScope(detached = false): Scope {
    const effects: Stoppable[] = []
    const scope: Scope = {
      run(fn) {
        const outer = activeScope
        activeScope = { effects }
        try {
          return fn()
        } finally {
          activeScope = outer
        }
      },
      stop: () => effects.forEach((e) => e.stop())
    }
    if (!detached) activeScope?.effects.push(scope)
    return scope
  },
  watch(source: () => unknown, cb: Watcher['cb']): () => void {
    const w: Watcher = { source, cb, value: source(), stopped: false }
    const stop = (): void => {
      w.stopped = true
    }
    activeScope?.effects.push({ stop })
    watchers.push(w)
    return stop
  }
}
function flush(): void {
  for (const w of watchers) {
    if (w.stopped) continue
    const value = w.source()
    if (Object.is(value, w.value)) continue
    const old = w.value
    w.value = value
    w.cb(value, old)
  }
}
Object.assign(globalThis, { vueStandIn: vue })
const vueModule = `export const { ${Object.keys(vue).join(', ')} } = globalThis.vueStandIn`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vue')
      return { url: `data:text/javascript,${encodeURIComponent(vueModule)}`, shortCircuit: true }
    // the renderer leaves out the .ts on its own modules (the bundler adds it)
    if (context.parentURL?.includes('/src/renderer/') && /^\.\.?\/[^.]*$/.test(specifier))
      return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  }
})

const offersAsked: string[] = []
let previewAnswer: () => unknown = () => {
  throw new Error('no preview expected')
}
Object.assign(globalThis, {
  window: {
    arh: {
      actions: {
        onEvent: () => {},
        list: async () => [],
        offers: async (deviceId: string) => {
          offersAsked.push(deviceId)
          return []
        },
        preview: async () => previewAnswer()
      },
      settings: { set: async (patch: object) => ({ technician: 'Sam', ...patch }) },
      vault: { status: async () => null },
      link: { status: async () => null }
    }
  }
})

interface Dialog {
  previewId: string | null
  error: string | null
}
const { useActions } = (await import(
  new URL('../src/renderer/src/actions.ts', import.meta.url).href
)) as {
  useActions: () => {
    astate: { dialog: Dialog | null }
    loadOffers(deviceId: string): Promise<void>
    openAction(deviceId: string, action: string): void
    preview(): Promise<void>
  }
}
const { useDashboard } = (await import(
  new URL('../src/renderer/src/store.ts', import.meta.url).href
)) as { useDashboard: () => { saveSettings(patch: object): Promise<boolean> } }
const acts = useActions()
const dash = useDashboard()
const settle = (): Promise<void> => new Promise((r) => setImmediate(r))

// runs first: the first ensure() of the session comes from this page
test('a Settings Save asks for the offers again after the page that first loaded them is gone', async () => {
  const page = vue.effectScope()
  await page.run(() => acts.loadOffers('dev-1'))
  page.stop() // the technician leaves the computer page
  offersAsked.length = 0
  assert.equal(await dash.saveSettings({ disabledActions: ['windows-dns-flush'] }), true)
  flush()
  await settle()
  assert.deepEqual(offersAsked, ['dev-1'], 'what Settings allow is part of each offer')
})

test('a refused Preview again keeps the preview that is still measuring in the dialog', async () => {
  previewAnswer = () => ({ runId: 'p-1', mode: 'preview', status: 'running', checks: [] })
  acts.openAction('dev-1', 'windows-dns-flush')
  await settle()
  assert.equal(acts.astate.dialog?.previewId, 'p-1')
  previewAnswer = () => {
    throw new Error(
      "Error invoking remote method 'actions:preview': Error: Front desk is busy with the action Flush the DNS cache"
    )
  }
  await acts.preview()
  assert.equal(acts.astate.dialog?.previewId, 'p-1', 'its result still shows when it ends')
  assert.equal(acts.astate.dialog?.error, 'Front desk is busy with the action Flush the DNS cache')
})
