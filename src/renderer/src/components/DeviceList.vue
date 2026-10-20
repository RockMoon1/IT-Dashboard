<script setup lang="ts">
import { computed, ref } from 'vue'
import { purposeLabel, type DeviceView } from '@shared/types'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash

const enrolled = computed(() =>
  [...state.devices.filter((d) => d.kind === 'enrolled')].sort(
    (a, b) =>
      Number(b.connected) - Number(a.connected) || a.displayName.localeCompare(b.displayName)
  )
)
const onLink = computed(() => state.devices.filter((d) => d.kind === 'link-unknown'))
const usb = computed(() => state.devices.filter((d) => d.kind === 'usb'))
const renaming = ref<string | null>(null)
const renameText = ref('')

function dot(d: DeviceView): string {
  if (d.kind === 'enrolled')
    return d.connected ? 'bg-ok-400 shadow-[0_0_8px_rgba(95,191,138,0.8)]' : 'bg-mist-700'
  if (d.kind === 'link-unknown') return 'bg-warn-400'
  if (!d.present) return 'bg-mist-700'
  return d.status && d.status !== 'OK' ? 'bg-warn-400' : 'bg-mist-500'
}

function scoreClass(score?: string): string {
  return score === 'critical'
    ? 'text-bad-400'
    : score === 'attention'
      ? 'text-warn-400'
      : score === 'healthy'
        ? 'text-ok-400'
        : 'text-mist-500'
}

function sub(d: DeviceView): string {
  if (d.kind === 'usb')
    return [
      d.deviceClass,
      d.serial ? `SN ${d.serial}` : d.vendorId ? `VID ${d.vendorId} PID ${d.productId}` : '',
      d.status && d.status !== 'OK' ? d.status : ''
    ]
      .filter(Boolean)
      .join(' · ')
  if (d.kind === 'link-unknown') return d.linkReason ?? 'cable link'
  return [
    d.hostname,
    d.serial ? `SN ${d.serial}` : '',
    d.connected ? d.address : d.lastSeen ? `seen ${d.lastSeen.slice(0, 16).replace('T', ' ')}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
}

function startRename(d: DeviceView): void {
  renaming.value = d.id
  renameText.value = d.displayName
}

async function commitRename(): Promise<void> {
  if (renaming.value) await dash.renameDevice(renaming.value, renameText.value)
  renaming.value = null
}
</script>

<template>
  <aside class="flex min-h-0 flex-col border-r border-white/5 bg-ink-900/60">
    <div class="min-h-0 flex-1 overflow-y-auto p-4">
      <section class="mb-5">
        <div class="mb-2 flex items-center justify-between">
          <h2 class="eyebrow">
            Enrolled devices <span class="text-mist-700">({{ enrolled.length }})</span>
          </h2>
          <span class="text-[10px] text-mist-700">click: on record · double-click: scan</span>
        </div>
        <p v-if="enrolled.length === 0" class="px-2 text-xs text-mist-500">
          No devices enrolled. Plug in the cable, then use <em>Enroll device</em>.
        </p>
        <ul class="space-y-1">
          <li v-for="d in enrolled" :key="d.id" class="group">
            <div
              class="cursor-pointer rounded-[3px] border px-3 py-2 transition hover:bg-ink-800"
              :class="
                d.id === state.selectedId ? 'border-gold-400/50 bg-ink-800' : 'border-transparent'
              "
              :title="d.hint"
              @click="dash.selectDevice(d.id)"
              @dblclick="dash.openPurposePrompt(d.id)"
            >
              <div class="flex items-center gap-2">
                <span class="h-2 w-2 shrink-0 rounded-full" :class="dot(d)"></span>
                <template v-if="renaming === d.id">
                  <input
                    v-model="renameText"
                    class="field py-1 text-sm"
                    @keyup.enter="commitRename"
                    @keyup.escape="renaming = null"
                    @blur="commitRename"
                  />
                </template>
                <span v-else class="display min-w-0 flex-1 truncate text-[17px]">{{
                  d.displayName
                }}</span>
                <span class="badge bg-ink-700 text-mist-300">{{ d.os }}</span>
                <button
                  class="invisible text-xs text-mist-500 hover:text-gold-300 group-hover:visible"
                  title="Rename"
                  @click.stop="startRename(d)"
                >
                  ✎
                </button>
                <button
                  class="invisible text-xs text-mist-500 hover:text-bad-400 group-hover:visible"
                  title="Forget this device"
                  @click.stop="dash.removeDevice(d.id)"
                >
                  ✕
                </button>
              </div>
              <p class="mt-1 truncate text-xs text-mist-500">{{ sub(d) }}</p>
              <p v-if="d.lastScan" class="mt-1 truncate text-[11px] text-mist-500">
                Last: {{ purposeLabel(d.lastScan.purpose) }} · {{ d.lastScan.at.slice(0, 10) }} ·
                <span :class="scoreClass(d.lastScan.score)">{{
                  d.lastScan.score ?? d.lastScan.status
                }}</span>
              </p>
              <p v-else class="mt-1 text-[11px] text-mist-700">No scan yet</p>
            </div>
          </li>
        </ul>
      </section>

      <section class="mb-5">
        <h2 class="eyebrow mb-2">
          On the link <span class="text-mist-700">({{ onLink.length }})</span>
        </h2>
        <p v-if="onLink.length === 0" class="px-2 text-xs text-mist-500">
          Nothing unidentified on a cable link.
        </p>
        <ul class="space-y-1">
          <li
            v-for="d in onLink"
            :key="d.id"
            class="rounded-[3px] border border-warn-400/30 px-3 py-2"
            :title="d.hint"
            @click="dash.selectDevice(d.id)"
          >
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full" :class="dot(d)"></span>
              <span class="text-sm">{{ d.displayName }}</span>
            </div>
            <p class="mt-1 text-xs text-mist-500">{{ sub(d) }}</p>
            <button class="btn-ghost mt-2 px-2 py-1 text-[10px]" @click.stop="dash.openEnroll()">
              Enroll this device
            </button>
          </li>
        </ul>
      </section>

      <section>
        <h2 class="eyebrow mb-2">
          USB peripherals
          <span class="text-mist-700">({{ usb.filter((u) => u.present).length }})</span>
        </h2>
        <p v-if="usb.length === 0" class="px-2 text-xs text-mist-500">No USB devices detected.</p>
        <ul class="space-y-1">
          <li
            v-for="d in usb"
            :key="d.id"
            class="rounded-[3px] px-3 py-1.5"
            :class="{ 'opacity-50': !d.present }"
            :title="d.hint"
          >
            <div class="flex items-center gap-2">
              <span class="h-2 w-2 rounded-full" :class="dot(d)"></span>
              <span class="min-w-0 flex-1 truncate text-sm">{{ d.displayName }}</span>
            </div>
            <p class="truncate text-xs text-mist-500">{{ sub(d) }}</p>
          </li>
        </ul>
      </section>
    </div>
  </aside>
</template>
