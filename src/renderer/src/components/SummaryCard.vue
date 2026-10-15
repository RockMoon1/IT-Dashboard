<script setup lang="ts">
import { computed } from 'vue'
import { purposeLabel } from '@shared/types'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const summary = computed(() => state.summary)
const metrics = computed(() => Object.entries(summary.value?.metrics ?? {}))

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}
</script>

<template>
  <div v-if="summary" class="card p-4">
    <div class="mb-3 flex items-start justify-between gap-4">
      <div>
        <h3 class="label mb-1">4 · Result</h3>
        <p class="text-sm">
          <span
            class="badge mr-2"
            :class="summary.ok ? 'bg-ok-400/15 text-ok-400' : 'bg-bad-400/15 text-bad-400'"
            >{{ summary.ok ? 'OK' : 'Failed' }}</span
          >
          {{ purposeLabel(summary.purpose) }} on <strong>{{ summary.deviceName }}</strong> via
          {{ summary.protocol }} · {{ summary.results.length }} command(s) · session
          {{ summary.sessionId }}
        </p>
        <p v-if="summary.error" class="mt-1 text-sm text-bad-400">{{ summary.error }}</p>
      </div>
      <div class="shrink-0 text-right text-xs">
        <p v-if="state.vault" class="text-ok-400">
          Logged to the vault<br /><span class="text-mist-500">{{ state.vault.hubPath }}</span>
        </p>
        <p v-else-if="state.vaultError" class="text-bad-400">
          Vault write failed: {{ state.vaultError }}
        </p>
        <button
          v-if="!state.vault"
          type="button"
          class="btn-ghost mt-2"
          @click="dash.appendToVault()"
        >
          Append to Obsidian
        </button>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div>
        <h4 class="label">Findings ({{ summary.findings.length }})</h4>
        <ul v-if="summary.findings.length" class="list-disc space-y-1 pl-5 text-sm">
          <li v-for="f in summary.findings" :key="f" class="text-warn-400">{{ f }}</li>
        </ul>
        <p v-else class="text-sm text-mist-500">Nothing crossed the configured thresholds.</p>
      </div>
      <div>
        <h4 class="label">Metrics</h4>
        <table v-if="metrics.length" class="w-full text-xs">
          <tbody>
            <tr v-for="[k, v] in metrics" :key="k" class="border-t border-ink-700">
              <td class="py-1 pr-3 align-top text-mist-500">{{ k }}</td>
              <td class="py-1 align-top">{{ v }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="text-sm text-mist-500">No structured metrics for this purpose.</p>
      </div>
    </div>

    <details class="mt-4">
      <summary class="cursor-pointer text-xs text-mist-500">Per-command results</summary>
      <ul class="mt-2 space-y-2">
        <li
          v-for="r in summary.results"
          :key="r.id"
          class="rounded-md border border-ink-700 p-2 text-xs"
        >
          <div class="flex items-center justify-between">
            <span
              :class="
                r.exitCode === 0 && !r.timedOut
                  ? 'text-ok-400'
                  : r.optional
                    ? 'text-warn-400'
                    : 'text-bad-400'
              "
              >{{ r.title }}</span
            >
            <span class="text-mist-500"
              >exit {{ r.exitCode ?? 'n/a' }} · {{ seconds(r.durationMs)
              }}{{ r.timedOut ? ' · timed out' : '' }}{{ r.optional ? ' · optional' : '' }}</span
            >
          </div>
          <pre
            v-if="r.stderr.trim()"
            class="mt-1 whitespace-pre-wrap break-words font-mono text-bad-400"
            >{{ r.stderr.trim() }}</pre
          >
        </li>
      </ul>
    </details>
  </div>
</template>
