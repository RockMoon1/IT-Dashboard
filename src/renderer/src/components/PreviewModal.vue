<script setup lang="ts">
import { computed } from 'vue'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const preview = computed(() => state.preview)
const canApply = computed(
  () => !!preview.value?.live && preview.value.notes.some((n) => n.changed && !n.error)
)

function close(): void {
  state.previewOpen = false
}

function name(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
</script>

<template>
  <div
    class="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-6"
    @click.self="close"
  >
    <div class="card card-gold flex max-h-[90vh] w-full max-w-4xl flex-col">
      <div class="flex items-start justify-between border-b border-white/5 px-6 py-4">
        <div>
          <p class="eyebrow">
            {{ preview?.live ? 'Live write' : 'Dry run' }} · exact changes to existing notes
          </p>
          <h2 class="display mt-1 text-2xl">Vault write preview</h2>
          <p class="text-xs text-mist-500">
            Only text between <code>&lt;!-- DASH:…:START --&gt;</code> and
            <code>&lt;!-- DASH:…:END --&gt;</code> markers changes. Missing markers are added once
            at the end of the note. Notes are never created.
          </p>
        </div>
        <button class="btn-ghost" @click="close">Close</button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <p v-if="!preview" class="text-sm text-mist-500">Computing diff…</p>
        <div v-for="n in preview?.notes ?? []" :key="n.notePath" class="mb-4">
          <div class="flex items-center gap-3">
            <span class="display text-lg">{{ name(n.notePath) }}</span>
            <span v-if="!n.exists" class="badge border border-bad-400/50 text-bad-400"
              >missing</span
            >
            <span v-else-if="n.error" class="badge border border-bad-400/50 text-bad-400"
              >error</span
            >
            <span v-else-if="!n.changed" class="badge border border-white/10 text-mist-500"
              >unchanged</span
            >
            <span v-else class="badge border border-gold-400/50 text-gold-300"
              >+{{ n.added }} −{{ n.removed }}</span
            >
            <span v-if="n.markersCreated.length" class="text-[11px] text-mist-500"
              >adds markers: {{ n.markersCreated.join(', ') }}</span
            >
            <span v-if="n.backupExists" class="text-[11px] text-mist-700">backup kept</span>
          </div>
          <p class="text-[11px] text-mist-700">{{ n.notePath }}</p>
          <p v-if="n.error" class="mt-1 text-xs text-bad-400">{{ n.error }}</p>
          <pre
            v-else-if="n.diff"
            class="mt-2 max-h-80 overflow-auto rounded bg-ink-950 p-3 font-mono text-[11px] leading-5"
          ><template v-for="(line, i) in n.diff.split('\n')" :key="i"><span :class="line.startsWith('+') && !line.startsWith('+++') ? 'text-ok-400' : line.startsWith('-') && !line.startsWith('---') ? 'text-bad-400' : line.startsWith('@@') ? 'text-gold-300' : 'text-mist-500'">{{ line }}</span>{{ '\n' }}</template></pre>
        </div>
        <div v-if="state.applyResults" class="mt-4 card p-3 text-xs">
          <p class="eyebrow mb-1">Result</p>
          <ul class="space-y-1">
            <li
              v-for="r in state.applyResults"
              :key="r.notePath"
              :class="r.error ? 'text-bad-400' : r.written ? 'text-ok-400' : 'text-mist-500'"
            >
              {{ name(r.notePath) }}: {{ r.error ?? (r.written ? 'written' : 'unchanged')
              }}{{ r.backupPath ? ` · backup ${r.backupPath}` : '' }}
              <span v-if="r.conflictCopies.length" class="text-warn-400">
                · OneDrive conflict copies: {{ r.conflictCopies.join(', ') }}</span
              >
            </li>
          </ul>
        </div>
      </div>
      <div class="flex items-center justify-between border-t border-white/5 px-6 py-3">
        <span class="text-xs text-mist-500">
          {{
            preview?.live
              ? 'Live mode: apply writes these diffs atomically with a first-write backup.'
              : 'Dry-run mode: enable live writes in Settings after the vault schema is approved.'
          }}
        </span>
        <button
          class="btn-gold"
          :disabled="!canApply || state.applying"
          @click="dash.applyPreview()"
        >
          {{ state.applying ? 'Writing…' : 'Apply to vault' }}
        </button>
      </div>
    </div>
  </div>
</template>
