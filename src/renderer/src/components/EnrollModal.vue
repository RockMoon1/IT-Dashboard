<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const remaining = computed(() => {
  const e = state.enrollment
  if (!e) return ''
  const ms = Date.parse(e.expiresAt) - now.value
  if (ms <= 0) return 'expired'
  return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')} left`
})

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable */
  }
}

function close(): void {
  state.enrollOpen = false
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
    @click.self="close"
  >
    <div class="card card-gold w-full max-w-2xl p-6">
      <p class="eyebrow">One-time enrollment</p>
      <h2 class="display mt-1 text-2xl">Enroll a device</h2>
      <ol class="mt-3 list-decimal space-y-1 pl-5 text-sm text-mist-300">
        <li>
          Connect the device to this PC with the link cable and wait for the adapter to come up.
        </li>
        <li>Generate a token below. It is valid for 10 minutes and works once.</li>
        <li>
          On the device, copy <code>arh-agent</code> from the dashboard's <code>agent</code> folder
          and run the install command as administrator / sudo.
        </li>
        <li>
          The agent hears this dashboard's beacon, verifies it with the token, and appears under
          <em>Enrolled devices</em>.
        </li>
      </ol>

      <form class="mt-4 flex items-end gap-2" @submit.prevent="dash.createEnrollment()">
        <div class="flex-1">
          <label class="label" for="enroll-label">Device label (optional)</label>
          <input
            id="enroll-label"
            v-model="state.enrollLabel"
            class="field"
            placeholder="Front desk laptop"
          />
        </div>
        <button class="btn-gold" type="submit">Generate token</button>
      </form>

      <div
        v-if="state.enrollment"
        class="mt-4 rounded-[3px] border border-gold-400/30 bg-ink-950 p-4"
      >
        <div class="flex items-center justify-between">
          <span class="eyebrow">Token · {{ remaining }}</span>
          <button
            class="btn-ghost px-2 py-1 text-[10px]"
            type="button"
            @click="copy(state.enrollment!.token)"
          >
            copy
          </button>
        </div>
        <p class="display mt-2 select-all text-3xl tracking-wider text-gold-300">
          {{ state.enrollment.token }}
        </p>
        <p class="mt-2 text-[11px] text-mist-500">
          Dashboard fingerprint (the agent pins this after the token proof):
          <span class="font-mono">{{ state.enrollment.hostFingerprint }}</span>
        </p>
        <div class="mt-3 space-y-2 text-xs">
          <div
            v-for="(cmd, os) in state.enrollment.commands"
            :key="os"
            class="flex items-center gap-2"
          >
            <span class="w-16 shrink-0 uppercase text-mist-500">{{ os }}</span>
            <code
              class="min-w-0 flex-1 truncate rounded bg-ink-800 px-2 py-1 font-mono text-mist-100"
              >{{ cmd }}</code
            >
            <button class="btn-ghost px-2 py-1 text-[10px]" type="button" @click="copy(cmd)">
              copy
            </button>
          </div>
        </div>
      </div>

      <div v-if="state.enrollments.length" class="mt-4">
        <p class="eyebrow mb-1">Active tokens</p>
        <ul class="space-y-1 text-xs">
          <li v-for="t in state.enrollments" :key="t.token" class="flex items-center gap-2">
            <code class="font-mono text-mist-300">{{ t.token }}</code>
            <span class="text-mist-500"
              >{{ t.label || '' }} · until {{ t.expiresAt.slice(11, 16) }} UTC</span
            >
            <button
              class="ml-auto text-bad-400"
              type="button"
              @click="dash.cancelEnrollment(t.token)"
            >
              revoke
            </button>
          </li>
        </ul>
      </div>

      <div class="mt-5 flex justify-end">
        <button class="btn-ghost" type="button" @click="close">Close</button>
      </div>
    </div>
  </div>
</template>
