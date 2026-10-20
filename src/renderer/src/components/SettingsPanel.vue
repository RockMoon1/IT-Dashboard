<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { ActionDef } from '@shared/actions'
import type { Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/settings-defaults'
import { useDashboard } from '../store'
import { impactBadge } from '../format'

const dash = useDashboard()
const { state } = dash

const fallback: Settings = { ...DEFAULT_SETTINGS, disabledActions: [] }
const current = state.settings ?? fallback
const form = reactive<Settings>({ ...current, disabledActions: [...current.disabledActions] })
const saving = ref(false)

/* Access and control: one switch per kind of work, and one per action. */
const catalog = ref<ActionDef[]>([])
const catalogError = ref('')
onMounted(async () => {
  try {
    catalog.value = await window.arh.actions.catalog()
  } catch (err) {
    catalogError.value = err instanceof Error ? err.message : String(err)
  }
})
const OS_LABEL: Record<string, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }
const grouped = computed(() => {
  const m = new Map<string, ActionDef[]>()
  for (const a of [...catalog.value].sort(
    (x, y) => x.category.localeCompare(y.category) || x.title.localeCompare(y.title)
  )) {
    const key = `${OS_LABEL[a.os] ?? a.os} · ${a.category}`
    m.set(key, [...(m.get(key) ?? []), a])
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})
function actionOn(name: string): boolean {
  return !form.disabledActions.includes(name)
}
function setAction(name: string, on: boolean): void {
  form.disabledActions = on
    ? form.disabledActions.filter((n) => n !== name)
    : [...new Set([...form.disabledActions, name])]
}
function kindOff(a: ActionDef): boolean {
  return a.access === 'write' ? !form.deviceWrite : !form.deviceExecute
}

function close(): void {
  state.settingsOpen = false
}

async function save(): Promise<void> {
  saving.value = true
  try {
    // a copy with no reactive arrays in it; the panel stays open if main did not take it
    if (await dash.saveSettings({ ...form, disabledActions: [...form.disabledActions] })) close()
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
      <div class="mb-3 grid grid-cols-2 gap-3">
        <label class="block"
          ><span class="text-xs text-mist-500">Computers table (asset note)</span
          ><input v-model="form.assetNote" class="field"
        /></label>
        <label class="block"
          ><span class="text-xs text-mist-500">Open loops note</span
          ><input v-model="form.openLoopsNote" class="field"
        /></label>
        <label class="block"
          ><span class="text-xs text-mist-500">Work log note</span
          ><input v-model="form.workLogNote" class="field"
        /></label>
        <label class="block"
          ><span class="text-xs text-mist-500">Hub note (empty: leave the hub alone)</span
          ><input v-model="form.hubNote" class="field"
        /></label>
        <label class="col-span-2 block"
          ><span class="text-xs text-mist-500"
            >Change Log note (one row per change made on a device; empty: never written)</span
          ><input v-model="form.changeLogNote" class="field"
        /></label>
      </div>
      <label class="mb-3 block">
        <span class="text-xs text-mist-500">Due-date style for generated tasks</span>
        <select v-model="form.dueStyle" class="field">
          <option value="tasks-emoji">Tasks plugin · 📅 2026-10-21</option>
          <option value="dataview">Dataview · [due:: 2026-10-21]</option>
          <option value="plain">Plain · (due: 2026-10-21)</option>
          <option value="none">No due date (what the ARH vault uses)</option>
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
          >Name recorded on every scan and every change (required before any change)</span
        >
        <input v-model="form.technician" class="field" placeholder="Lisandro" />
      </label>

      <h3 class="label">Access and control</h3>
      <div class="mb-3 space-y-1.5 rounded-[3px] border border-white/5 bg-ink-950 p-3 text-xs">
        <p class="text-[11px] text-mist-500">Vault</p>
        <label class="flex items-center gap-2"
          ><input v-model="form.vaultRead" type="checkbox" /> Read notes (lookups, the note
          viewer)</label
        >
        <label class="flex items-center gap-2"
          ><input v-model="form.vaultAutoWrite" type="checkbox" /> Write the dashboard's sections
          after every scan or action (when live)</label
        >
        <p class="pt-2 text-[11px] text-mist-500">Devices</p>
        <label class="flex items-center gap-2"
          ><input v-model="form.deviceScan" type="checkbox" /> Read: scans and previews</label
        >
        <label class="flex items-center gap-2"
          ><input v-model="form.deviceWrite" type="checkbox" /> Write: actions that change a
          setting</label
        >
        <label class="flex items-center gap-2"
          ><input v-model="form.deviceExecute" type="checkbox" /> Execute: actions that run a task
          (update, resync, restart…)</label
        >
        <label class="flex items-center gap-2"
          ><input v-model="form.customCommands" type="checkbox" /> Custom commands (each device must
          also allow them)</label
        >
        <label class="flex items-center gap-2"
          ><input v-model="form.saveCustomOutput" type="checkbox" /> Keep custom command output in
          the action log (it can contain patient data)</label
        >
        <p class="pt-2 text-[11px] text-mist-500">Confirmation</p>
        <label class="flex items-center gap-2"
          ><input v-model="form.confirmChanges" type="checkbox" /> Ask before every change (always
          on for actions that interrupt work)</label
        >
        <label class="flex items-center gap-2"
          ><input v-model="form.previewFirst" type="checkbox" /> Preview first: a run must follow a
          preview of the same values (always on for actions that interrupt work)</label
        >
        <label class="block pt-2">
          <span class="text-[11px] text-mist-500"
            >What a newly enrolled device allows (its own policy, set by the install command)</span
          >
          <select v-model="form.installPolicy" class="field">
            <option value="actions">Named actions: write and execute (recommended)</option>
            <option value="full">Full: named actions and custom commands</option>
            <option value="clinical">Clinical: named actions that do not interrupt work</option>
            <option value="read">Read only: scans</option>
          </select>
        </label>
        <p class="text-[10px] text-mist-700">
          A device keeps its own policy: Settings here can narrow what the dashboard sends, never
          widen what a device allows. Change a device with arh-agent policy on that device.
        </p>
      </div>
      <details class="mb-4 rounded-[3px] border border-white/5 bg-ink-950 p-3 text-xs">
        <summary class="cursor-pointer text-mist-300">
          Actions, one by one ({{
            catalog.length -
            form.disabledActions.filter((n) => catalog.some((a) => a.name === n)).length
          }}
          of {{ catalog.length }} on)
        </summary>
        <p v-if="catalogError" class="mt-2 text-bad-400">{{ catalogError }}</p>
        <div v-for="[group, list] in grouped" :key="group" class="mt-3">
          <p class="mb-1 text-[11px] text-mist-500">{{ group }}</p>
          <label
            v-for="a in list"
            :key="a.name"
            class="flex items-start gap-2 py-0.5"
            :class="{ 'opacity-50': kindOff(a) }"
            :title="a.description"
          >
            <input
              type="checkbox"
              class="mt-0.5"
              :checked="actionOn(a.name)"
              @change="setAction(a.name, ($event.target as HTMLInputElement).checked)"
            />
            <span class="flex-1"
              >{{ a.title }}<span class="ml-1 text-mist-700">({{ a.access }})</span></span
            >
            <span
              class="rounded-[2px] border px-1 text-[10px]"
              :class="impactBadge(a.impact).cls"
              >{{ impactBadge(a.impact).text }}</span
            >
          </label>
        </div>
      </details>

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
