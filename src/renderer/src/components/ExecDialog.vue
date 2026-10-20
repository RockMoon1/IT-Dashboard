<script setup lang="ts">
import { computed } from 'vue'
import { useActions } from '../actions'
import { useDashboard } from '../store'
import ActionRun from './ActionRun.vue'

/*
  A command the technician types. It runs as SYSTEM (Windows) or root on the device, only over
  the cable, only when the device itself allows custom commands. Nothing about its effect is
  measured: the Change Log row says so and carries the script's hash, never its text or output.
*/
const acts = useActions()
const dash = useDashboard()
const x = computed(() => acts.astate.exec!)
const device = computed(() => dash.state.devices.find((d) => d.id === x.value.deviceId))
const run = computed(() => (x.value.runId ? acts.astate.records[x.value.runId] : undefined))
const shell = computed(() => (device.value?.os === 'windows' ? 'Windows PowerShell 5.1' : 'sh'))
const size = computed(() => new TextEncoder().encode(x.value.script).length)
const policy = computed(() => device.value?.capabilities?.policy)
const why = computed((): string | null => {
  if (!dash.state.settings?.customCommands) return 'Settings: custom commands are off.'
  if (!device.value?.connected) return 'The device is not connected.'
  if (!policy.value || !policy.value.custom)
    return 'This device does not allow custom commands. On the device, as administrator: arh-agent policy --allow custom'
  if (device.value.capabilities?.link !== 'cable' && !policy.value.lan)
    return 'Custom commands run only over the USB cable.'
  if (!x.value.script.trim()) return 'Type the command.'
  if (size.value > 64 * 1024) return 'The command is over 64 KiB.'
  if (!x.value.reason.trim()) return 'Say why: it goes to the Change Log.'
  if (!dash.state.settings?.technician.trim()) return 'Set your name in Settings first.'
  return null
})

function close(): void {
  if (run.value && !run.value.endedAt) return
  acts.closeExec()
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
    @click.self="close"
  >
    <div class="card card-gold flex max-h-full w-full max-w-3xl flex-col overflow-hidden">
      <header class="border-b border-white/5 px-6 py-4">
        <p class="eyebrow">
          Custom command · {{ shell }} · runs as {{ device?.os === 'windows' ? 'SYSTEM' : 'root' }}
        </p>
        <h2 class="display mt-1 text-2xl">{{ device?.displayName }}</h2>
        <p class="text-xs text-mist-500">{{ device?.hostname }}</p>
        <p class="mt-2 text-xs text-warn-400">
          Nothing about its effect is measured, and it cannot be previewed or undone from here. The
          command text is kept in this computer's action log; its output is shown here and
          {{ dash.state.settings?.saveCustomOutput ? 'also saved (Settings)' : 'not saved' }}.
          Output can contain patient data: do not list user folders or documents.
        </p>
      </header>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
        <template v-if="!x.runId">
          <div>
            <label class="label" for="exec-script">Command ({{ size }} bytes)</label>
            <textarea
              id="exec-script"
              v-model="x.script"
              class="field min-h-40 font-mono text-[12px]"
              spellcheck="false"
              :placeholder="
                device?.os === 'windows'
                  ? 'Get-Service Spooler | Format-List *'
                  : 'systemctl status cups'
              "
            ></textarea>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div>
              <label class="label" for="exec-timeout">Time limit (seconds)</label>
              <input
                id="exec-timeout"
                v-model.number="x.timeoutSeconds"
                type="number"
                min="1"
                max="3600"
                class="field"
              />
            </div>
            <div class="col-span-2">
              <label class="label" for="exec-reason">Why (goes to the Change Log)</label>
              <input id="exec-reason" v-model="x.reason" class="field" maxlength="500" />
            </div>
          </div>
        </template>
        <ActionRun v-if="run" :record="run" />
        <p v-if="x.error" class="text-sm text-bad-400">{{ x.error }}</p>
      </div>
      <footer class="flex items-center justify-between gap-3 border-t border-white/5 px-6 py-3">
        <p class="text-xs text-mist-500">{{ x.runId ? '' : (why ?? 'Ready.') }}</p>
        <div class="flex gap-2">
          <button
            class="btn-ghost px-4 py-1.5"
            :disabled="!!run && !run.endedAt"
            @click="acts.closeExec()"
          >
            {{ x.runId ? 'Close' : 'Cancel' }}
          </button>
          <button
            v-if="!x.runId"
            class="btn-gold px-4 py-1.5"
            :disabled="!!why || x.busy"
            @click="acts.runExec()"
          >
            Run on {{ device?.hostname }}
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
