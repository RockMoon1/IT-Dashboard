<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useDashboard, type Tab } from './store'
import DeviceList from './components/DeviceList.vue'
import LookupBox from './components/LookupBox.vue'
import ComputersTab from './components/ComputersTab.vue'
import PurposeModal from './components/PurposeModal.vue'
import EnrollModal from './components/EnrollModal.vue'
import ActiveScan from './components/ActiveScan.vue'
import ResultsTree from './components/ResultsTree.vue'
import HealthPanel from './components/HealthPanel.vue'
import OpenLoops from './components/OpenLoops.vue'
import WorkLog from './components/WorkLog.vue'
import SearchPanel from './components/SearchPanel.vue'
import LinkPanel from './components/LinkPanel.vue'
import PreviewModal from './components/PreviewModal.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import NoteDrawer from './components/NoteDrawer.vue'
import StatusBar from './components/StatusBar.vue'

const dash = useDashboard()
const { state } = dash

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'computer', label: 'Computers' },
  { id: 'scan', label: 'Active scan' },
  { id: 'results', label: 'Results' },
  { id: 'health', label: 'Health' },
  { id: 'loops', label: 'Open loops' },
  { id: 'worklog', label: 'Work log' },
  { id: 'search', label: 'Search' },
  { id: 'link', label: 'Link' }
]

const vaultMode = computed(() => (state.vault?.live ? 'LIVE' : 'DRY-RUN'))
const linkPill = computed(() => {
  if (!state.link) return { text: 'Link …', cls: 'text-mist-500 border-mist-700' }
  if (!state.link.listening) return { text: 'Link off', cls: 'text-bad-400 border-bad-400/50' }
  const n = state.devices.filter((d) => d.connected).length
  return {
    text: `Link tcp/${state.link.port} · ${n} connected`,
    cls: 'text-ok-400 border-ok-400/40'
  }
})
const firewallPill = computed(() => {
  const p = state.link?.firewallRulePresent
  if (p == null) return null
  return p
    ? { text: 'Firewall rule ok', cls: 'text-ok-400 border-ok-400/40' }
    : { text: 'Firewall rule missing', cls: 'text-warn-400 border-warn-400/50' }
})

// The Computers tab always lands on the list; a profile opens from a click or a lookup.
function openTab(id: Tab): void {
  if (id === 'computer' && state.tab === 'computer' && state.profile) dash.closeProfile()
  state.tab = id
}

onMounted(() => {
  void dash.init()
})
</script>

<template>
  <div class="flex h-screen flex-col">
    <header
      class="flex items-center justify-between border-b border-white/5 bg-ink-900/90 px-6 py-3 backdrop-blur"
    >
      <div class="flex items-center gap-4">
        <div
          class="flex h-9 w-9 items-center justify-center rounded-[3px] bg-gold-400 font-bold text-ink-950"
        >
          A
        </div>
        <div>
          <h1 class="display text-[22px] leading-none text-mist-100">ARH IT Dashboard</h1>
          <p class="eyebrow mt-1">Advanced Regenerative Health · virtual IT workstation</p>
        </div>
      </div>
      <LookupBox v-if="!state.bridgeMissing" class="mx-6 flex-1" />
      <div class="flex items-center gap-2">
        <span class="badge border" :class="linkPill.cls">{{ linkPill.text }}</span>
        <span v-if="firewallPill" class="badge border" :class="firewallPill.cls">{{
          firewallPill.text
        }}</span>
        <button
          class="badge border"
          :class="
            state.vault?.live
              ? 'border-warn-400/60 text-warn-400'
              : 'border-gold-400/40 text-gold-300'
          "
          title="Vault write mode. Dry-run shows diffs without touching notes."
          @click="state.tab = 'health'"
        >
          Vault {{ vaultMode }}
        </button>
        <button class="btn-gold" :disabled="!state.link?.listening" @click="dash.openEnroll()">
          Enroll device
        </button>
        <button class="btn-ghost" :disabled="state.busy !== null" @click="dash.refreshLink()">
          Refresh
        </button>
        <button class="btn-ghost" @click="state.settingsOpen = true">Settings</button>
      </div>
    </header>

    <div
      v-if="state.error"
      class="flex items-center justify-between border-b border-bad-400/40 bg-bad-400/10 px-6 py-2 text-sm text-bad-400"
    >
      <span>{{ state.error }}</span>
      <button class="text-xs underline" @click="dash.clearError()">dismiss</button>
    </div>
    <div
      v-if="state.busy"
      class="border-b border-gold-400/20 bg-gold-400/5 px-6 py-1 text-xs text-gold-300"
    >
      {{ state.busy }}
    </div>

    <main
      v-if="state.bridgeMissing"
      class="flex flex-1 items-center justify-center p-10 text-center text-mist-300"
    >
      <div class="max-w-md">
        <p class="display mb-2 text-2xl">Preload bridge not available</p>
        <p class="text-sm">
          The renderer must run inside Electron (<code>npm run dev</code>). The preload script
          exposes <code>window.arh</code>; it is missing here.
        </p>
      </div>
    </main>

    <main v-else class="grid min-h-0 flex-1 grid-cols-[360px_1fr]">
      <DeviceList />
      <section class="flex min-h-0 flex-col">
        <nav class="flex items-center gap-1 border-b border-white/5 px-4">
          <button
            v-for="t in tabs"
            :key="t.id"
            class="tab"
            :class="{ 'tab-active': state.tab === t.id }"
            @click="openTab(t.id)"
          >
            {{ t.label }}
            <span v-if="t.id === 'loops' && state.loops" class="ml-1 text-mist-700">{{
              state.loops.overdue ? `· ${state.loops.overdue} overdue` : ''
            }}</span>
          </button>
        </nav>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <ComputersTab v-if="state.tab === 'computer'" />
          <ActiveScan v-else-if="state.tab === 'scan'" />
          <ResultsTree v-else-if="state.tab === 'results'" />
          <HealthPanel v-else-if="state.tab === 'health'" />
          <OpenLoops v-else-if="state.tab === 'loops'" />
          <WorkLog v-else-if="state.tab === 'worklog'" />
          <SearchPanel v-else-if="state.tab === 'search'" />
          <LinkPanel v-else />
        </div>
      </section>
    </main>

    <StatusBar />
    <PurposeModal v-if="state.purposeModalOpen" />
    <EnrollModal v-if="state.enrollOpen" />
    <PreviewModal v-if="state.previewOpen" />
    <SettingsPanel v-if="state.settingsOpen" />
    <NoteDrawer v-if="state.noteHistory.length" />
  </div>
</template>
