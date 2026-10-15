<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { purposeLabel } from '@shared/types'
import { useDashboard } from '../store'
import { statusMark } from '../results'

const dash = useDashboard()
const { state } = dash
const run = computed(() => dash.currentRun.value)
const box = ref<HTMLElement | null>(null)
const follow = ref(true)
const filterCheck = ref<string | null>(null)

const done = computed(
  () =>
    run.value?.checks.filter(
      (c) => c.status === 'ok' || c.status === 'failed' || c.status === 'timeout'
    ).length ?? 0
)
const total = computed(() => run.value?.checks.length ?? 0)
const progress = computed(() => (total.value ? Math.round((done.value / total.value) * 100) : 0))
const visibleLines = computed(() =>
  filterCheck.value
    ? state.console.filter(
        (l) => l.checkId === filterCheck.value || (!l.checkId && l.stream === 'status')
      )
    : state.console
)

watch(
  () => state.console.length,
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
  if (stream === 'status') return 'text-gold-300'
  if (stream === 'stderr') return 'text-bad-400'
  return 'text-mist-100'
}

function time(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false })
}

function statusBadge(status: string): string {
  return status === 'ok'
    ? 'border-ok-400/50 text-ok-400'
    : status === 'running'
      ? 'border-gold-400/50 text-gold-300'
      : status === 'aborted'
        ? 'border-warn-400/50 text-warn-400'
        : 'border-bad-400/50 text-bad-400'
}
</script>

<template>
  <div v-if="!run" class="flex h-full items-center justify-center p-10 text-center text-mist-500">
    <div class="max-w-md">
      <p class="display text-2xl text-mist-300">No scan yet</p>
      <p class="mt-2 text-sm">
        Plug a device in, enroll it once, then double-click it in the list and choose the purpose of
        the visit. Every profile is read-only; results stream here as each check finishes.
      </p>
    </div>
  </div>
  <div v-else class="flex h-full min-h-0 flex-col">
    <div class="border-b border-white/5 px-6 py-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="eyebrow">
            {{ purposeLabel(run.purpose) }} · {{ run.profile }} v{{ run.version }}
          </p>
          <h2 class="display mt-1 text-2xl">
            {{ run.hostname }}
            <span class="text-base text-mist-500">{{
              run.serial ? `· SN ${run.serial}` : ''
            }}</span>
          </h2>
          <p class="mt-1 text-xs text-mist-500">
            Started {{ run.startedAt.replace('T', ' ').slice(0, 19) }} by {{ run.technician }} ·
            {{ done }}/{{ total }} checks{{
              run.finishedAt ? ` · ${(run.durationMs / 1000).toFixed(0)} s` : ''
            }}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span class="badge border" :class="statusBadge(run.status)">{{ run.status }}</span>
          <button v-if="run.status === 'running'" class="btn-danger" @click="dash.abortCurrent()">
            Abort
          </button>
          <button v-else class="btn-ghost" @click="state.tab = 'health'">Health</button>
          <button v-if="run.status !== 'running'" class="btn-gold" @click="dash.openPreview()">
            Preview vault write
          </button>
        </div>
      </div>
      <div class="mt-3 h-1 w-full rounded bg-ink-700">
        <div
          class="h-1 rounded bg-gold-400 transition-all"
          :style="{ width: `${progress}%` }"
        ></div>
      </div>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-[300px_1fr]">
      <ul class="min-h-0 overflow-y-auto border-r border-white/5 p-3 text-sm">
        <li class="mb-1">
          <button
            class="w-full rounded px-2 py-1 text-left text-xs text-mist-500 hover:bg-ink-800"
            :class="{ 'bg-ink-800 text-mist-100': filterCheck === null }"
            @click="filterCheck = null"
          >
            All output
          </button>
        </li>
        <li v-for="c in run.checks" :key="c.id">
          <button
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-800"
            :class="{ 'bg-ink-800': filterCheck === c.id }"
            @click="filterCheck = c.id"
          >
            <span class="w-4 text-center" :class="statusMark(c.status).cls">{{
              statusMark(c.status).text
            }}</span>
            <span class="min-w-0 flex-1 truncate">{{ c.title }}</span>
            <span class="text-[10px] text-mist-700">{{
              c.durationMs ? `${(c.durationMs / 1000).toFixed(1)}s` : ''
            }}</span>
          </button>
          <p class="pl-8 text-[10px] text-mist-700">
            {{ c.category }}{{ c.optional ? ' · optional' : '' }}
          </p>
        </li>
      </ul>
      <div class="flex min-h-0 flex-col">
        <div
          class="flex items-center justify-between border-b border-white/5 px-4 py-1.5 text-[11px] text-mist-500"
        >
          <span>Live output{{ filterCheck ? ` · ${filterCheck}` : '' }}</span>
          <label class="flex items-center gap-1"
            ><input v-model="follow" type="checkbox" /> follow</label
          >
        </div>
        <div
          ref="box"
          class="min-h-0 flex-1 overflow-y-auto bg-ink-950 p-3 font-mono text-[12px] leading-5"
          @scroll="onScroll"
        >
          <div v-for="l in visibleLines" :key="l.id" class="flex gap-3">
            <span class="w-16 shrink-0 select-none text-mist-700">{{ time(l.at) }}</span>
            <pre
              class="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words font-mono"
              :class="lineClass(l.stream)"
              >{{ l.text }}</pre
            >
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
