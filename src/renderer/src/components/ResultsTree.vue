<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDashboard } from '../store'
import { resultsTree, statusMark } from '../results'
import JsonTree from './JsonTree.vue'

const dash = useDashboard()
const run = computed(() => dash.currentRun.value)
const tree = computed(() => (run.value ? resultsTree(run.value) : []))
const open = ref<Record<string, boolean>>({})

function toggle(id: string): void {
  open.value[id] = !open.value[id]
}
</script>

<template>
  <div v-if="!run" class="p-10 text-center text-sm text-mist-500">
    Run a scan to see results here.
  </div>
  <div v-else class="space-y-4 p-6">
    <div v-for="node in tree" :key="node.category" class="card">
      <div class="flex items-center justify-between border-b border-white/5 px-4 py-2">
        <h3 class="display text-lg">{{ node.category }}</h3>
        <span class="text-[11px] text-mist-500">{{ node.checks.length }} check(s)</span>
      </div>
      <div v-for="c in node.checks" :key="c.id" class="border-b border-white/5 last:border-b-0">
        <button
          class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-ink-800"
          @click="toggle(c.id)"
        >
          <span class="w-4 text-center" :class="statusMark(c.status).cls">{{
            statusMark(c.status).text
          }}</span>
          <span class="flex-1">{{ c.title }}</span>
          <span class="text-[11px] text-mist-700"
            >{{ (c.durationMs / 1000).toFixed(1) }} s{{ c.truncated ? ' · truncated' : '' }}</span
          >
          <span class="text-mist-500">{{ open[c.id] ? '▾' : '▸' }}</span>
        </button>
        <div v-if="open[c.id]" class="bg-ink-950 px-4 py-3">
          <JsonTree v-if="c.parsed !== null && c.parsed !== undefined" :value="c.parsed" />
          <pre
            v-else-if="c.text.trim()"
            class="whitespace-pre-wrap break-words font-mono text-[12px] leading-5"
            >{{ c.text }}</pre
          >
          <p v-else class="text-xs text-mist-700">No output.</p>
          <pre
            v-if="c.stderr.trim()"
            class="mt-2 whitespace-pre-wrap break-words font-mono text-[12px] text-bad-400"
            >{{ c.stderr }}</pre
          >
        </div>
      </div>
    </div>
  </div>
</template>
