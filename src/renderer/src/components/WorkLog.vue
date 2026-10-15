<script setup lang="ts">
import { purposeLabel, type Purpose } from '@shared/types'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash

function label(p: string): string {
  return purposeLabel(p as Purpose)
}

// Kept out of the template: Prettier strips the ';' between inline statements, which the Vue
// compiler then parses as a single expression.
function openRun(runId: string): void {
  dash.showRun(runId)
  state.tab = 'results'
}
</script>

<template>
  <div class="space-y-6 p-6">
    <section>
      <div class="flex items-center justify-between">
        <div>
          <p class="eyebrow">Scan log · app data, not the vault</p>
          <h2 class="display text-2xl">Recent scans</h2>
        </div>
        <button class="btn-ghost" @click="dash.refreshHistory()">Refresh</button>
      </div>
      <table class="mt-3 w-full text-xs">
        <thead>
          <tr class="text-left text-mist-500">
            <th class="py-1 pr-3 font-medium">When</th>
            <th class="py-1 pr-3 font-medium">Device</th>
            <th class="py-1 pr-3 font-medium">Purpose</th>
            <th class="py-1 pr-3 font-medium">Profile</th>
            <th class="py-1 pr-3 font-medium">Technician</th>
            <th class="py-1 pr-3 font-medium">Duration</th>
            <th class="py-1 pr-3 font-medium">Status</th>
            <th class="py-1 pr-3 font-medium">Findings</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="h in state.history"
            :key="h.runId"
            class="cursor-pointer border-t border-white/5 hover:bg-ink-800"
            @click="openRun(h.runId)"
          >
            <td class="py-1 pr-3">{{ h.ts.replace('T', ' ').slice(0, 16) }}</td>
            <td class="py-1 pr-3">
              {{ h.hostname }}<span class="text-mist-700"> {{ h.serial }}</span>
            </td>
            <td class="py-1 pr-3">{{ label(h.purpose) }}</td>
            <td class="py-1 pr-3 text-mist-500">{{ h.profile }} v{{ h.version }}</td>
            <td class="py-1 pr-3">{{ h.technician }}</td>
            <td class="py-1 pr-3">{{ (h.durationMs / 1000).toFixed(0) }} s</td>
            <td class="py-1 pr-3" :class="h.status === 'ok' ? 'text-ok-400' : 'text-bad-400'">
              {{ h.status }}
            </td>
            <td class="py-1 pr-3">
              {{ h.findings
              }}<span v-if="h.critical" class="text-bad-400"> ({{ h.critical }} critical)</span>
            </td>
          </tr>
          <tr v-if="state.history.length === 0">
            <td colspan="8" class="py-3 text-mist-500">No scans logged yet.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <div class="flex items-center justify-between">
        <div>
          <p class="eyebrow">Parsed from the vault (read-only)</p>
          <h2 class="display text-2xl">Work log</h2>
          <p class="text-xs text-mist-500">{{ state.workLog?.source }}</p>
        </div>
        <button class="btn-ghost" @click="dash.refreshWorkLog()">Refresh</button>
      </div>
      <p v-if="state.workLog?.error" class="mt-2 text-sm text-warn-400">
        {{ state.workLog.error }}
      </p>
      <div
        v-for="e in state.workLog?.entries ?? []"
        :key="`${e.file}:${e.heading}`"
        class="mt-3 card p-3"
      >
        <p class="display text-lg text-gold-300">{{ e.heading }}</p>
        <pre class="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-mist-300">{{
          e.lines.join('\n')
        }}</pre>
      </div>
      <p
        v-if="!state.workLog?.error && (state.workLog?.entries.length ?? 0) === 0"
        class="mt-2 text-sm text-mist-500"
      >
        No dated entries found.
      </p>
    </section>
  </div>
</template>
