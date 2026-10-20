<script setup lang="ts">
import { inject } from 'vue'
import type { Inline } from '@shared/markdown'
import { MD_KEY } from '../md'

/*
  Inline Markdown drawn as text nodes and elements only, never v-html, so note content cannot
  become markup. Web links open in the browser and mailto: links in the mail app (the main
  process allows only those); [[links]] open inside the dashboard.
*/
defineProps<{ c: Inline[] }>()
const md = inject(MD_KEY, null)

type Wiki = Extract<Inline, { t: 'wiki' }>

function linkTitle(href: string): string {
  return /^mailto:/i.test(href)
    ? `Opens your mail app: ${href.slice(7).replace(/[?#].*$/, '')}`
    : `Opens in your browser: ${href}`
}

function label(x: Wiki): string {
  if (x.alias) return x.alias
  if (x.heading) return x.target ? `${x.target} › ${x.heading}` : x.heading
  return x.target
}
function resolved(x: Wiki): boolean {
  return !x.target || !!md?.links[x.target]
}
</script>

<template>
  <template v-for="(x, i) in c" :key="i">
    <template v-if="x.t === 'text'">{{ x.v }}</template>
    <br v-else-if="x.t === 'br'" />
    <code
      v-else-if="x.t === 'code'"
      class="rounded-[2px] bg-ink-700 px-1 py-0.5 font-mono text-[0.85em] text-gold-300"
      >{{ x.v }}</code
    >
    <strong v-else-if="x.t === 'strong'" class="font-semibold text-mist-100"
      ><MdInline :c="x.c"
    /></strong>
    <em v-else-if="x.t === 'em'"><MdInline :c="x.c" /></em>
    <del v-else-if="x.t === 'del'" class="text-mist-500"><MdInline :c="x.c" /></del>
    <mark v-else-if="x.t === 'mark'" class="rounded-[2px] bg-gold-400/25 px-0.5 text-mist-100"
      ><MdInline :c="x.c"
    /></mark>
    <a
      v-else-if="x.t === 'link'"
      :href="x.href"
      target="_blank"
      rel="noopener noreferrer"
      class="text-info-400 underline decoration-info-400/40 underline-offset-2 hover:decoration-info-400"
      :title="linkTitle(x.href)"
      ><MdInline :c="x.c" /><span class="ml-0.5 text-[0.75em]">↗</span></a
    >
    <span
      v-else-if="x.t === 'tag'"
      class="rounded-[2px] bg-emerald-700/40 px-1 text-[0.85em] text-emerald-500"
      >#{{ x.v }}</span
    >
    <button
      v-else-if="x.t === 'wiki'"
      type="button"
      class="inline text-left underline underline-offset-2"
      :class="
        resolved(x)
          ? 'text-gold-300 decoration-gold-400/40 hover:decoration-gold-300'
          : 'cursor-help text-mist-500 decoration-dotted'
      "
      :title="
        resolved(x)
          ? `Open ${x.target || 'heading'} here`
          : `${x.target} is not a note in the vault`
      "
      @click="md?.openWiki(x.target, x.heading)"
    >
      <span v-if="x.embed" class="mr-0.5">⎘</span>{{ label(x) }}
    </button>
  </template>
</template>
