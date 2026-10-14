<script setup lang="ts">
import { onMounted } from 'vue'
import { useDashboard } from './store'
import DeviceList from './components/DeviceList.vue'
import DevicePanel from './components/DevicePanel.vue'
import PurposeModal from './components/PurposeModal.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import StatusBar from './components/StatusBar.vue'

const dash = useDashboard()
const { state } = dash

onMounted(() => {
  void dash.init()
})
</script>

<template>
  <div class="flex h-screen flex-col bg-ink-950 text-mist-100">
    <header class="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-5 py-3">
      <div class="flex items-center gap-3">
        <div
          class="flex h-8 w-8 items-center justify-center rounded-md bg-gold-500 font-bold text-ink-950"
        >
          A
        </div>
        <div>
          <h1 class="text-base font-semibold leading-tight">ARH IT Dashboard</h1>
          <p class="text-xs text-mist-500">
            Device detection · remote diagnostics · Obsidian logging
          </p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="state.vaultCheck"
          class="badge border"
          :class="
            state.vaultCheck.problems.length
              ? 'border-bad-400/50 text-bad-400'
              : 'border-ok-400/50 text-ok-400'
          "
          :title="state.vaultCheck.problems.join('\n') || 'Hub and work log found'"
          @click="dash.openVault()"
        >
          Vault {{ state.vaultCheck.problems.length ? 'not ready' : 'ready' }}
        </button>
        <button class="btn-ghost" :disabled="state.running" @click="dash.refreshDevices()">
          Refresh devices
        </button>
        <button class="btn-ghost" @click="state.settingsOpen = true">Settings</button>
      </div>
    </header>

    <div
      v-if="state.error"
      class="flex items-center justify-between border-b border-bad-400/40 bg-bad-400/10 px-5 py-2 text-sm text-bad-400"
    >
      <span>{{ state.error }}</span>
      <button class="text-xs underline" @click="dash.clearError()">dismiss</button>
    </div>

    <main
      v-if="state.bridgeMissing"
      class="flex flex-1 items-center justify-center p-10 text-center text-mist-300"
    >
      <div class="max-w-md">
        <p class="mb-2 text-lg font-semibold">Preload bridge not available</p>
        <p class="text-sm">
          The renderer must run inside Electron (<code>npm run dev</code>). The preload script
          exposes <code>window.arh</code>; it is missing here.
        </p>
      </div>
    </main>

    <main v-else class="grid min-h-0 flex-1 grid-cols-[340px_1fr]">
      <DeviceList />
      <DevicePanel v-if="dash.selectedDevice.value" />
      <section v-else class="flex items-center justify-center p-10 text-center text-mist-500">
        <div class="max-w-md">
          <p class="mb-2 text-lg font-semibold text-mist-300">Select a device</p>
          <p class="text-sm">
            Double-click a device to choose the purpose of the visit. USB peripherals are listed for
            hardware triage; remote diagnostics need a network host (LAN neighbour or added by
            hand).
          </p>
        </div>
      </section>
    </main>

    <StatusBar />
    <PurposeModal v-if="state.purposeModalOpen" />
    <SettingsPanel v-if="state.settingsOpen" />
  </div>
</template>
