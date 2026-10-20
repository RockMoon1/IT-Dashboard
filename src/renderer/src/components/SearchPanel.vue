<script setup lang="ts">
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
</script>

<template>
  <div class="space-y-4 p-6">
    <form class="flex gap-2" @submit.prevent="dash.runSearch()">
      <input
        v-model="state.searchQuery"
        class="field"
        placeholder="Search every note in the vault (case-insensitive)…"
      />
      <button class="btn-gold" type="submit" :disabled="state.searching">
        {{ state.searching ? 'Searching…' : 'Search' }}
      </button>
    </form>
    <p class="text-xs text-mist-500">
      {{ state.searchHits.length }} hit(s){{
        state.searchHits.length >= 100 ? ' (showing the first 100)' : ''
      }}
    </p>
    <ul class="space-y-2">
      <li
        v-for="h in state.searchHits"
        :key="`${h.file}:${h.line}`"
        class="card cursor-pointer p-3 text-xs hover:bg-ink-800"
        title="Open the note at this line"
        @click="dash.viewNote(h.file, h.line)"
      >
        <p class="text-gold-300">
          {{ h.file }} <span class="text-mist-700">· line {{ h.line }}</span>
        </p>
        <pre class="mt-1 whitespace-pre-wrap break-words font-mono text-mist-500">{{
          h.before.join('\n')
        }}</pre>
        <pre class="whitespace-pre-wrap break-words font-mono text-mist-100">{{ h.text }}</pre>
        <pre class="whitespace-pre-wrap break-words font-mono text-mist-500">{{
          h.after.join('\n')
        }}</pre>
      </li>
    </ul>
  </div>
</template>
