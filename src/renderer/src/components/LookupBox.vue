<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ComputerSummary } from '@shared/types'
import { useDashboard } from '../store'
import { scoreBadge } from '../format'

/*
  "Who is calling about which computer?" Type a name, serial, IP, MAC, room or a person's name.
  Computers come from enrollment, stored scans and Asset Inventory; the last row searches the
  whole vault for the word. Ctrl+K focuses, arrows move, Enter opens, Esc closes.
*/
const dash = useDashboard()
const { state } = dash

const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const open = ref(false)
const index = ref(0)
let timer: ReturnType<typeof setTimeout> | null = null

const result = computed(() =>
  state.lookup && state.lookup.query === query.value.trim() ? state.lookup : null
)
const computers = computed<ComputerSummary[]>(() => result.value?.computers.slice(0, 8) ?? [])
const showVaultRow = computed(() => query.value.trim().length >= 3)
const rows = computed(() => computers.value.length + (showVaultRow.value ? 1 : 0))

watch(query, (q) => {
  index.value = 0
  if (timer) clearTimeout(timer)
  const text = q.trim()
  if (!text) {
    open.value = false
    return
  }
  open.value = true
  timer = setTimeout(() => void dash.runLookup(text), 120)
})

function choose(i: number): void {
  const c = computers.value[i]
  const text = query.value.trim()
  if (c) void dash.openProfile({ key: c.key })
  else if (text) void dash.openProfile({ term: text })
  open.value = false
  input.value?.blur()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') index.value = Math.min(rows.value - 1, index.value + 1)
  else if (e.key === 'ArrowUp') index.value = Math.max(0, index.value - 1)
  else if (e.key === 'Enter') choose(index.value)
  else if (e.key === 'Escape') {
    open.value = false
    input.value?.blur()
  } else return
  e.preventDefault()
}

function onGlobalKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    input.value?.focus()
    input.value?.select()
    if (query.value.trim()) open.value = true
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

function closeSoon(): void {
  // let a click on a row land before the list disappears
  setTimeout(() => (open.value = false), 150)
}
</script>

<template>
  <div class="relative w-full max-w-[520px]">
    <input
      ref="input"
      v-model="query"
      class="field py-1.5 pr-14"
      placeholder="Look up a computer: name, serial, IP, room, person…"
      spellcheck="false"
      aria-label="Look up a computer"
      @keydown="onKey"
      @focus="open = query.trim().length > 0"
      @blur="closeSoon"
    />
    <span
      class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-[2px] border border-white/10 px-1 text-[10px] text-mist-700"
      >Ctrl K</span
    >
    <div
      v-if="open"
      class="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-[4px] border border-white/10 bg-ink-900 shadow-2xl"
    >
      <button
        v-for="(c, i) in computers"
        :key="c.key"
        class="flex w-full items-center gap-3 px-3 py-2 text-left"
        :class="i === index ? 'bg-ink-700' : 'hover:bg-ink-800'"
        @mousedown.prevent="choose(i)"
        @mouseenter="index = i"
      >
        <span class="w-4 text-center text-xs" :class="scoreBadge(c.health).cls">{{
          scoreBadge(c.health).icon
        }}</span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm text-mist-100">
            {{ c.name }}
            <span v-if="c.connected" class="ml-1 text-[10px] text-ok-400">● connected</span>
          </span>
          <span class="block truncate text-[11px] text-mist-500">
            {{ [c.match, c.location, c.room, c.model].filter(Boolean).join(' · ') }}
          </span>
        </span>
        <span class="text-[10px] text-mist-700">{{ scoreBadge(c.health).text }}</span>
      </button>
      <button
        v-if="showVaultRow"
        class="flex w-full items-center gap-3 border-t border-white/5 px-3 py-2 text-left text-sm"
        :class="index === computers.length ? 'bg-ink-700' : 'hover:bg-ink-800'"
        @mousedown.prevent="choose(computers.length)"
        @mouseenter="index = computers.length"
      >
        <span class="w-4 text-center text-xs text-gold-300">⌕</span>
        <span class="flex-1 text-mist-300">
          Everything in the vault about “{{ query.trim() }}”
          <span v-if="result" class="text-mist-500"
            >· {{ result.vaultNotes }} note{{ result.vaultNotes === 1 ? '' : 's' }}</span
          >
        </span>
      </button>
      <p v-if="result" class="border-t border-white/5 px-3 py-1 text-[10px] text-mist-700">
        {{ result.computers.length }} computer{{ result.computers.length === 1 ? '' : 's' }} ·
        {{ result.tookMs }} ms · works offline
      </p>
    </div>
  </div>
</template>
