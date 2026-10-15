<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { Settings } from '@shared/types'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash

const fallback: Settings = {
  vaultPath: '',
  hubNote: 'ARH IT Hub.md',
  workLogNote: 'ARH Work Log.md',
  openLoopsNote: 'ARH Open Loops.md',
  vaultLive: false,
  schemaApproved: false,
  dueStyle: 'tasks-emoji',
  technician: '',
  beaconAllAdapters: false,
  usbPollMs: 10000,
  adapterPollMs: 15000,
  linkPort: 47912
}
const form = reactive<Settings>({ ...(state.settings ?? fallback) })
const saving = ref(false)

function close(): void {
  state.settingsOpen = false
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await dash.saveSettings({ ...form })
    close()
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end bg-black/70" @click.self="close">
    <form
      class="flex h-full w-[560px] flex-col overflow-y-auto border-l border-white/5 bg-ink-900 p-6"
      @submit.prevent="save"
    >
      <p class="eyebrow">Settings</p>
      <h2 class="display mb-4 text-2xl">Dashboard</h2>

      <h3 class="label">Obsidian vault</h3>
      <label class="mb-3 block">
        <span class="text-xs text-mist-500">Vault folder</span>
        <input v-model="form.vaultPath" class="field" spellcheck="false" />
      </label>
      <div class="mb-3 grid grid-cols-3 gap-3">
        <label class="block"
          ><span class="text-xs text-mist-500">Hub note</span
          ><input v-model="form.hubNote" class="field"
        /></label>
        <label class="block"
          ><span class="text-xs text-mist-500">Work log note</span
          ><input v-model="form.workLogNote" class="field"
        /></label>
        <label class="block"
          ><span class="text-xs text-mist-500">Open loops note</span
          ><input v-model="form.openLoopsNote" class="field"
        /></label>
      </div>
      <label class="mb-3 block">
        <span class="text-xs text-mist-500">Due-date style for generated tasks</span>
        <select v-model="form.dueStyle" class="field">
          <option value="tasks-emoji">Tasks plugin · 📅 2026-10-21</option>
          <option value="dataview">Dataview · [due:: 2026-10-21]</option>
          <option value="plain">Plain · (due: 2026-10-21)</option>
          <option value="none">No due date</option>
        </select>
      </label>
      <div class="mb-4 rounded-[3px] border border-gold-400/30 bg-ink-950 p-3 text-xs">
        <label class="flex items-start gap-2">
          <input v-model="form.schemaApproved" type="checkbox" class="mt-0.5" />
          <span
            ><strong class="text-gold-300">Vault schema approved.</strong> Tick only after reviewing
            the inspection report and the proposed note mapping. Until then every write is a dry
            run.</span
          >
        </label>
        <label class="mt-2 flex items-start gap-2" :class="{ 'opacity-40': !form.schemaApproved }">
          <input
            v-model="form.vaultLive"
            type="checkbox"
            class="mt-0.5"
            :disabled="!form.schemaApproved"
          />
          <span
            ><strong class="text-warn-400">Live writes.</strong> Apply previews to the real notes
            (atomic replace, first-write backup, conflict-copy check).</span
          >
        </label>
        <p v-if="state.vault" class="mt-2 text-mist-500">Backups: {{ state.vault.backupsDir }}</p>
      </div>

      <h3 class="label">Technician</h3>
      <label class="mb-4 block">
        <span class="text-xs text-mist-500"
          >Name recorded as the approving technician on every scan</span
        >
        <input v-model="form.technician" class="field" placeholder="Lisandro" />
      </label>

      <h3 class="label">Link</h3>
      <div class="mb-3 grid grid-cols-3 gap-3">
        <label class="block"
          ><span class="text-xs text-mist-500">TLS port (restart)</span
          ><input v-model.number="form.linkPort" class="field" type="number" min="1024" max="65535"
        /></label>
        <label class="block"
          ><span class="text-xs text-mist-500">Adapter poll (ms)</span
          ><input
            v-model.number="form.adapterPollMs"
            class="field"
            type="number"
            min="3000"
            step="1000"
        /></label>
        <label class="block"
          ><span class="text-xs text-mist-500">USB poll (ms)</span
          ><input
            v-model.number="form.usbPollMs"
            class="field"
            type="number"
            min="2000"
            step="1000"
        /></label>
      </div>
      <label class="mb-6 flex items-center gap-2 text-sm">
        <input v-model="form.beaconAllAdapters" type="checkbox" /> Beacon on every adapter, not only
        cable links (for testing on a LAN or VM)
      </label>

      <div class="mt-auto flex items-center justify-between">
        <span class="text-[11px] text-mist-700">{{ state.appInfo?.settingsFile }}</span>
        <div class="flex gap-2">
          <button class="btn-ghost" type="button" @click="close">Cancel</button>
          <button class="btn-gold" type="submit" :disabled="saving">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
