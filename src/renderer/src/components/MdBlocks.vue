<script setup lang="ts">
import type { Block } from '@shared/markdown'
import { calloutStyle, taskMark } from '../md'
import MdInline from './MdInline.vue'

/*
  Block Markdown for the note viewer. Every block carries data-line (its line in the file) so the
  viewer can jump to and mark the line a click came from; lists and quotes leave it to their
  first item or block (same line), and tables carry it on each row (a short row's missing cells
  are one empty cell, so a row costs its own cells, not the header's). Headings carry
  data-heading for [[Note#Heading]] links. `tight` drops paragraph spacing inside list items.
*/
withDefaults(defineProps<{ blocks: Block[]; tight?: boolean }>(), { tight: false })

const HEADING: Record<number, string> = {
  1: 'display mt-2 mb-3 text-[28px] leading-tight text-mist-100',
  2: 'display mt-6 mb-2 text-[22px] leading-tight text-gold-300',
  3: 'mt-5 mb-1.5 text-[15px] font-semibold text-mist-100',
  4: 'mt-4 mb-1 text-[14px] font-semibold text-mist-300',
  5: 'mt-3 mb-1 text-[13px] font-semibold text-mist-300',
  6: 'mt-3 mb-1 text-[12px] font-semibold uppercase text-mist-500'
}
const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const
function align(a: 'left' | 'center' | 'right' | null | undefined): string {
  return a ? ALIGN[a] : 'text-left'
}
const done = (task: string | undefined): boolean => task === 'x' || task === 'X'
</script>

<template>
  <template v-for="(b, i) in blocks" :key="`${b.t}:${b.line}:${i}`">
    <component
      :is="`h${b.level}`"
      v-if="b.t === 'heading'"
      :data-line="b.line"
      :data-heading="b.text"
      :class="HEADING[b.level]"
      ><MdInline :c="b.c"
    /></component>
    <p
      v-else-if="b.t === 'para'"
      :data-line="b.line"
      :class="tight ? 'my-0.5' : 'my-2'"
      class="leading-relaxed"
    >
      <MdInline :c="b.c" />
    </p>
    <pre
      v-else-if="b.t === 'code'"
      :data-line="b.line"
      class="my-3 overflow-x-auto rounded-[3px] border border-white/5 bg-ink-950 p-3 font-mono text-[12px] leading-snug text-mist-300"
      :title="b.lang || undefined"
    ><code>{{ b.v }}</code></pre>
    <blockquote
      v-else-if="b.t === 'quote'"
      class="my-3 border-l-2 border-white/15 pl-3 text-mist-300"
    >
      <MdBlocks :blocks="b.c" />
    </blockquote>
    <details
      v-else-if="b.t === 'callout'"
      :data-line="b.line"
      :open="b.fold !== '-'"
      class="my-3 rounded-[3px] border-l-2 px-3 py-2"
      :class="calloutStyle(b.kind).cls"
    >
      <summary class="cursor-pointer font-semibold text-mist-100 select-none">
        <span class="mr-1">{{ calloutStyle(b.kind).icon }}</span
        ><MdInline :c="b.title" />
      </summary>
      <div class="mt-1 text-mist-300"><MdBlocks :blocks="b.c" /></div>
    </details>
    <component
      :is="b.ordered ? 'ol' : 'ul'"
      v-else-if="b.t === 'list'"
      :start="b.ordered && b.start !== 1 ? b.start : undefined"
      class="my-2 space-y-0.5 pl-5"
      :class="b.ordered ? 'list-decimal' : 'list-disc'"
    >
      <li
        v-for="(it, j) in b.items"
        :key="`${it.line}:${j}`"
        :data-line="it.line"
        :class="it.task !== undefined ? '-ml-5 flex list-none gap-2' : ''"
      >
        <span
          v-if="it.task !== undefined"
          class="shrink-0 text-[15px] leading-relaxed"
          :class="done(it.task) ? 'text-ok-400' : 'text-mist-500'"
          :title="done(it.task) ? 'done' : `status [${it.task}]`"
          >{{ taskMark(it.task) }}</span
        >
        <div
          class="min-w-0 flex-1"
          :class="{ 'text-mist-500 line-through decoration-mist-700': done(it.task) }"
        >
          <MdBlocks :blocks="it.c" tight />
        </div>
      </li>
    </component>
    <div v-else-if="b.t === 'table'" :data-line="b.line" class="my-3 overflow-x-auto">
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr class="border-b border-white/10">
            <th
              v-for="(h, j) in b.head"
              :key="j"
              class="px-2 py-1.5 font-semibold text-mist-300"
              :class="align(b.align[j])"
            >
              <MdInline :c="h" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, r) in b.rows"
            :key="r"
            :data-line="b.rowLines[r]"
            class="border-b border-white/5 align-top"
          >
            <td v-for="(cell, j) in row" :key="j" class="px-2 py-1.5" :class="align(b.align[j])">
              <MdInline :c="cell" />
            </td>
            <td
              v-if="row.length < b.head.length"
              :colspan="b.head.length - row.length"
              class="px-2 py-1.5"
            />
          </tr>
        </tbody>
      </table>
    </div>
    <hr v-else-if="b.t === 'hr'" :data-line="b.line" class="my-4 border-white/10" />
  </template>
</template>
