<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { MetricSeries } from '@shared/types'
import { when } from '../format'

/*
  One metric over the computer's scans: a single series, so no legend (the label names it).
  2px line, 10% wash, a hairline at the health threshold, an 8px end dot with a surface ring,
  crosshair + tooltip on hover and on arrow keys. Click (or Enter) opens that scan.
  Line colour #ad8b38: the theme gold stepped into the dark band (validated, contrast >= 3:1).
*/
const props = defineProps<{ series: MetricSeries }>()
const emit = defineEmits<{ select: [runId: string] }>()

const LINE = '#ad8b38'
const SURFACE = '#0c110e'
const H = 56
const PAD_X = 6
const PAD_Y = 8

const wrap = ref<HTMLElement | null>(null)
const width = ref(240)
let observer: ResizeObserver | null = null
onMounted(() => {
  if (!wrap.value) return
  width.value = Math.max(120, wrap.value.clientWidth || 240)
  observer = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width
    if (w) width.value = Math.max(120, Math.round(w))
  })
  observer.observe(wrap.value)
})
onBeforeUnmount(() => observer?.disconnect())

const pts = computed(() => props.series.points)
const domain = computed(() => {
  const vals = pts.value.map((p) => p.value)
  if (props.series.threshold != null) vals.push(props.series.threshold)
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  if (lo === hi) {
    lo -= 1
    hi += 1
  }
  const pad = (hi - lo) * 0.12
  return { lo: lo - pad, hi: hi + pad }
})
function x(i: number): number {
  const n = pts.value.length
  return n <= 1 ? width.value / 2 : PAD_X + (i * (width.value - 2 * PAD_X)) / (n - 1)
}
function y(v: number): number {
  const { lo, hi } = domain.value
  return PAD_Y + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD_Y)
}
const line = computed(() =>
  pts.value.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
)
const wash = computed(() =>
  pts.value.length > 1
    ? `${line.value} L${x(pts.value.length - 1).toFixed(1)},${H - PAD_Y} L${x(0).toFixed(1)},${H - PAD_Y} Z`
    : ''
)

const hover = ref<number | null>(null)
const activeIndex = computed(() => hover.value ?? pts.value.length - 1)
const active = computed(() => pts.value[activeIndex.value])
const hovered = computed(() => (hover.value == null ? undefined : pts.value[hover.value]))
const latest = computed(() => pts.value[pts.value.length - 1])
const previous = computed(() => pts.value[pts.value.length - 2])
const delta = computed(() =>
  latest.value && previous.value ? latest.value.value - previous.value.value : null
)
const deltaGood = computed(() =>
  delta.value == null || delta.value === 0
    ? null
    : delta.value > 0 === (props.series.better === 'higher')
)
const breach = computed(() => {
  const t = props.series.threshold
  const v = latest.value?.value
  if (t == null || v == null) return false
  // same comparisons as health.ts: low-is-bad values alert below the limit, the rest at or above
  return props.series.better === 'higher' ? v < t : v >= t
})
const threshold = computed(() => props.series.threshold)
const tooltipLeft = computed(() =>
  hover.value == null ? '0px' : `${Math.min(Math.max(x(hover.value) - 70, 0), width.value - 150)}px`
)

function fmt(v: number): string {
  const n = Number.isInteger(v) ? String(v) : v.toFixed(1)
  const u = props.series.unit
  return u === '%' ? `${n}%` : u ? `${n} ${u}` : n
}

function onMove(e: PointerEvent): void {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  const px = e.clientX - rect.left
  let best = 0
  let dist = Infinity
  pts.value.forEach((_, i) => {
    const d = Math.abs(x(i) - px)
    if (d < dist) {
      dist = d
      best = i
    }
  })
  hover.value = best
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft') hover.value = Math.max(0, activeIndex.value - 1)
  else if (e.key === 'ArrowRight')
    hover.value = Math.min(pts.value.length - 1, activeIndex.value + 1)
  else if (e.key === 'Enter') choose()
  else return
  e.preventDefault()
}

function choose(): void {
  const p = active.value
  if (p) emit('select', p.runId)
}
</script>

<template>
  <div class="card p-3">
    <div class="flex items-baseline justify-between gap-2">
      <p class="text-[11px] text-mist-500">{{ series.label }}</p>
      <p v-if="breach && threshold != null" class="text-[10px] font-semibold text-warn-400">
        ▲ past the {{ fmt(threshold) }} limit
      </p>
    </div>
    <div class="mt-1 flex items-baseline gap-2">
      <span class="text-2xl font-semibold text-mist-100">{{
        latest ? fmt(latest.value) : '–'
      }}</span>
      <span
        v-if="delta != null && delta !== 0"
        class="text-[11px]"
        :class="deltaGood ? 'text-ok-400' : 'text-bad-400'"
        >{{ delta > 0 ? '▲' : '▼' }} {{ fmt(Math.abs(delta)) }}
        <span class="text-mist-500">vs previous scan</span></span
      >
    </div>
    <div ref="wrap" class="relative mt-2">
      <svg
        :width="width"
        :height="H"
        class="block cursor-pointer rounded-[2px] outline-none focus-visible:ring-1 focus-visible:ring-gold-400/60"
        tabindex="0"
        role="img"
        :aria-label="`${series.label}: ${pts.length} scans, latest ${latest ? fmt(latest.value) : 'none'}`"
        @pointermove="onMove"
        @pointerleave="hover = null"
        @blur="hover = null"
        @click="choose"
        @keydown="onKey"
      >
        <line
          v-if="threshold != null"
          x1="0"
          :x2="width"
          :y1="y(threshold)"
          :y2="y(threshold)"
          stroke="#4e5e57"
          stroke-width="1"
        />
        <path v-if="wash" :d="wash" :fill="LINE" fill-opacity="0.1" />
        <path
          :d="line"
          fill="none"
          :stroke="LINE"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <line
          v-if="hover != null"
          :x1="x(hover)"
          :x2="x(hover)"
          y1="0"
          :y2="H"
          stroke="#8a9a92"
          stroke-width="1"
        />
        <circle
          v-if="active"
          :cx="x(activeIndex)"
          :cy="y(active.value)"
          r="4"
          :fill="LINE"
          :stroke="SURFACE"
          stroke-width="2"
        />
      </svg>
      <div
        v-if="hovered"
        class="pointer-events-none absolute -top-8 rounded-[3px] border border-white/10 bg-ink-950 px-2 py-1 text-[11px] whitespace-nowrap"
        :style="{ left: tooltipLeft }"
      >
        <span class="font-semibold text-mist-100">{{ fmt(hovered.value) }}</span>
        <span class="ml-1 text-mist-500">{{ when(hovered.at) }}</span>
      </div>
    </div>
    <p class="mt-1 text-[10px] text-mist-700">
      {{ pts.length }} scan{{ pts.length === 1 ? '' : 's'
      }}{{ threshold != null ? ` · line at ${fmt(threshold)}` : '' }} · click a point to open that
      scan
    </p>
  </div>
</template>
