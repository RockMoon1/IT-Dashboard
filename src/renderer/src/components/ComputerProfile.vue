<script setup lang="ts">
import { computed } from 'vue'
import { purposeLabel, type TimelineEvent } from '@shared/types'
import { useDashboard } from '../store'
import { ago, duration, scoreBadge, severityBadge, when } from '../format'
import Sparkline from './Sparkline.vue'

const dash = useDashboard()
const { state } = dash
const p = computed(() => state.profile)
const s = computed(() => p.value?.summary)

const identity = computed(() => {
  const x = s.value
  if (!x) return []
  return [
    ['Serial', x.serial],
    ['Model', x.model],
    ['OS', x.os],
    ['Location', x.location],
    ['Room / role', x.room],
    ['IP', x.ip],
    ['MAC', x.mac],
    ['Last seen on the link', x.lastSeen ? `${when(x.lastSeen)} (${ago(x.lastSeen)})` : undefined],
    ['Last scan', x.lastScanAt ? `${when(x.lastScanAt)} (${ago(x.lastScanAt)})` : undefined]
  ].filter((r): r is [string, string] => !!r[1])
})

const openTickets = computed(() => p.value?.tickets.filter((t) => !t.closed).length ?? 0)
const openLoops = computed(() => p.value?.loops.filter((l) => !l.done).length ?? 0)
const recurring = computed(() => p.value?.recurring.filter((r) => r.seen > 1) ?? [])

/** Mentions grouped by note, in the order found. */
const mentionGroups = computed(() => {
  const groups = new Map<
    string,
    { file: string; title: string; lines: Array<{ line: number; text: string }> }
  >()
  for (const m of p.value?.mentions ?? []) {
    const g = groups.get(m.file) ?? { file: m.file, title: m.title, lines: [] }
    g.lines.push({ line: m.line, text: m.text })
    groups.set(m.file, g)
  }
  return [...groups.values()]
})

const KIND: Record<TimelineEvent['kind'], string> = {
  scan: 'Scan',
  ticket: 'Ticket',
  worklog: 'Work log',
  change: 'Change',
  enrolled: 'Enrolled'
}

function openEvent(e: TimelineEvent): void {
  if (e.runId) void dash.openRunById(e.runId)
  else if (e.file) void dash.openNote(e.file)
}

function scanNow(): void {
  const id = s.value?.deviceId
  if (id) dash.openPurposePrompt(id)
}

const stripMd = (t: string): string => t.replace(/\*\*|~~|\^loop-[0-9a-f-]+/g, '').trim()
const plain = (line: string): string => line.replace(/^#+\s*/, '')
</script>

<template>
  <div class="space-y-5 p-6">
    <div class="flex items-center justify-between">
      <button class="text-xs text-mist-500 hover:text-gold-300" @click="dash.closeProfile()">
        ← All computers
      </button>
      <span v-if="p" class="text-[10px] text-mist-700"
        >on record · {{ p.tookMs }} ms · {{ p.summary.scans }} scans ·
        {{ p.terms.length ? `vault searched for ${p.terms.join(', ')}` : 'term too short' }}</span
      >
    </div>

    <p v-if="state.profileLoading && !p" class="text-sm text-mist-500">Loading…</p>
    <p v-if="p?.vaultError" class="text-sm text-warn-400">{{ p.vaultError }}</p>

    <template v-if="p && s">
      <!-- who -->
      <section class="card card-gold p-5">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <p class="eyebrow">
              {{
                s.sources.length
                  ? `From ${s.sources.join(', ')}`
                  : 'Not a known computer: vault notes only'
              }}
            </p>
            <h2 class="display mt-1 truncate text-[30px] leading-tight text-mist-100">
              {{ s.name }}
            </h2>
            <p v-if="s.aliases.length" class="text-xs text-mist-500">
              also {{ s.aliases.join(', ') }}
            </p>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-2">
            <span class="text-sm font-semibold" :class="scoreBadge(s.health).cls"
              >{{ scoreBadge(s.health).icon }} {{ scoreBadge(s.health).text }}</span
            >
            <span
              v-if="s.deviceId"
              class="text-[11px]"
              :class="s.connected ? 'text-ok-400' : 'text-mist-500'"
            >
              {{ s.connected ? '● connected now' : '○ not connected (showing what is on record)' }}
            </span>
            <div class="flex gap-2">
              <button class="btn-ghost px-3 py-1" @click="dash.refreshProfile()">Refresh</button>
              <button
                v-if="s.deviceId"
                class="btn-gold px-3 py-1"
                :disabled="!s.connected"
                :title="s.connected ? 'Choose a purpose and scan' : 'Connect the cable to scan'"
                @click="scanNow"
              >
                Scan now
              </button>
            </div>
          </div>
        </div>
        <dl v-if="identity.length" class="mt-4 grid grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <div v-for="[k, v] in identity" :key="k" class="min-w-0">
            <dt class="text-[11px] text-mist-500">{{ k }}</dt>
            <dd class="truncate text-mist-100" :title="v">{{ v }}</dd>
          </div>
        </dl>
      </section>

      <!-- headline numbers -->
      <div class="grid grid-cols-5 gap-3">
        <div class="card p-3">
          <p class="text-[11px] text-mist-500">Current findings</p>
          <p class="text-2xl font-semibold">{{ p.findings.length }}</p>
          <p class="text-[10px] text-mist-700">
            {{ p.findings.filter((f) => f.severity === 'critical').length }} critical
          </p>
        </div>
        <div class="card p-3">
          <p class="text-[11px] text-mist-500">Recurring problems</p>
          <p class="text-2xl font-semibold">{{ recurring.length }}</p>
          <p class="text-[10px] text-mist-700">seen on more than one scan</p>
        </div>
        <div class="card p-3">
          <p class="text-[11px] text-mist-500">Open tickets</p>
          <p class="text-2xl font-semibold">{{ openTickets }}</p>
          <p class="text-[10px] text-mist-700">{{ p.tickets.length }} in total</p>
        </div>
        <div class="card p-3">
          <p class="text-[11px] text-mist-500">Open loops</p>
          <p class="text-2xl font-semibold">{{ openLoops }}</p>
          <p class="text-[10px] text-mist-700">{{ p.loops.length }} in total</p>
        </div>
        <div class="card p-3">
          <p class="text-[11px] text-mist-500">Scans on record</p>
          <p class="text-2xl font-semibold">{{ p.scans.length }}</p>
          <p class="text-[10px] text-mist-700">{{ p.timeline.length }} events</p>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div class="space-y-5 xl:col-span-2">
          <!-- now -->
          <section>
            <h3 class="eyebrow mb-2">Needs attention (latest scan of each purpose)</h3>
            <p v-if="!p.findings.length" class="text-sm text-mist-500">
              {{
                p.scans.length
                  ? 'Nothing crossed a threshold on the latest scans.'
                  : 'No scans on record.'
              }}
            </p>
            <ul class="space-y-1">
              <li
                v-for="f in p.findings"
                :key="`${f.runId}:${f.id}`"
                class="flex cursor-pointer items-start gap-3 rounded-[3px] border border-white/5 bg-ink-900 px-3 py-2 text-sm hover:bg-ink-800"
                @click="dash.openRunById(f.runId)"
              >
                <span class="w-20 shrink-0 text-xs" :class="severityBadge(f.severity).cls"
                  >{{ severityBadge(f.severity).icon }} {{ severityBadge(f.severity).text }}</span
                >
                <span class="flex-1">{{ f.message }}</span>
                <span class="shrink-0 text-[10px] text-mist-700"
                  >{{ f.category }} · {{ purposeLabel(f.purpose) }} · {{ when(f.at) }}</span
                >
              </li>
            </ul>
          </section>

          <!-- trends -->
          <section v-if="p.series.length">
            <h3 class="eyebrow mb-2">Trends across scans</h3>
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              <Sparkline
                v-for="series in p.series"
                :key="series.key"
                :series="series"
                @select="dash.openRunById($event)"
              />
            </div>
          </section>

          <!-- recurring -->
          <section v-if="p.recurring.length">
            <h3 class="eyebrow mb-2">Problems by how often they come back</h3>
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-[11px] text-mist-500">
                  <th class="py-1 pr-3 font-medium">Finding (latest wording)</th>
                  <th class="py-1 pr-3 font-medium">Seen</th>
                  <th class="py-1 pr-3 font-medium">First</th>
                  <th class="py-1 pr-3 font-medium">Last</th>
                  <th class="py-1 pr-3 font-medium">Now</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in p.recurring" :key="r.shape" class="border-t border-white/5">
                  <td class="py-1.5 pr-3">
                    <span class="mr-1 text-xs" :class="severityBadge(r.severity).cls">{{
                      severityBadge(r.severity).icon
                    }}</span
                    >{{ r.message }}
                  </td>
                  <td class="py-1.5 pr-3 text-xs whitespace-nowrap">
                    {{ r.seen }} of {{ r.of }} scans
                  </td>
                  <td class="py-1.5 pr-3 text-xs text-mist-500">
                    {{ when(r.firstAt).slice(0, 10) }}
                  </td>
                  <td class="py-1.5 pr-3 text-xs text-mist-500">
                    {{ when(r.lastAt).slice(0, 10) }}
                  </td>
                  <td
                    class="py-1.5 pr-3 text-xs"
                    :class="r.current ? 'text-warn-400' : 'text-ok-400'"
                  >
                    {{ r.current ? '▲ still there' : '✓ gone' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- timeline -->
          <section v-if="p.timeline.length">
            <h3 class="eyebrow mb-2">History: scans, tickets, work log and changes</h3>
            <ol class="space-y-1 border-l border-white/10 pl-4">
              <li
                v-for="(e, i) in p.timeline.slice(0, 60)"
                :key="`${e.kind}:${e.at}:${i}`"
                class="relative cursor-pointer text-sm hover:text-gold-300"
                :class="{ 'cursor-default hover:text-inherit': !e.runId && !e.file }"
                @click="openEvent(e)"
              >
                <span class="absolute top-2 -left-[21px] h-2 w-2 rounded-full bg-ink-600"></span>
                <span class="mr-2 inline-block w-28 text-[11px] text-mist-500">{{
                  when(e.at)
                }}</span>
                <span class="mr-2 inline-block w-16 text-[10px] text-mist-700 uppercase">{{
                  KIND[e.kind]
                }}</span>
                <span>{{ stripMd(e.title) }}</span>
                <span v-if="e.score" class="ml-2 text-[11px]" :class="scoreBadge(e.score).cls">{{
                  scoreBadge(e.score).text
                }}</span>
                <span v-if="e.detail" class="ml-2 text-[11px] text-mist-500">{{ e.detail }}</span>
              </li>
            </ol>
          </section>

          <!-- scans -->
          <section v-if="p.scans.length">
            <h3 class="eyebrow mb-2">Scans</h3>
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-mist-500">
                  <th class="py-1 pr-3 font-medium">When</th>
                  <th class="py-1 pr-3 font-medium">Purpose</th>
                  <th class="py-1 pr-3 font-medium">Profile</th>
                  <th class="py-1 pr-3 font-medium">Status</th>
                  <th class="py-1 pr-3 font-medium">Health</th>
                  <th class="py-1 pr-3 font-medium">Findings</th>
                  <th class="py-1 pr-3 font-medium">Duration</th>
                  <th class="py-1 pr-3 font-medium">Technician</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in p.scans"
                  :key="r.runId"
                  class="cursor-pointer border-t border-white/5 hover:bg-ink-800"
                  @click="dash.openRunById(r.runId)"
                >
                  <td class="py-1 pr-3">{{ when(r.at) }}</td>
                  <td class="py-1 pr-3">{{ purposeLabel(r.purpose) }}</td>
                  <td class="py-1 pr-3 text-mist-500">{{ r.profile }} v{{ r.version }}</td>
                  <td class="py-1 pr-3">{{ r.status }}</td>
                  <td class="py-1 pr-3" :class="scoreBadge(r.score).cls">
                    {{ scoreBadge(r.score).text }}
                  </td>
                  <td class="py-1 pr-3">
                    {{ r.findings
                    }}<span v-if="r.critical" class="text-mist-500">
                      ({{ r.critical }} critical)</span
                    >
                  </td>
                  <td class="py-1 pr-3">{{ duration(r.durationMs) }}</td>
                  <td class="py-1 pr-3">{{ r.technician }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <div class="space-y-5">
          <!-- inventory -->
          <section v-if="p.inventory.length">
            <h3 class="eyebrow mb-2">Asset Inventory</h3>
            <div
              v-for="row in p.inventory"
              :key="`${row.file}:${row.line}`"
              class="card mb-2 cursor-pointer p-3 text-xs hover:bg-ink-800"
              @click="dash.openNote(row.file)"
            >
              <dl class="grid grid-cols-2 gap-x-3 gap-y-1">
                <template v-for="(v, k) in row.cells" :key="k">
                  <template v-if="v">
                    <dt class="text-mist-500">{{ k }}</dt>
                    <dd class="truncate text-mist-100" :title="v">{{ v }}</dd>
                  </template>
                </template>
              </dl>
              <p class="mt-2 text-[10px] text-mist-700">{{ row.file }} · line {{ row.line }}</p>
            </div>
          </section>

          <!-- tickets -->
          <section>
            <h3 class="eyebrow mb-2">Tickets</h3>
            <p v-if="!p.tickets.length" class="text-xs text-mist-500">No ticket mentions it.</p>
            <ul class="space-y-1">
              <li
                v-for="t in p.tickets"
                :key="t.file"
                class="cursor-pointer rounded-[3px] border border-white/5 bg-ink-900 px-3 py-2 hover:bg-ink-800"
                :class="{ 'opacity-60': t.closed }"
                @click="dash.openNote(t.file)"
              >
                <p class="text-sm text-mist-100">{{ t.title }}</p>
                <p class="mt-0.5 text-[11px] text-mist-500">
                  {{
                    [
                      t.date,
                      t.closed ? '✓ closed' : `○ ${t.status ?? 'open'}`,
                      t.priority,
                      t.category
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  }}
                </p>
                <p v-if="t.openTasks || t.doneTasks" class="text-[10px] text-mist-700">
                  {{ t.openTasks }} open task{{ t.openTasks === 1 ? '' : 's' }},
                  {{ t.doneTasks }} done
                </p>
              </li>
            </ul>
          </section>

          <!-- loops -->
          <section>
            <h3 class="eyebrow mb-2">Open Loops</h3>
            <p v-if="!p.loops.length" class="text-xs text-mist-500">Nothing in ARH Open Loops.</p>
            <ul class="space-y-1">
              <li
                v-for="l in p.loops"
                :key="`${l.file}:${l.line}`"
                class="flex cursor-pointer gap-2 rounded-[3px] px-2 py-1.5 text-sm hover:bg-ink-800"
                :class="{ 'opacity-50 line-through': l.done }"
                @click="dash.openNote(l.file)"
              >
                <span class="w-5 shrink-0 text-center">{{
                  l.priority ?? (l.done ? '✓' : '·')
                }}</span>
                <span class="flex-1">
                  {{ stripMd(l.text) }}
                  <span class="block text-[10px] text-mist-700 no-underline"
                    >{{ l.section }}{{ l.generated ? ' · from a scan' : '' }}</span
                  >
                </span>
              </li>
            </ul>
          </section>

          <!-- work log -->
          <section v-if="p.worklog.length">
            <h3 class="eyebrow mb-2">Work Log</h3>
            <div
              v-for="(w, i) in p.worklog"
              :key="`${w.date}:${i}`"
              class="card mb-2 cursor-pointer p-3 hover:bg-ink-800"
              @click="dash.openNote(w.file)"
            >
              <p class="text-[11px] text-gold-300">{{ w.heading }}</p>
              <p v-for="(l, j) in w.lines" :key="j" class="text-xs text-mist-300">
                {{ plain(l) }}
              </p>
            </div>
          </section>

          <!-- changes -->
          <section v-if="p.changes.length">
            <h3 class="eyebrow mb-2">Change Log</h3>
            <div
              v-for="c in p.changes"
              :key="`${c.file}:${c.line}`"
              class="card mb-2 cursor-pointer p-3 text-xs hover:bg-ink-800"
              @click="dash.openNote(c.file)"
            >
              <p class="text-mist-100">
                {{ c.cells['What changed'] ?? Object.values(c.cells).join(' · ') }}
              </p>
              <p class="text-mist-500">
                {{
                  [Object.values(c.cells)[0], c.cells['Why'], c.cells['By']]
                    .filter(Boolean)
                    .join(' · ')
                }}
              </p>
            </div>
          </section>

          <!-- other notes -->
          <section v-if="mentionGroups.length">
            <h3 class="eyebrow mb-2">Other notes</h3>
            <div
              v-for="g in mentionGroups"
              :key="g.file"
              class="card mb-2 cursor-pointer p-3 hover:bg-ink-800"
              @click="dash.openNote(g.file)"
            >
              <p class="text-[11px] text-gold-300">{{ g.title }}</p>
              <p
                v-for="l in g.lines.slice(0, 4)"
                :key="l.line"
                class="truncate text-xs text-mist-300"
                :title="l.text"
              >
                {{ l.text }}
              </p>
              <p v-if="g.lines.length > 4" class="text-[10px] text-mist-700">
                +{{ g.lines.length - 4 }} more lines
              </p>
            </div>
          </section>

          <!-- last known state -->
          <section v-if="p.facts.length">
            <h3 class="eyebrow mb-2">Last known state</h3>
            <table class="w-full text-xs">
              <tbody>
                <tr v-for="f in p.facts" :key="f.label" class="border-t border-white/5 align-top">
                  <td class="py-1 pr-2 text-mist-500">{{ f.label }}</td>
                  <td class="py-1 pr-2 text-mist-100">{{ f.value }}</td>
                  <td class="py-1 text-[10px] whitespace-nowrap text-mist-700">
                    {{ when(f.at).slice(0, 10) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
