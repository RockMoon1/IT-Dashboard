<script setup lang="ts">
import { computed } from 'vue'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const connected = computed(
  () => state.devices.filter((d) => d.kind === 'enrolled' && d.connected).length
)
const enrolled = computed(() => state.devices.filter((d) => d.kind === 'enrolled').length)
</script>

<template>
  <footer
    class="flex items-center justify-between border-t border-white/5 bg-ink-900 px-6 py-1.5 text-[11px] text-mist-500"
  >
    <div class="flex items-center gap-4">
      <span>{{ connected }}/{{ enrolled }} devices connected</span>
      <span v-if="dash.runningRun.value" class="text-gold-300"
        >Scanning {{ dash.runningRun.value.hostname }} ·
        {{
          dash.runningRun.value.checks.filter(
            (c) => c.status === 'ok' || c.status === 'failed' || c.status === 'timeout'
          ).length
        }}/{{ dash.runningRun.value.checks.length }}</span
      >
      <span
        v-if="state.vault"
        :class="state.vault.problems.length ? 'text-warn-400' : 'text-ok-400'"
        >Vault {{ state.vault.problems.length ? state.vault.problems[0] : 'ready' }}</span
      >
    </div>
    <div v-if="state.appInfo" class="flex items-center gap-4">
      <span class="truncate" :title="state.link?.secretStore"
        >keys: {{ state.link?.secretStore?.split(' (')[0] }}</span
      >
      <span>v{{ state.appInfo.version }} · {{ state.appInfo.platform }}</span>
    </div>
  </footer>
</template>
