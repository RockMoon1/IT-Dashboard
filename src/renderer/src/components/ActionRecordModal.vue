<script setup lang="ts">
import { computed } from 'vue'
import { useActions } from '../actions'
import ActionRun from './ActionRun.vue'

/* A past action or custom command, from the history on a computer page. Read only. */
const acts = useActions()
const record = computed(() =>
  acts.astate.view ? acts.astate.records[acts.astate.view] : undefined
)
</script>

<template>
  <div
    v-if="record"
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
    @click.self="acts.viewRun(null)"
  >
    <div class="card flex max-h-full w-full max-w-3xl flex-col overflow-hidden">
      <header class="flex items-start justify-between border-b border-white/5 px-6 py-4">
        <div>
          <p class="eyebrow">{{ record.displayName }} · {{ record.hostname }}</p>
          <h2 class="display mt-1 text-xl">{{ record.title }}</h2>
          <p class="text-xs text-mist-500">
            why: {{ record.reason || 'n/a' }} · by {{ record.technician || 'n/a' }}
          </p>
        </div>
        <button class="btn-ghost px-2 py-1" title="Close" @click="acts.viewRun(null)">✕</button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <ActionRun :record="record" />
      </div>
    </div>
  </div>
</template>
