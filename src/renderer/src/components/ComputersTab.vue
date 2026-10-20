<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDashboard } from '../store'
import { ago, scoreBadge } from '../format'
import ComputerProfile from './ComputerProfile.vue'

const dash = useDashboard()
const { state } = dash
const filter = ref('')

const list = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return state.computers
  return state.computers.filter((c) =>
    [c.name, c.serial, c.room, c.location, c.model, c.ip, ...c.aliases]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q))
  )
})
const counts = computed(() => ({
  critical: state.computers.filter((c) => c.health === 'critical').length,
  attention: state.computers.filter((c) => c.health === 'attention').length,
  never: state.computers.filter((c) => !c.scans).length
}))
</script>

<template>
  <ComputerProfile v-if="state.profile || state.profileLoading" />
  <div v-else class="space-y-5 p-6">
    <div class="flex items-end justify-between gap-4">
      <div>
        <p class="eyebrow">Enrollment · stored scans · Asset Inventory · the vault</p>
        <h2 class="display text-2xl">Computers</h2>
        <p class="text-xs text-mist-500">
          Everything here is on record, so a computer does not have to be plugged in. Click one, or
          press Ctrl K anywhere and type a name, serial, IP, room or person.
        </p>
      </div>
      <button class="btn-ghost" @click="dash.loadComputers()">Refresh</button>
    </div>

    <div class="grid grid-cols-4 gap-3">
      <div class="card p-3">
        <p class="text-[11px] text-mist-500">Computers on record</p>
        <p class="text-2xl font-semibold">{{ state.computers.length }}</p>
      </div>
      <div class="card p-3">
        <p class="text-[11px] text-mist-500">● Critical</p>
        <p class="text-2xl font-semibold">{{ counts.critical }}</p>
      </div>
      <div class="card p-3">
        <p class="text-[11px] text-mist-500">▲ Attention</p>
        <p class="text-2xl font-semibold">{{ counts.attention }}</p>
      </div>
      <div class="card p-3">
        <p class="text-[11px] text-mist-500">Never scanned</p>
        <p class="text-2xl font-semibold">{{ counts.never }}</p>
      </div>
    </div>

    <input v-model="filter" class="field" placeholder="Filter this list…" spellcheck="false" />

    <table class="w-full text-sm">
      <thead>
        <tr class="text-left text-[11px] text-mist-500">
          <th class="py-1 pr-3 font-medium">Computer</th>
          <th class="py-1 pr-3 font-medium">Health</th>
          <th class="py-1 pr-3 font-medium">Where</th>
          <th class="py-1 pr-3 font-medium">Model</th>
          <th class="py-1 pr-3 font-medium">Last scan</th>
          <th class="py-1 pr-3 font-medium">On record from</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="c in list"
          :key="c.key"
          class="cursor-pointer border-t border-white/5 hover:bg-ink-800"
          tabindex="0"
          @click="dash.openProfile({ key: c.key })"
          @keydown.enter="dash.openProfile({ key: c.key })"
        >
          <td class="py-2 pr-3">
            <span class="text-mist-100">{{ c.name }}</span>
            <span v-if="c.connected" class="ml-1 text-[10px] text-ok-400">● connected</span>
            <span v-if="c.serial" class="block text-[11px] text-mist-500">SN {{ c.serial }}</span>
          </td>
          <td class="py-2 pr-3 text-xs" :class="scoreBadge(c.health).cls">
            {{ scoreBadge(c.health).icon }} {{ scoreBadge(c.health).text }}
          </td>
          <td class="py-2 pr-3 text-xs text-mist-300">
            {{ [c.location, c.room].filter(Boolean).join(' · ') }}
          </td>
          <td class="py-2 pr-3 text-xs text-mist-300">{{ c.model }}</td>
          <td class="py-2 pr-3 text-xs text-mist-300">
            {{ c.lastScanAt ? ago(c.lastScanAt) : '' }}
            <span v-if="c.scans" class="text-mist-700"> · {{ c.scans }} total</span>
          </td>
          <td class="py-2 pr-3 text-[11px] text-mist-500">{{ c.sources.join(', ') }}</td>
        </tr>
        <tr v-if="!list.length">
          <td colspan="6" class="py-4 text-sm text-mist-500">
            {{
              state.computers.length
                ? 'Nothing matches the filter.'
                : 'No computers on record yet. Enroll one, or add rows to the Computers table in Asset Inventory.'
            }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
