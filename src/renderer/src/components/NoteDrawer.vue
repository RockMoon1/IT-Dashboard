<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useDashboard } from '../store'
import { MD_KEY } from '../md'
import { when } from '../format'
import MdBlocks from './MdBlocks.vue'

/*
  The dashboard's own note reader. Every note click in the app lands here; [[links]] move
  between notes inside it (with back and forward), and the line the click came from is marked.
  Obsidian opens only from the "Open in Obsidian" button. Read only: nothing here writes.
*/
const dash = useDashboard()
const { state } = dash
const body = ref<HTMLElement | null>(null)
const notice = ref('')
const note = computed(() => state.note)
const target = computed(() => dash.noteTarget.value)
const canBack = computed(() => state.noteIndex > 0)
const canForward = computed(() => state.noteIndex < state.noteHistory.length - 1)

provide(MD_KEY, {
  get links() {
    return state.note?.links ?? {}
  },
  openWiki(t: string, heading?: string): void {
    notice.value = ''
    if (!t) {
      jump(undefined, heading)
      return
    }
    const hit = state.note?.links[t]
    if (!hit) {
      notice.value = `“${t}” is not a note in the vault.`
      return
    }
    void dash.viewNote(hit.file, undefined, heading)
  }
})

/** Marks and scrolls to the block for a line (the last block starting at or before it) or a heading. */
function jump(line?: number, heading?: string): void {
  const root = body.value
  if (!root) return
  root.querySelectorAll('.md-hit').forEach((e) => e.classList.remove('md-hit'))
  let el: HTMLElement | null = null
  if (heading) {
    const h = heading.trim().toLowerCase()
    el =
      [...root.querySelectorAll<HTMLElement>('[data-heading]')].find(
        (x) => (x.dataset['heading'] ?? '').trim().toLowerCase() === h
      ) ?? null
  } else if (line) {
    let best = -1
    for (const x of root.querySelectorAll<HTMLElement>('[data-line]')) {
      const n = Number(x.dataset['line'])
      if (n <= line && n > best) {
        best = n
        el = x
      }
    }
  }
  if (!el) {
    root.scrollTop = 0
    return
  }
  // a folded callout around the line opens so the line can be seen
  for (let p = el.parentElement; p && p !== root; p = p.parentElement)
    if (p instanceof HTMLDetailsElement) p.open = true
  el.classList.add('md-hit')
  el.scrollIntoView({ block: 'center' })
}

watch(
  () => [state.note, target.value] as const,
  async () => {
    notice.value = ''
    await nextTick()
    if (state.note && target.value && state.note.file === target.value.file)
      jump(target.value.line, target.value.heading)
    else if (body.value) body.value.scrollTop = 0
  }
)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') dash.closeNote()
  else if (e.altKey && e.key === 'ArrowLeft') void dash.noteBack()
  else if (e.altKey && e.key === 'ArrowRight') void dash.noteForward()
  else return
  e.preventDefault()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const folderPath = computed(() => {
  const f = note.value?.file ?? target.value?.file ?? ''
  const parts = f.split(/[\\/]/)
  return parts.slice(0, -1).join(' / ')
})
</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end bg-black/50" @click.self="dash.closeNote()">
    <aside
      class="flex h-full w-[min(940px,64vw)] flex-col border-l border-white/5 bg-ink-900 shadow-2xl"
      role="dialog"
      aria-label="Note viewer"
    >
      <header class="flex items-center gap-2 border-b border-white/5 px-4 py-2">
        <button
          class="btn-ghost px-2 py-1"
          :disabled="!canBack"
          title="Back (Alt ←)"
          @click="dash.noteBack()"
        >
          ←
        </button>
        <button
          class="btn-ghost px-2 py-1"
          :disabled="!canForward"
          title="Forward (Alt →)"
          @click="dash.noteForward()"
        >
          →
        </button>
        <div class="min-w-0 flex-1 px-2">
          <p class="eyebrow truncate">{{ folderPath || 'Vault' }} · read only</p>
          <p class="truncate text-sm text-mist-100">{{ note?.title ?? target?.file }}</p>
        </div>
        <button
          v-if="note"
          class="btn-ghost px-3 py-1"
          title="Open this note in the Obsidian app"
          @click="dash.openNote(note.file)"
        >
          Open in Obsidian ↗
        </button>
        <button class="btn-ghost px-2 py-1" title="Close (Esc)" @click="dash.closeNote()">✕</button>
      </header>
      <p
        v-if="notice"
        class="border-b border-warn-400/30 bg-warn-400/5 px-4 py-1.5 text-xs text-warn-400"
      >
        {{ notice }}
      </p>

      <div
        ref="body"
        class="note-body min-h-0 flex-1 overflow-y-auto px-8 py-5 text-[14px] text-mist-300"
      >
        <p v-if="state.noteLoading && !note" class="text-sm text-mist-500">Loading…</p>
        <p v-if="state.noteError" class="text-sm text-bad-400">{{ state.noteError }}</p>
        <template v-if="note">
          <dl
            v-if="note.frontmatter.length"
            class="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-[3px] border border-white/5 bg-ink-950 px-3 py-2 text-[12px]"
          >
            <template v-for="[k, v] in note.frontmatter" :key="k">
              <dt class="text-mist-500">{{ k }}</dt>
              <dd class="min-w-0 break-words text-mist-100">{{ v }}</dd>
            </template>
          </dl>
          <MdBlocks :blocks="note.blocks" />
          <p v-if="!note.blocks.length" class="text-sm text-mist-500">This note is empty.</p>

          <section v-if="note.backlinks.length" class="mt-8 border-t border-white/5 pt-4">
            <h3 class="eyebrow mb-2">Linked from</h3>
            <button
              v-for="b in note.backlinks"
              :key="`${b.file}:${b.line}`"
              class="mb-1 block w-full rounded-[3px] px-2 py-1.5 text-left hover:bg-ink-800"
              @click="dash.viewNote(b.file, b.line)"
            >
              <span class="text-[12px] text-gold-300">{{ b.title }}</span>
              <span class="block truncate text-[11px] text-mist-500">{{ b.text }}</span>
            </button>
          </section>
          <p class="mt-6 text-[10px] text-mist-700">
            {{ note.file }} · changed {{ when(new Date(note.mtimeMs).toISOString()) }}
          </p>
        </template>
      </div>
    </aside>
  </div>
</template>
