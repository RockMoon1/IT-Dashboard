<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useDashboard } from '../store'

const { state } = useDashboard()
const box = ref<HTMLElement | null>(null)
const follow = ref(true)

watch(
  () => state.lines.length,
  async () => {
    if (!follow.value) return
    await nextTick()
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  }
)

function onScroll(): void {
  const el = box.value
  if (!el) return
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

function lineClass(stream: string): string {
  if (stream === 'status') return 'text-gold-400'
  if (stream === 'stderr') return 'text-bad-400'
  return 'text-mist-100'
}

function time(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false })
}

async function copyAll(): Promise<void> {
  const text = state.lines.map((l) => l.text).join('')
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<template>
  <div class="card flex h-[360px] flex-col">
    <div class="flex items-center justify-between border-b border-ink-700 px-4 py-2">
      <h3 class="label mb-0">3 · Live output</h3>
      <div class="flex items-center gap-3 text-xs text-mist-500">
        <label class="flex items-center gap-1"
          ><input v-model="follow" type="checkbox" /> follow</label
        >
        <button type="button" class="hover:text-mist-100" @click="copyAll">copy</button>
        <button
          type="button"
          class="hover:text-mist-100"
          :disabled="state.running"
          @click="state.lines = []"
        >
          clear
        </button>
      </div>
    </div>
    <div
      ref="box"
      class="min-h-0 flex-1 overflow-y-auto bg-ink-950 p-3 font-mono text-xs leading-5"
      @scroll="onScroll"
    >
      <p v-if="state.lines.length === 0" class="text-mist-500">
        Output from the target streams here as each command runs.
      </p>
      <div v-for="l in state.lines" :key="l.id" class="flex gap-3">
        <span class="w-16 shrink-0 select-none text-mist-500">{{ time(l.at) }}</span>
        <pre
          class="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words font-mono"
          :class="lineClass(l.stream)"
          >{{ l.text }}</pre
        >
      </div>
    </div>
  </div>
</template>
