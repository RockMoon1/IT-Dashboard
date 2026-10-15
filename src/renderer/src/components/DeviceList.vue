<script setup lang="ts">
import { computed } from 'vue'
import type { Device, DeviceKind } from '@shared/types'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash

interface Group {
  kind: DeviceKind
  title: string
  empty: string
  devices: Device[]
}

const groups = computed<Group[]>(() => {
  const spec: Array<Omit<Group, 'devices'>> = [
    { kind: 'local', title: 'This PC', empty: '' },
    { kind: 'manual', title: 'Added by hand', empty: '' },
    {
      kind: 'network',
      title: 'Network neighbours',
      empty: 'No hosts discovered yet (ARP table is empty or discovery is off)'
    },
    { kind: 'usb', title: 'USB devices', empty: 'No USB devices detected' }
  ]
  return spec
    .map((g) => ({ ...g, devices: state.devices.filter((d) => d.kind === g.kind) }))
    .filter((g) => g.devices.length > 0 || g.empty)
})

function subtitle(d: Device): string {
  if (d.kind === 'usb') {
    const idPart = d.serial
      ? `SN ${d.serial}`
      : d.vendorId
        ? `VID ${d.vendorId} PID ${d.productId}`
        : ''
    return [d.deviceClass, idPart, d.status && d.status !== 'OK' ? d.status : '']
      .filter(Boolean)
      .join(' · ')
  }
  return [d.host, d.mac].filter(Boolean).join(' · ')
}

function dot(d: Device): string {
  if (!d.present) return 'bg-mist-500'
  if (d.kind === 'usb' && d.status && d.status !== 'OK') return 'bg-warn-400'
  return 'bg-ok-400'
}
</script>

<template>
  <aside class="flex min-h-0 flex-col border-r border-ink-700 bg-ink-900">
    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <section v-for="g in groups" :key="g.kind" class="mb-4">
        <h2 class="label">
          {{ g.title }} <span class="font-normal text-mist-500">({{ g.devices.length }})</span>
        </h2>
        <p v-if="g.devices.length === 0" class="px-2 text-xs text-mist-500">{{ g.empty }}</p>
        <ul>
          <li v-for="d in g.devices" :key="d.id" class="group flex items-stretch">
            <button
              class="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-ink-800"
              :class="{ 'bg-ink-700': d.id === state.selectedId, 'opacity-50': !d.present }"
              :title="d.osHint"
              @click="dash.selectDevice(d.id)"
              @dblclick="dash.openPurposePrompt(d.id)"
            >
              <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :class="dot(d)"></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ d.name }}</span>
                <span class="block truncate text-xs text-mist-500">{{ subtitle(d) }}</span>
              </span>
              <span class="badge bg-ink-800 text-mist-300">{{
                d.os === 'unknown' ? 'os ?' : d.os
              }}</span>
            </button>
            <button
              v-if="d.kind === 'manual'"
              class="invisible px-2 text-xs text-mist-500 hover:text-bad-400 group-hover:visible"
              title="Remove"
              @click="dash.removeDevice(d.id)"
            >
              ✕
            </button>
          </li>
        </ul>
      </section>
    </div>

    <form class="border-t border-ink-700 p-3" @submit.prevent="dash.addManualDevice()">
      <label class="label" for="manual-host">Add host by name or IP</label>
      <div class="flex gap-2">
        <input
          id="manual-host"
          v-model="state.manualHost"
          class="field"
          placeholder="192.168.1.20 or LAPTOP-01"
        />
        <button
          class="btn-primary"
          type="submit"
          :disabled="state.addingManual || !state.manualHost.trim()"
        >
          {{ state.addingManual ? 'Probing…' : 'Add' }}
        </button>
      </div>
      <input v-model="state.manualLabel" class="field mt-2" placeholder="Label (optional)" />
    </form>
  </aside>
</template>
