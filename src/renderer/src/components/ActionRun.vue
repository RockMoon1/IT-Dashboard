<script setup lang="ts">
import { computed, ref } from 'vue'
import { changedItems, type ActionRecord, type Measurement } from '@shared/actions'
import { useActions } from '../actions'
import { actionBadge, duration, when } from '../format'

/*
  One action or custom command as the device reported it: a PREVIEW or REAL banner, the status
  worked out from the measurements, every measured item before → after, and what the device
  said (notes, warnings, evidence). Output is behind a toggle; it is not saved for custom
  commands unless Settings says so.
*/
const props = defineProps<{ record: ActionRecord }>()
const acts = useActions()
const showOutput = ref(false)

const r = computed(() => props.record)
const res = computed(() => r.value.result)
const badge = computed(() => actionBadge(r.value.status))
const real = computed(() => r.value.mode === 'apply')
const output = computed(
  () => acts.astate.output[r.value.runId] ?? r.value.checks.map((c) => c.stdout + c.stderr).join('')
)

/** Rows for the before/after table: every item, changed or not. */
const rows = computed(() => {
  const before = res.value?.before
  const after = res.value?.after
  const moved = new Set(changedItems(before, after).map((c) => c.item))
  const names = [...new Set([...(before?.items ?? []), ...(after?.items ?? [])].map((i) => i.item))]
  const get = (m: Measurement | undefined, n: string): string =>
    m?.items?.find((i) => i.item === n)?.value ?? ''
  return names.map((n) => ({
    item: n,
    before: get(before, n),
    after: get(after, n),
    moved: moved.has(n)
  }))
})

const phases = computed(() =>
  r.value.checks.map((c) => ({ ...c, label: c.title.split(' · ').pop() ?? c.id }))
)
const def = computed(() =>
  r.value.action ? acts.offer(r.value.deviceId, r.value.action)?.def : undefined
)
const canUndo = computed(
  () =>
    real.value &&
    !!def.value?.undo &&
    (r.value.status === 'changed' ||
      r.value.status === 'partly-applied' ||
      r.value.status === 'not-verified' ||
      r.value.status === 'done') &&
    r.value.kind === 'action'
)
const canAbort = computed(() => !r.value.endedAt && r.value.status === 'running')
const notes = computed(() => [
  ...(res.value?.before?.notes ?? []),
  ...(res.value?.apply?.notes ?? []),
  ...(res.value?.after?.notes ?? [])
])
const warnings = computed(() => [
  ...(res.value?.before?.warnings ?? []),
  ...(res.value?.apply?.warnings ?? [])
])
const evidence = computed(() => res.value?.apply?.changes ?? [])
const took = computed(() =>
  r.value.endedAt ? duration(Date.parse(r.value.endedAt) - Date.parse(r.value.requestedAt)) : ''
)
</script>

<template>
  <div class="space-y-3">
    <div
      class="flex items-center justify-between rounded-[3px] border px-3 py-2 text-xs"
      :class="real ? 'border-gold-400/40 bg-gold-400/5' : 'border-info-400/30 bg-info-400/5'"
    >
      <span class="font-semibold tracking-wide" :class="real ? 'text-gold-300' : 'text-info-400'">
        {{ real ? 'REAL RUN' : 'PREVIEW · measured only, nothing changed' }}
      </span>
      <span class="text-mist-500"
        >{{ r.kind === 'exec' ? 'custom command' : `${r.action} v${r.version}` }} · run
        {{ r.runId }} · {{ r.link === 'cable' ? 'USB cable' : r.link }}</span
      >
    </div>

    <div class="flex items-center gap-3">
      <span class="text-base font-semibold" :class="badge.cls"
        >{{ badge.icon }} {{ badge.text }}</span
      >
      <span v-if="res?.skipped" class="text-xs text-mist-500">{{ res.skipped }}</span>
      <span class="ml-auto text-[11px] text-mist-700"
        >{{ when(r.requestedAt) }}{{ took ? ` · ${took}` : '' }}</span
      >
      <button v-if="canAbort" class="btn-ghost px-2 py-0.5 text-xs" @click="acts.abort(r.runId)">
        Stop
      </button>
    </div>
    <p v-if="r.error" class="text-xs text-warn-400">{{ r.error }}</p>
    <p v-if="r.status === 'unknown'" class="text-xs text-warn-400">
      No result has come back yet (the link was lost, or the device did not answer). A started
      change finishes on the device, which reports on the next connection; the Change Log gets an
      "outcome unknown" row now and the result when it comes.
    </p>
    <p v-if="r.status === 'not-verified'" class="text-xs text-warn-400">
      The change was applied, but measuring afterwards could not confirm it (it failed, was blocked,
      missed a value, or the device stopped mid-run). Check the device; the Change Log says the
      same.
    </p>

    <ol v-if="phases.length" class="flex flex-wrap gap-2 text-[11px]">
      <li
        v-for="c in phases"
        :key="c.id"
        class="rounded-[3px] border px-2 py-0.5"
        :class="
          c.status === 'ok'
            ? 'border-ok-400/30 text-ok-400'
            : c.status === 'running'
              ? 'border-info-400/40 text-info-400'
              : c.status === 'pending'
                ? 'border-white/10 text-mist-500'
                : 'border-bad-400/40 text-bad-400'
        "
      >
        {{
          c.status === 'ok'
            ? '✓'
            : c.status === 'running'
              ? '…'
              : c.status === 'pending'
                ? '○'
                : '✗'
        }}
        {{ c.label }}{{ c.durationMs ? ` · ${(c.durationMs / 1000).toFixed(1)} s` : '' }}
      </li>
    </ol>

    <p v-if="res?.before?.plan" class="text-sm text-mist-100">
      <span class="text-mist-500">{{ real ? 'Plan was' : 'Would' }}:</span> {{ res.before.plan }}
    </p>
    <ul v-if="res?.before?.blockers?.length" class="space-y-0.5 text-xs text-bad-400">
      <li v-for="b in res.before.blockers" :key="b">⛔ {{ b }}</li>
    </ul>
    <ul v-if="warnings.length" class="space-y-0.5 text-xs text-warn-400">
      <li v-for="w in warnings" :key="w">⚠ {{ w }}</li>
    </ul>

    <table v-if="rows.length" class="w-full text-xs">
      <thead>
        <tr class="text-left text-mist-500">
          <th class="py-1 pr-3 font-medium">Measured</th>
          <th class="py-1 pr-3 font-medium">{{ real ? 'Before' : 'Now' }}</th>
          <th v-if="real" class="py-1 pr-3 font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.item" class="border-t border-white/5">
          <td class="py-1 pr-3 text-mist-300">{{ row.item }}</td>
          <td class="py-1 pr-3 text-mist-100">{{ row.before }}</td>
          <td
            v-if="real"
            class="py-1 pr-3"
            :class="row.moved ? 'font-semibold text-gold-300' : 'text-mist-500'"
          >
            {{ row.after || (r.endedAt ? '(not measured)' : '…') }}{{ row.moved ? ' ●' : '' }}
          </td>
        </tr>
      </tbody>
    </table>
    <dl
      v-if="res?.before?.info?.length"
      class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-[11px]"
    >
      <template v-for="i in res.before.info" :key="i.item">
        <dt class="text-mist-500">{{ i.item }}</dt>
        <dd class="min-w-0 break-words text-mist-300">{{ i.value }}</dd>
      </template>
    </dl>
    <ul v-if="evidence.length" class="space-y-0.5 text-xs text-gold-300">
      <li v-for="e in evidence" :key="e">● {{ e }}</li>
    </ul>
    <ul v-if="notes.length" class="space-y-0.5 text-[11px] text-mist-500">
      <li v-for="n in notes" :key="n">{{ n }}</li>
    </ul>
    <p v-if="r.kind === 'exec' && res" class="text-xs text-mist-300">
      Exit code {{ res.exitCode ?? 'n/a' }} · sha256 {{ (r.scriptSha256 ?? '').slice(0, 12) }} ·
      {{ r.scriptLines }} line(s). Nothing about its effect is measured.
    </p>

    <div class="flex items-center gap-2">
      <button class="btn-ghost px-2 py-0.5 text-xs" @click="showOutput = !showOutput">
        {{ showOutput ? 'Hide' : 'Show' }} output
      </button>
      <button
        v-if="canUndo"
        class="btn-ghost px-2 py-0.5 text-xs"
        title="Preview the undo with the values measured before this run"
        @click="acts.openUndo(r)"
      >
        Undo…
      </button>
    </div>
    <pre
      v-if="showOutput"
      class="max-h-64 overflow-auto rounded-[3px] border border-white/5 bg-ink-950 p-2 font-mono text-[11px] whitespace-pre-wrap text-mist-300"
      >{{ output || '(no output)' }}</pre
    >
  </div>
</template>
