<script setup lang="ts">
import { computed } from 'vue'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const loops = computed(() => state.loops)
const sorted = computed(() =>
  [...(loops.value?.tasks ?? [])]
    .filter((t) => !t.done)
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) || (a.due ?? '9999').localeCompare(b.due ?? '9999')
    )
)
const done = computed(() => (loops.value?.tasks ?? []).filter((t) => t.done).length)
</script>

<template>
  <div class="space-y-5 p-6">
    <div class="flex items-center justify-between">
      <div>
        <p class="eyebrow">Parsed from the vault (read-only)</p>
        <h2 class="display text-2xl">Open loops and reminders</h2>
        <p class="text-xs text-mist-500">{{ loops?.source }}</p>
      </div>
      <button class="btn-ghost" @click="dash.refreshLoops()">Refresh</button>
    </div>
    <p v-if="loops?.error" class="text-sm text-warn-400">{{ loops.error }}</p>
    <div v-else class="grid grid-cols-3 gap-3">
      <div class="card p-3">
        <p class="eyebrow">Open</p>
        <p class="display text-3xl">{{ sorted.length }}</p>
      </div>
      <div class="card p-3">
        <p class="eyebrow text-bad-400">Overdue</p>
        <p class="display text-3xl text-bad-400">{{ loops?.overdue ?? 0 }}</p>
      </div>
      <div class="card p-3">
        <p class="eyebrow text-warn-400">Due within 3 days</p>
        <p class="display text-3xl text-warn-400">{{ loops?.dueSoon ?? 0 }}</p>
      </div>
    </div>
    <ul class="space-y-1">
      <li
        v-for="t in sorted"
        :key="`${t.file}:${t.line}`"
        class="flex items-center gap-3 rounded-[3px] border border-white/5 bg-ink-900 px-3 py-2 text-sm"
      >
        <span class="font-mono text-mist-700">[{{ t.status }}]</span>
        <span class="flex-1">{{ t.text }}</span>
        <span v-if="t.priority" class="text-gold-300">{{ t.priority }}</span>
        <span
          v-if="t.due"
          class="badge border"
          :class="
            t.overdue
              ? 'border-bad-400/50 text-bad-400'
              : t.dueSoon
                ? 'border-warn-400/50 text-warn-400'
                : 'border-white/10 text-mist-500'
          "
          >{{ t.due }}</span
        >
        <span class="text-[10px] text-mist-700">line {{ t.line }}</span>
      </li>
      <li v-if="!loops?.error && sorted.length === 0" class="text-sm text-mist-500">
        No open tasks in the note{{ done ? ` (${done} done)` : '' }}.
      </li>
    </ul>

    <section v-if="loops?.candidates.length" class="card card-gold p-4">
      <p class="eyebrow mb-2">From recent scans · written to the note only on apply</p>
      <ul class="space-y-1 text-sm">
        <li v-for="c in loops.candidates" :key="`${c.runId}:${c.finding.id}`" class="flex gap-2">
          <span class="badge bg-ink-700 text-mist-300">{{ c.hostname }}</span>
          <span class="flex-1" :class="c.finding.severity === 'critical' ? 'text-bad-400' : ''">{{
            c.finding.message
          }}</span>
          <span class="text-[10px] text-mist-700">{{ c.at.slice(0, 10) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
