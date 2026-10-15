<script setup lang="ts">
import { computed, ref } from 'vue'
import { PURPOSES, type Purpose } from '@shared/types'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const choice = ref<Purpose>(state.purpose)
const device = computed(() => dash.selectedDevice.value)
const info = computed(() => PURPOSES.find((p) => p.id === choice.value))
const profile = computed(() => {
  const os = device.value?.os
  const target = choice.value === 'other' ? 'system-diagnostics' : choice.value
  return state.profiles.find((p) => p.os === os && p.purpose === target) ?? null
})
const onAgent = computed(() => {
  const p = profile.value
  if (!p || !device.value?.profiles) return null
  const found = device.value.profiles.find((x) => x.name === p.name)
  if (!found) return 'The agent on this device does not carry this profile. Update the agent.'
  if (found.version !== p.version)
    return `Agent has v${found.version}, dashboard has v${p.version}. Update the agent.`
  return null
})

function close(): void {
  state.purposeModalOpen = false
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
    @click.self="close"
  >
    <form class="card card-gold w-full max-w-lg p-6" @submit.prevent="dash.confirmPurpose(choice)">
      <p class="eyebrow">Select the main purpose</p>
      <h2 class="display mt-1 text-2xl">{{ device?.displayName }}</h2>
      <p class="mb-4 text-xs text-mist-500">
        {{ device?.hostname }} · {{ device?.os }} ·
        {{ device?.connected ? 'connected' : 'not connected' }}
      </p>
      <label class="label" for="purpose-select">Purpose</label>
      <select id="purpose-select" v-model="choice" class="field">
        <option v-for="p in PURPOSES" :key="p.id" :value="p.id">
          {{ p.label }}{{ p.id === device?.suggestedPurpose ? ' · suggested' : '' }}
        </option>
      </select>
      <p class="mt-2 min-h-10 text-sm text-mist-300">{{ info?.description }}</p>
      <p v-if="device?.suggestedPurpose" class="text-xs text-gold-300">
        Suggested: {{ PURPOSES.find((p) => p.id === device?.suggestedPurpose)?.label }} —
        {{ device?.suggestionReason }}
      </p>
      <div
        v-if="profile"
        class="mt-3 rounded-[3px] border border-white/5 bg-ink-950 p-3 text-xs text-mist-300"
      >
        <p>
          <span class="text-mist-500">Profile</span> {{ profile.name }} v{{ profile.version }} ·
          {{ profile.checks }} read-only checks
        </p>
        <p class="mt-1">
          <span class="text-mist-500">Categories</span> {{ profile.categories.join(', ') }}
        </p>
        <p v-if="onAgent" class="mt-2 text-warn-400">{{ onAgent }}</p>
      </div>
      <p v-else class="mt-3 text-xs text-warn-400">
        No profile for {{ device?.os }} / {{ choice }}.
      </p>
      <div class="mt-5 flex items-center justify-between">
        <span class="text-[11px] text-mist-700"
          >The scan starts as soon as you confirm. Nothing is written to the vault without a
          preview.</span
        >
        <div class="flex gap-2">
          <button class="btn-ghost" type="button" @click="close">Cancel</button>
          <button
            class="btn-gold"
            type="submit"
            :disabled="!profile || !!onAgent || !device?.connected"
          >
            Run scan
          </button>
        </div>
      </div>
    </form>
  </div>
</template>
