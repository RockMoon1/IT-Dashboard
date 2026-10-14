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
  hubSection: 'Device Scans',
  autoLog: true,
  workLogNewestFirst: false,
  usbPollMs: 10000,
  networkDiscovery: true,
  networkRefreshMs: 60000,
  strictHostKeys: false,
  knownHosts: {},
  defaultUsername: ''
}

const form = reactive<Settings>(JSON.parse(JSON.stringify(state.settings ?? fallback)) as Settings)
const saving = ref(false)

function close(): void {
  state.settingsOpen = false
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await dash.saveSettings({ ...form, knownHosts: { ...form.knownHosts } })
    close()
  } finally {
    saving.value = false
  }
}

function forgetHost(id: string): void {
  delete form.knownHosts[id]
}
</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end bg-black/60" @click.self="close">
    <form
      class="flex h-full w-[520px] flex-col overflow-y-auto border-l border-ink-700 bg-ink-900 p-6"
      @submit.prevent="save"
    >
      <h2 class="mb-4 text-lg font-semibold">Settings</h2>

      <h3 class="label">Obsidian vault</h3>
      <label class="mb-3 block">
        <span class="text-xs text-mist-500">Vault folder</span>
        <input v-model="form.vaultPath" class="field" spellcheck="false" />
      </label>
      <div class="mb-3 grid grid-cols-2 gap-3">
        <label class="block">
          <span class="text-xs text-mist-500">Hub note</span>
          <input v-model="form.hubNote" class="field" />
        </label>
        <label class="block">
          <span class="text-xs text-mist-500">Work log note</span>
          <input v-model="form.workLogNote" class="field" />
        </label>
      </div>
      <label class="mb-3 block">
        <span class="text-xs text-mist-500">Hub section heading (H2) for device scans</span>
        <input v-model="form.hubSection" class="field" />
      </label>
      <label class="mb-2 flex items-center gap-2 text-sm">
        <input v-model="form.autoLog" type="checkbox" /> Append every finished session to the vault
        automatically
      </label>
      <label class="mb-4 flex items-center gap-2 text-sm">
        <input v-model="form.workLogNewestFirst" type="checkbox" /> New work-log dates go at the top
        (default: bottom)
      </label>
      <div v-if="state.vaultCheck" class="mb-5 rounded-md border border-ink-700 p-3 text-xs">
        <p v-if="state.vaultCheck.problems.length === 0" class="text-ok-400">
          Hub and work log found. Section "{{ form.hubSection }}"
          {{
            state.vaultCheck.hubSectionExists
              ? 'exists'
              : 'will be created inside the hub note on first write'
          }}.
        </p>
        <ul v-else class="list-disc pl-4 text-bad-400">
          <li v-for="p in state.vaultCheck.problems" :key="p">{{ p }}</li>
        </ul>
        <p class="mt-1 text-mist-500">The app never creates notes. Fix paths here, then Save.</p>
      </div>

      <h3 class="label">Discovery</h3>
      <div class="mb-3 grid grid-cols-2 gap-3">
        <label class="block">
          <span class="text-xs text-mist-500">USB fallback poll (ms)</span>
          <input
            v-model.number="form.usbPollMs"
            class="field"
            type="number"
            min="2000"
            step="1000"
          />
        </label>
        <label class="block">
          <span class="text-xs text-mist-500">Network refresh (ms)</span>
          <input
            v-model.number="form.networkRefreshMs"
            class="field"
            type="number"
            min="10000"
            step="5000"
          />
        </label>
      </div>
      <label class="mb-4 flex items-center gap-2 text-sm">
        <input v-model="form.networkDiscovery" type="checkbox" /> Discover LAN hosts from the ARP
        neighbour table
      </label>

      <h3 class="label">Remoting</h3>
      <label class="mb-3 block">
        <span class="text-xs text-mist-500">Default username</span>
        <input v-model="form.defaultUsername" class="field" placeholder="DOMAIN\\tech or tech" />
      </label>
      <label class="mb-3 flex items-center gap-2 text-sm">
        <input v-model="form.strictHostKeys" type="checkbox" /> Strict SSH host keys (reject unknown
        hosts instead of recording them)
      </label>
      <div class="mb-6">
        <span class="text-xs text-mist-500">Known SSH host keys (SHA-256)</span>
        <p v-if="Object.keys(form.knownHosts).length === 0" class="text-xs text-mist-500">
          none recorded
        </p>
        <ul class="mt-1 space-y-1">
          <li v-for="(fp, id) in form.knownHosts" :key="id" class="flex items-center gap-2 text-xs">
            <span class="w-40 shrink-0 truncate">{{ id }}</span>
            <span class="flex-1 truncate font-mono text-mist-500" :title="fp">{{ fp }}</span>
            <button type="button" class="text-bad-400" @click="forgetHost(String(id))">
              forget
            </button>
          </li>
        </ul>
      </div>

      <div class="mt-auto flex justify-between">
        <span class="self-center text-xs text-mist-500">{{ state.appInfo?.settingsFile }}</span>
        <div class="flex gap-2">
          <button class="btn-ghost" type="button" @click="close">Cancel</button>
          <button class="btn-primary" type="submit" :disabled="saving">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
