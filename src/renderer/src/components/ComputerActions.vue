<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useActions } from '../actions'
import { useDashboard } from '../store'
import { actionBadge, impactBadge, when } from '../format'

/*
  What can be done on this computer: the named actions for its OS, grouped by category, each with
  what stands in the way of it right now (Settings, the device's own policy, the cable, the agent
  version), a custom command, and this computer's past actions.
*/
const props = defineProps<{ deviceId: string }>()
const acts = useActions()
const dash = useDashboard()
const device = computed(() => dash.state.devices.find((d) => d.id === props.deviceId))
const caps = computed(() => device.value?.capabilities)
const offers = computed(() => acts.astate.offers[props.deviceId] ?? [])
const groups = computed(() => {
  const m = new Map<string, typeof offers.value>()
  for (const o of offers.value) m.set(o.def.category, [...(m.get(o.def.category) ?? []), o])
  return [...m.entries()]
})
const history = computed(() =>
  acts.astate.history
    .filter((r) => r.deviceId === props.deviceId && r.mode === 'apply')
    .slice(0, 15)
)

const policyText = computed(() => {
  const p = caps.value?.policy
  if (!caps.value) return 'not connected'
  if (!p) return 'agent from before Phase 3: read only (update the agent)'
  if (p.error) return `read only: ${p.error}`
  const on = [
    p.write && 'write',
    p.execute && 'execute',
    p.custom && 'custom',
    p.lan && 'LAN',
    p.interrupts && 'interrupting actions'
  ].filter(Boolean)
  return `allows ${on.join(', ') || 'reading only'}${p.deny.length ? `; refuses ${p.deny.join(', ')}` : ''}`
})
const execBlocked = computed(() => {
  const p = caps.value?.policy
  if (!dash.state.settings?.customCommands) return 'Settings: custom commands are off'
  if (!caps.value) return 'not connected'
  if (!p?.custom)
    return 'this device does not allow custom commands (arh-agent policy --allow custom)'
  if (caps.value.link !== 'cable' && !p.lan) return 'only over the USB cable'
  return ''
})

onMounted(() => void acts.loadOffers(props.deviceId))
watch(
  () => [props.deviceId, device.value?.connected, JSON.stringify(caps.value)],
  () => void acts.loadOffers(props.deviceId)
)
</script>

<template>
  <section>
    <div class="mb-2 flex items-baseline justify-between gap-3">
      <h3 class="eyebrow">Actions on this computer</h3>
      <span class="text-[10px] text-mist-700"
        >{{
          caps?.link === 'cable' ? 'USB cable' : caps?.link === 'lan' ? 'network (read only)' : ''
        }}
        · device policy {{ policyText }}</span
      >
    </div>
    <p v-if="acts.astate.offersError[deviceId]" class="text-xs text-bad-400">
      {{ acts.astate.offersError[deviceId] }}
    </p>
    <p v-if="caps?.pendingRestartUntil" class="mb-2 text-xs text-warn-400">
      A restart is scheduled for {{ when(caps.pendingRestartUntil) }}: other changes wait until it
      happens or is cancelled.
    </p>
    <div v-for="[cat, list] in groups" :key="cat" class="mb-3">
      <p class="mb-1 text-[11px] text-mist-500">{{ cat }}</p>
      <ul class="space-y-1">
        <li
          v-for="o in list"
          :key="o.def.name"
          class="flex items-center gap-3 rounded-[3px] border border-white/5 bg-ink-900 px-3 py-1.5 text-sm"
        >
          <span class="flex-1 min-w-0">
            <span class="text-mist-100">{{ o.def.title }}</span>
            <span
              class="ml-2 rounded-[2px] border px-1 text-[10px]"
              :class="impactBadge(o.def.impact).cls"
              >{{ impactBadge(o.def.impact).text }}</span
            >
            <span
              v-if="o.blocked.length"
              class="block truncate text-[10px] text-mist-700"
              :title="o.blocked.join('\n')"
              >{{ o.blocked[0] }}</span
            >
          </span>
          <button
            class="btn-ghost shrink-0 px-3 py-0.5 text-xs"
            :disabled="!device?.connected"
            :title="
              o.blocked.length
                ? `Preview only: ${o.blocked.join('; ')}`
                : 'Preview (measures only), then confirm'
            "
            @click="acts.openAction(deviceId, o.def.name)"
          >
            {{ o.blocked.length ? 'Preview' : 'Preview…' }}
          </button>
        </li>
      </ul>
    </div>
    <div class="flex items-center gap-3">
      <button
        class="btn-ghost px-3 py-1 text-xs"
        :disabled="!!execBlocked"
        :title="execBlocked || 'Type a command to run on this computer'"
        @click="acts.openExec(deviceId)"
      >
        Custom command…
      </button>
      <span v-if="execBlocked" class="text-[10px] text-mist-700">{{ execBlocked }}</span>
    </div>

    <div v-if="history.length" class="mt-4">
      <p class="mb-1 text-[11px] text-mist-500">Changes and tasks on record</p>
      <ul class="space-y-0.5">
        <li
          v-for="r in history"
          :key="r.runId"
          class="flex cursor-pointer items-center gap-3 rounded-[3px] px-2 py-1 text-xs hover:bg-ink-800"
          @click="acts.viewRun(r.runId)"
        >
          <span class="w-28 shrink-0 text-mist-500">{{ when(r.appliedAt ?? r.requestedAt) }}</span>
          <span class="flex-1 truncate text-mist-100">{{ r.title }}</span>
          <span class="shrink-0" :class="actionBadge(r.status).cls"
            >{{ actionBadge(r.status).icon }} {{ actionBadge(r.status).text }}</span
          >
        </li>
      </ul>
    </div>
  </section>
</template>
