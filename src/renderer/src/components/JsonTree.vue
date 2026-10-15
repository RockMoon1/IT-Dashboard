<script setup lang="ts">
import { computed } from 'vue'
import { fmt, isTabular } from '../results'

const props = defineProps<{ value: unknown; depth?: number }>()
const depth = computed(() => props.depth ?? 0)
const isObject = computed(
  () => props.value !== null && typeof props.value === 'object' && !Array.isArray(props.value)
)
const entries = computed(() =>
  isObject.value ? Object.entries(props.value as Record<string, unknown>) : []
)
const tabular = computed(() => isTabular(props.value))
const columns = computed(() => {
  if (!tabular.value) return []
  const cols = new Set<string>()
  for (const row of props.value as Array<Record<string, unknown>>)
    for (const k of Object.keys(row)) cols.add(k)
  return [...cols]
})
const isList = computed(() => Array.isArray(props.value) && !tabular.value)
</script>

<template>
  <table v-if="tabular" class="w-full text-xs">
    <thead>
      <tr class="text-left text-mist-500">
        <th v-for="c in columns" :key="c" class="border-b border-white/5 py-1 pr-3 font-medium">
          {{ c }}
        </th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="(row, i) in props.value as Array<Record<string, unknown>>"
        :key="i"
        class="border-b border-white/5 align-top"
      >
        <td v-for="c in columns" :key="c" class="py-1 pr-3 break-words">{{ fmt(row[c]) }}</td>
      </tr>
    </tbody>
  </table>
  <ul v-else-if="isList" class="space-y-1 text-xs">
    <li
      v-for="(item, i) in props.value as unknown[]"
      :key="i"
      class="border-l border-white/10 pl-2"
    >
      <JsonTree :value="item" :depth="depth + 1" />
    </li>
    <li v-if="(props.value as unknown[]).length === 0" class="text-mist-700">empty</li>
  </ul>
  <dl
    v-else-if="isObject"
    class="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-0.5 text-xs"
  >
    <template v-for="[k, v] in entries" :key="k">
      <dt class="truncate text-mist-500" :title="k">{{ k }}</dt>
      <dd class="min-w-0 break-words">
        <JsonTree v-if="v !== null && typeof v === 'object'" :value="v" :depth="depth + 1" />
        <span v-else>{{ fmt(v) }}</span>
      </dd>
    </template>
    <span v-if="entries.length === 0" class="text-mist-700">empty</span>
  </dl>
  <span v-else class="text-xs">{{ fmt(props.value) }}</span>
</template>
