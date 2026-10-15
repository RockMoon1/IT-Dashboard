<script setup lang="ts">
import { computed } from 'vue'
import type { HealthFinding, Severity } from '@shared/types'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const run = computed(() => dash.currentRun.value)
const health = computed(() => run.value?.health ?? null)

const groups = computed(() => {
  const by: Record<Severity, HealthFinding[]> = { critical: [], warning: [], info: [] }
  for (const f of health.value?.findings ?? []) by[f.severity].push(f)
  return by
})
const metrics = computed(() => Object.entries(health.value?.metrics ?? {}))

function scoreClass(score?: string): string {
  return score === 'critical'
    ? 'border-bad-400/60 text-bad-400'
    : score === 'attention'
      ? 'border-warn-400/60 text-warn-400'
      : 'border-ok-400/60 text-ok-400'
}
function sevClass(s: Severity): string {
  return s === 'critical' ? 'text-bad-400' : s === 'warning' ? 'text-warn-400' : 'text-info-400'
}
</script>

<template>
  <div class="space-y-5 p-6">
    <div class="card card-gold p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="eyebrow">Vault writes</p>
          <p class="mt-1 text-sm text-mist-300">
            Mode:
            <span :class="state.vault?.live ? 'text-warn-400' : 'text-gold-300'">{{
              state.vault?.live ? 'LIVE' : 'DRY-RUN'
            }}</span>
            <span v-if="!state.settings?.schemaApproved" class="text-mist-500">
              · the note schema is not approved yet, so writes stay as previews</span
            >
          </p>
          <ul v-if="state.vault?.problems.length" class="mt-2 list-disc pl-5 text-xs text-warn-400">
            <li v-for="p in state.vault.problems" :key="p">{{ p }}</li>
          </ul>
        </div>
        <div class="flex gap-2">
          <button class="btn-ghost" @click="dash.openVault()">Open vault</button>
          <button
            class="btn-gold"
            :disabled="!run || run.status === 'running'"
            @click="dash.openPreview()"
          >
            Preview vault write
          </button>
        </div>
      </div>
    </div>

    <div v-if="!health" class="p-6 text-center text-sm text-mist-500">
      Finish a scan to see its health summary.
    </div>
    <template v-else>
      <div class="flex items-center gap-4">
        <span class="badge border px-3 py-1 text-xs" :class="scoreClass(health.score)">{{
          health.score
        }}</span>
        <h2 class="display text-2xl">{{ run?.hostname }}</h2>
        <span class="text-xs text-mist-500"
          >{{ health.findings.length }} finding(s) ·
          {{ health.findings.filter((f) => f.loop).length }} would become open loops</span
        >
      </div>
      <div class="grid grid-cols-2 gap-5">
        <div class="space-y-4">
          <section v-for="sev in ['critical', 'warning', 'info'] as Severity[]" :key="sev">
            <h3 class="eyebrow mb-2" :class="sevClass(sev)">
              {{ sev }} <span class="text-mist-700">({{ groups[sev].length }})</span>
            </h3>
            <ul v-if="groups[sev].length" class="space-y-1 text-sm">
              <li
                v-for="f in groups[sev]"
                :key="f.id"
                class="flex gap-2 rounded-[3px] border border-white/5 bg-ink-900 px-3 py-2"
              >
                <span class="badge bg-ink-700 text-mist-300">{{ f.category }}</span>
                <span class="flex-1">{{ f.message }}</span>
                <span
                  v-if="f.loop"
                  class="text-[10px] text-gold-300"
                  title="Becomes an Open Loop task when written"
                  >loop</span
                >
              </li>
            </ul>
            <p v-else class="text-xs text-mist-700">none</p>
          </section>
        </div>
        <div class="card p-4">
          <h3 class="eyebrow mb-2">Metrics</h3>
          <table v-if="metrics.length" class="w-full text-xs">
            <tbody>
              <tr v-for="[k, v] in metrics" :key="k" class="border-t border-white/5">
                <td class="py-1 pr-3 align-top text-mist-500">{{ k }}</td>
                <td class="py-1 align-top break-words">{{ v }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="text-xs text-mist-700">No structured metrics for this purpose.</p>
        </div>
      </div>
    </template>
  </div>
</template>
