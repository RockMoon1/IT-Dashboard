<script setup lang="ts">
import { computed, ref } from 'vue'
import { PURPOSES, type Purpose } from '@shared/types'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const choice = ref<Purpose>(state.purpose)
const description = computed(() => PURPOSES.find((p) => p.id === choice.value)?.description ?? '')

function close(): void {
  state.purposeModalOpen = false
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
    @click.self="close"
  >
    <form class="card w-full max-w-lg p-6" @submit.prevent="dash.choosePurpose(choice)">
      <h2 class="text-lg font-semibold">Select the main purpose</h2>
      <p class="mb-4 text-sm text-mist-500">{{ dash.selectedDevice.value?.name }}</p>
      <label class="label" for="purpose-select">Purpose</label>
      <select id="purpose-select" v-model="choice" class="field">
        <option v-for="p in PURPOSES" :key="p.id" :value="p.id">{{ p.label }}</option>
      </select>
      <p class="mt-2 min-h-10 text-sm text-mist-300">{{ description }}</p>
      <div class="mt-4 flex justify-end gap-2">
        <button class="btn-ghost" type="button" @click="close">Cancel</button>
        <button class="btn-primary" type="submit">Continue</button>
      </div>
    </form>
  </div>
</template>
