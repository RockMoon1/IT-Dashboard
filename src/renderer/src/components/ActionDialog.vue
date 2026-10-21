<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { checkParam } from '@shared/actions'
import type { Purpose } from '@shared/types'
import { MAX_REASON_BYTES, useActions, utf8Length } from '../actions'
import { useDashboard } from '../store'
import { impactBadge, when } from '../format'
import ActionRun from './ActionRun.vue'

/*
  Confirm before changing anything (docs/PHASE3-DESIGN.md rule 10). The preview runs as soon as
  the dialog opens: it only measures. The dialog leads with what the preview found, asks why,
  answers the Change Log checklist from the measurements, and keeps the script behind a toggle.
  Run stays disabled until the preview says there is something to change and nothing blocks it.
*/
const acts = useActions()
const dash = useDashboard()
const d = computed(() => acts.astate.dialog!)
const offer = computed(() => acts.offer(d.value.deviceId, d.value.action))
const def = computed(() => offer.value?.def)
const device = computed(() => dash.state.devices.find((x) => x.id === d.value.deviceId))
const preview = computed(() =>
  d.value.previewId ? acts.astate.records[d.value.previewId] : undefined
)
const run = computed(() => (d.value.runId ? acts.astate.records[d.value.runId] : undefined))
const impact = computed(() => (def.value ? impactBadge(def.value.impact) : null))
const settings = computed(() => dash.state.settings)
// a clock the footer can follow: Date.now() alone never makes it check the preview's age again
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 15_000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const paramErrors = computed(() =>
  Object.fromEntries(
    (def.value?.params ?? []).map((p) => [p.name, checkParam(p, d.value.params[p.name] ?? '')])
  )
)
const paramsChanged = computed(
  () => !!preview.value && JSON.stringify(preview.value.params) !== JSON.stringify(withDefaults())
)
function withDefaults(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of def.value?.params ?? []) out[p.name] = d.value.params[p.name] || p.default
  return out
}

const warnings = computed(() => preview.value?.result?.before?.warnings ?? [])
const needName = computed(() => def.value?.impact === 'interrupts' && warnings.value.length > 0)
const nameOk = computed(
  () =>
    !needName.value ||
    d.value.confirmName.trim().toLowerCase() === (device.value?.hostname ?? '').trim().toLowerCase()
)

const why = computed((): string | null => {
  if (!def.value) return 'This action is not offered for this device.'
  if (offer.value?.blocked.length) return offer.value.blocked[0] ?? null
  if (!settings.value?.technician.trim())
    return 'Set your name in Settings first: every change records who made it.'
  if (Object.values(paramErrors.value).some(Boolean)) return 'Fix the values above.'
  if (!preview.value || !preview.value.endedAt)
    return d.value.busy || preview.value ? 'Waiting for the preview.' : 'Preview first.'
  if (paramsChanged.value) return 'The values changed since the preview: preview again.'
  if (preview.value.status !== 'would-change')
    return `The preview says "${preview.value.status.replace(/-/g, ' ')}".`
  // main refuses a preview older than 10 minutes, and one already used for a run
  if (now.value - Date.parse(preview.value.endedAt) > 10 * 60_000)
    return 'The preview is more than 10 minutes old: preview again.'
  if (!d.value.reason.trim()) return 'Say why: it goes to the Change Log.'
  if (utf8Length(d.value.reason.trim()) > MAX_REASON_BYTES)
    return `The reason is too long (at most ${MAX_REASON_BYTES} bytes; accented letters and symbols count 2 to 4).`
  if (!nameOk.value) return `Type ${device.value?.hostname} to confirm: someone is using it.`
  return null
})

const checklist = computed(() => {
  const p = preview.value
  const before = p?.result?.before
  const way = def.value?.undo
    ? `undo in the dashboard, with the values measured now${
        Object.keys(before?.restore ?? {}).length
          ? ` (${Object.entries(before?.restore ?? {})
              .map(([k, v]) => `${k} ${v}`)
              .join(', ')})`
          : ''
      }`
    : def.value?.manualUndo
      ? `by hand: ${def.value.manualUndo}`
      : 'none: this cannot be undone'
  const interrupt =
    def.value?.impact === 'interrupts'
      ? `yes, it interrupts work${warnings.value.length ? `; ${warnings.value[0]}` : ''}`
      : def.value?.impact === 'slows'
        ? 'it slows the computer while it runs'
        : (warnings.value[0] ?? 'not expected')
  return [
    [
      'Current state known',
      p?.endedAt ? `measured ${when(p.endedAt)} (the preview below)` : 'measuring…'
    ],
    ['Way back', way],
    ['Could this interrupt patient care right now?', interrupt]
  ] as Array<[string, string]>
})

// "Ask before every change" off: a Fix of a quiet action runs once the preview says so
watch(
  () => preview.value?.status,
  (status) => {
    if (
      status === 'would-change' &&
      settings.value?.confirmChanges === false &&
      def.value?.impact !== 'interrupts' &&
      d.value.fix &&
      !d.value.runId &&
      !why.value
    )
      void acts.run()
  }
)

// Closing never stops anything: a run keeps going in main and stays in the computer's history
// ("Changes and tasks on record"); only a request still on its way holds the dialog.
function close(): void {
  if (d.value.busy) return
  acts.closeDialog()
}

function scanAgain(): void {
  const purpose = d.value.fix?.profile
  dash.state.selectedId = d.value.deviceId
  if (purpose) void dash.confirmPurpose(purpose as Purpose)
  else dash.openPurposePrompt(d.value.deviceId)
  acts.closeDialog()
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
    @click.self="close"
  >
    <div class="card card-gold flex max-h-full w-full max-w-3xl flex-col overflow-hidden">
      <header class="border-b border-white/5 px-6 py-4">
        <p class="eyebrow">
          {{ def?.category }} · {{ def?.access === 'write' ? 'changes a setting' : 'runs a task' }}
          <span
            v-if="impact"
            class="ml-2 rounded-[2px] border px-1.5 py-0.5 text-[10px] normal-case"
            :class="impact.cls"
            >{{ impact.text }}</span
          >
        </p>
        <h2 class="display mt-1 text-2xl">{{ def?.title ?? d.action }}</h2>
        <p class="text-xs text-mist-500">
          {{ device?.displayName }} · {{ device?.hostname }} ·
          {{
            device?.capabilities?.link === 'cable'
              ? 'USB cable'
              : (device?.capabilities?.link ?? 'not connected')
          }}
        </p>
        <p class="mt-2 text-sm text-mist-300">{{ def?.description }}</p>
      </header>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
        <ul
          v-if="offer?.blocked.length"
          class="space-y-1 rounded-[3px] border border-bad-400/30 bg-bad-400/5 p-3 text-xs text-bad-400"
        >
          <li v-for="b in offer.blocked" :key="b">⛔ {{ b }}</li>
        </ul>

        <section v-if="def?.params.length && !d.runId" class="grid grid-cols-2 gap-3">
          <div v-for="p in def.params" :key="p.name">
            <label class="label" :for="`param-${p.name}`">{{ p.label }}</label>
            <select
              v-if="p.choices.length"
              :id="`param-${p.name}`"
              v-model="d.params[p.name]"
              class="field"
            >
              <option v-for="c in p.choices" :key="c" :value="c">
                {{ c }}{{ c === p.default ? ' (default)' : '' }}
              </option>
            </select>
            <input
              v-else
              :id="`param-${p.name}`"
              v-model="d.params[p.name]"
              class="field"
              :maxlength="p.maxLength"
              :placeholder="p.default || p.examples.ok[0]"
            />
            <p v-if="paramErrors[p.name]" class="mt-1 text-[11px] text-bad-400">
              {{ paramErrors[p.name] }}
            </p>
          </div>
        </section>

        <section v-if="!d.runId">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="eyebrow">Preview</h3>
            <!-- not while one is measuring: the device is busy with it and refuses another -->
            <button
              class="btn-ghost px-3 py-1 text-xs"
              :disabled="d.busy || (!!preview && !preview.endedAt)"
              @click="acts.preview()"
            >
              Preview again
            </button>
          </div>
          <p v-if="d.busy && !preview" class="text-sm text-mist-500">Sending the preview…</p>
          <ActionRun v-if="preview" :record="preview" />
        </section>

        <section v-if="!d.runId" class="space-y-3">
          <dl
            class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-[3px] border border-white/5 bg-ink-950 px-3 py-2 text-xs"
          >
            <template v-for="[k, v] in checklist" :key="k">
              <dt class="text-mist-500">{{ k }}</dt>
              <dd class="text-mist-100">{{ v }}</dd>
            </template>
          </dl>
          <div>
            <label class="label" for="action-reason">Why (goes to the Change Log)</label>
            <textarea
              id="action-reason"
              v-model="d.reason"
              class="field min-h-16"
              maxlength="500"
              placeholder="e.g. Front desk reports printing stopped; Spooler is stopped"
            ></textarea>
          </div>
          <div v-if="needName">
            <label class="label" for="action-confirm"
              >Someone is using {{ device?.hostname }}: type its name to confirm</label
            >
            <input
              id="action-confirm"
              v-model="d.confirmName"
              class="field"
              :placeholder="device?.hostname"
              autocomplete="off"
            />
          </div>
          <button
            class="text-[11px] text-mist-500 hover:text-gold-300"
            @click="d.showScript = !d.showScript"
          >
            {{ d.showScript ? 'Hide' : 'Show' }} the script that runs ({{ def?.shell }}, sha256
            {{ def?.sha256.slice(0, 12) }})
          </button>
          <div v-if="d.showScript && def" class="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <p class="text-[10px] text-mist-500">measure (preview and before/after)</p>
              <pre
                class="max-h-60 overflow-auto rounded-[3px] border border-white/5 bg-ink-950 p-2 font-mono text-[10px] whitespace-pre text-mist-300"
                >{{ def.measure.join('\n') }}</pre
              >
            </div>
            <div>
              <p class="text-[10px] text-mist-500">apply (real run only)</p>
              <pre
                class="max-h-60 overflow-auto rounded-[3px] border border-white/5 bg-ink-950 p-2 font-mono text-[10px] whitespace-pre text-mist-300"
                >{{ def.apply.join('\n') }}</pre
              >
            </div>
          </div>
        </section>

        <section v-if="run">
          <h3 class="eyebrow mb-2">Run</h3>
          <ActionRun :record="run" />
          <div
            v-if="run.endedAt && d.fix && run.status !== 'failed'"
            class="mt-3 text-xs text-mist-300"
          >
            <button class="btn-ghost px-3 py-1" @click="scanAgain">
              Scan again to confirm the finding is gone
            </button>
          </div>
        </section>

        <p v-if="d.error" class="text-sm text-bad-400">{{ d.error }}</p>
      </div>

      <footer class="flex items-center justify-between gap-3 border-t border-white/5 px-6 py-3">
        <p class="text-xs text-mist-500">
          {{
            d.runId
              ? ''
              : (why ??
                'Ready: the change is recorded in the action log, the Work Log and the Change Log.')
          }}
        </p>
        <div class="flex gap-2">
          <button
            class="btn-ghost px-4 py-1.5"
            :disabled="d.busy"
            :title="
              run && !run.endedAt
                ? 'The run goes on; it stays in this computer\'s history'
                : undefined
            "
            @click="close"
          >
            {{ run && !run.endedAt ? 'Close (keeps running)' : d.runId ? 'Close' : 'Cancel' }}
          </button>
          <button
            v-if="!d.runId"
            class="btn-gold px-4 py-1.5"
            :disabled="!!why || d.busy"
            @click="acts.run()"
          >
            Run on {{ device?.hostname }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
