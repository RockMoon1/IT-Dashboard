<script setup lang="ts">
import { computed } from 'vue'
import { useDashboard } from '../store'

const { state } = useDashboard()

const counts = computed(() => {
  const present = state.devices.filter((d) => d.present)
  return {
    usb: present.filter((d) => d.kind === 'usb').length,
    network: present.filter((d) => d.kind === 'network').length
  }
})
</script>

<template>
  <footer
    class="flex items-center justify-between border-t border-ink-700 bg-ink-900 px-5 py-1.5 text-xs text-mist-500"
  >
    <div class="flex items-center gap-4">
      <span>USB {{ counts.usb }}</span>
      <span>Network {{ counts.network }}</span>
      <span v-if="state.running" class="text-gold-400">Session {{ state.sessionId }} running…</span>
      <span v-else-if="state.summary" :class="state.summary.ok ? 'text-ok-400' : 'text-bad-400'">
        Session {{ state.summary.sessionId }} {{ state.summary.ok ? 'OK' : 'failed' }}
      </span>
    </div>
    <div v-if="state.appInfo" class="flex items-center gap-4 truncate">
      <span :title="state.appInfo.powerShell">PowerShell: {{ state.appInfo.powerShell }}</span>
      <span>v{{ state.appInfo.version }} · {{ state.appInfo.platform }}</span>
    </div>
  </footer>
</template>
