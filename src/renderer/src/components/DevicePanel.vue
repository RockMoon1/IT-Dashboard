<script setup lang="ts">
import { computed } from 'vue'
import { PURPOSES, type Protocol, type TargetOS } from '@shared/types'
import { useDashboard } from '../store'
import OutputConsole from './OutputConsole.vue'
import SummaryCard from './SummaryCard.vue'

const dash = useDashboard()
const { state } = dash

const device = computed(() => dash.selectedDevice.value)
const isLocal = computed(() => device.value?.kind === 'local')
const purposeInfo = computed(() => PURPOSES.find((p) => p.id === state.purpose))
const osOptions: Array<{ value: TargetOS; label: string }> = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
  { value: 'unknown', label: 'Unknown (treated as Linux over SSH)' }
]

const protocols = computed<Array<{ value: Protocol; label: string; hint: string }>>(() =>
  isLocal.value
    ? [{ value: 'local', label: 'Local', hint: 'Runs on this PC' }]
    : [
        {
          value: 'winrm',
          label: 'WinRM',
          hint: 'Windows targets · Enable-PSRemoting on the target'
        },
        { value: 'ssh', label: 'SSH', hint: 'macOS, Linux or Windows with OpenSSH Server' }
      ]
)

const canRun = computed(() => {
  if (!device.value || state.running) return false
  if (!state.authorizationConfirmed) return false
  if (state.purpose === 'other' && !state.customCommands.trim()) return false
  if (state.protocol === 'local') return true
  if (!state.host.trim()) return false
  const c = state.credentials
  if (state.protocol === 'winrm') return Boolean(c.username && c.password)
  return Boolean(c.username && (c.password || c.privateKeyPath))
})

const probeText = computed(() => {
  const p = state.probe
  if (!p) return ''
  const ports = p.openPorts.length
    ? `open ports ${p.openPorts.join(', ')}`
    : 'no remoting ports open'
  return `${p.reachable ? 'Reachable' : 'Unreachable'} · ${ports} · ${p.osHint} (${p.durationMs} ms)`
})
</script>

<template>
  <section v-if="device" class="flex min-h-0 flex-col overflow-y-auto">
    <div class="border-b border-ink-700 px-6 py-4">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h2 class="truncate text-xl font-semibold">{{ device.name }}</h2>
          <p class="text-sm text-mist-500">
            <span class="badge mr-2 bg-ink-800 text-mist-300">{{ device.kind }}</span>
            <span v-if="device.host">{{ device.host }}</span>
            <span v-if="device.mac"> · {{ device.mac }}</span>
            <span v-if="device.serial"> · SN {{ device.serial }}</span>
            <span v-if="device.manufacturer"> · {{ device.manufacturer }}</span>
          </p>
          <p class="mt-1 text-xs text-mist-500">{{ device.osHint }}</p>
        </div>
        <button
          class="btn-ghost shrink-0"
          :disabled="state.running"
          @click="state.purposeModalOpen = true"
        >
          Change purpose
        </button>
      </div>
    </div>

    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6 px-6 py-5">
      <div class="card p-4">
        <h3 class="label">1 · Purpose</h3>
        <select v-model="state.purpose" class="field" :disabled="state.running">
          <option v-for="p in PURPOSES" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
        <p class="mt-2 text-xs text-mist-500">{{ purposeInfo?.description }}</p>
        <div v-if="state.purpose === 'other'" class="mt-3">
          <label class="label" for="custom-commands"
            >Custom commands (one per line, # for comments)</label
          >
          <textarea
            id="custom-commands"
            v-model="state.customCommands"
            class="field h-32 font-mono text-xs"
            spellcheck="false"
            placeholder="Get-Service -Name Spooler | Format-List&#10;Get-EventLog -LogName Application -Newest 20"
          ></textarea>
        </div>
        <label class="label mt-4" for="session-notes">Notes for the vault entry (optional)</label>
        <input
          id="session-notes"
          v-model="state.notes"
          class="field"
          placeholder="Ticket #, user name, symptoms…"
        />
      </div>

      <div class="card p-4">
        <h3 class="label">2 · Connection</h3>
        <div class="mb-3 flex gap-2">
          <button
            v-for="p in protocols"
            :key="p.value"
            type="button"
            class="flex-1 rounded-md border px-3 py-2 text-left text-sm"
            :class="
              state.protocol === p.value
                ? 'border-gold-500 bg-ink-800'
                : 'border-ink-600 hover:border-mist-500'
            "
            :title="p.hint"
            :disabled="state.running"
            @click="dash.setProtocol(p.value)"
          >
            <span class="block font-semibold">{{ p.label }}</span>
            <span class="block text-xs text-mist-500">{{ p.hint }}</span>
          </button>
        </div>

        <template v-if="state.protocol !== 'local'">
          <div class="mb-3 grid grid-cols-[1fr_auto] gap-2">
            <div>
              <label class="label" for="target-host">Host name or IP</label>
              <input
                id="target-host"
                v-model="state.host"
                class="field"
                placeholder="LAPTOP-01 or 192.168.1.20"
                :disabled="state.running"
              />
            </div>
            <div class="flex items-end">
              <button
                type="button"
                class="btn-ghost"
                :disabled="state.probing || !state.host.trim() || state.running"
                @click="dash.runProbe()"
              >
                {{ state.probing ? 'Probing…' : 'Probe' }}
              </button>
            </div>
          </div>
          <p
            v-if="probeText"
            class="mb-3 text-xs"
            :class="state.probe?.reachable ? 'text-mist-300' : 'text-warn-400'"
          >
            {{ probeText }}
          </p>

          <div class="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label class="label" for="target-os">Target OS</label>
              <select
                id="target-os"
                v-model="state.targetOs"
                class="field"
                :disabled="state.running || state.protocol === 'winrm'"
              >
                <option v-for="o in osOptions" :key="o.value" :value="o.value">
                  {{ o.label }}
                </option>
              </select>
            </div>
            <div>
              <label class="label" for="target-port">Port</label>
              <input
                id="target-port"
                v-model.number="state.credentials.port"
                class="field"
                type="number"
                :placeholder="state.protocol === 'ssh' ? '22' : '5985 (5986 with SSL)'"
                :disabled="state.running"
              />
            </div>
          </div>

          <div class="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label class="label" for="cred-user">Username</label>
              <input
                id="cred-user"
                v-model="state.credentials.username"
                class="field"
                autocomplete="off"
                :disabled="state.running"
              />
            </div>
            <div>
              <label class="label" for="cred-pass">Password</label>
              <input
                id="cred-pass"
                v-model="state.credentials.password"
                class="field"
                type="password"
                autocomplete="off"
                :disabled="state.running"
              />
            </div>
          </div>

          <div v-if="state.protocol === 'ssh'" class="mb-3 grid grid-cols-2 gap-3">
            <div>
              <label class="label" for="cred-key">Private key path (optional)</label>
              <input
                id="cred-key"
                v-model="state.credentials.privateKeyPath"
                class="field"
                placeholder="C:\Users\tech\.ssh\id_ed25519"
                :disabled="state.running"
              />
            </div>
            <div>
              <label class="label" for="cred-passphrase">Key passphrase</label>
              <input
                id="cred-passphrase"
                v-model="state.credentials.passphrase"
                class="field"
                type="password"
                autocomplete="off"
                :disabled="state.running"
              />
            </div>
          </div>

          <div v-if="state.protocol === 'winrm'" class="mb-3 flex gap-4 text-sm">
            <label class="flex items-center gap-2"
              ><input
                v-model="state.credentials.useSsl"
                type="checkbox"
                :disabled="state.running"
              />
              Use HTTPS (5986)</label
            >
            <label class="flex items-center gap-2"
              ><input
                v-model="state.credentials.skipCertCheck"
                type="checkbox"
                :disabled="state.running || !state.credentials.useSsl"
              />
              Skip certificate checks</label
            >
          </div>
        </template>

        <label class="mt-2 flex items-start gap-2 rounded-md border border-ink-600 p-3 text-sm">
          <input
            v-model="state.authorizationConfirmed"
            type="checkbox"
            class="mt-0.5"
            :disabled="state.running"
          />
          <span>
            I am authorised to run diagnostic commands on this device and the owner has agreed to
            this session.
            <span class="block text-xs text-mist-500"
              >WinRM and SSH authenticate with credentials; the target shows no consent prompt, so
              this confirmation is recorded with the session.</span
            >
          </span>
        </label>

        <div class="mt-4 flex items-center gap-2">
          <button
            type="button"
            class="btn-primary"
            :disabled="!canRun"
            @click="dash.startSession()"
          >
            {{ state.running ? 'Running…' : 'Run diagnostics' }}
          </button>
          <button
            v-if="state.running"
            type="button"
            class="btn-danger"
            @click="dash.abortSession()"
          >
            Abort
          </button>
          <span v-if="state.protocol === 'winrm' && !isLocal" class="text-xs text-mist-500"
            >Workgroup targets by IP need TrustedHosts on this PC (see README).</span
          >
        </div>
      </div>
    </div>

    <div class="px-6 pb-6">
      <OutputConsole />
      <SummaryCard v-if="state.summary" class="mt-5" />
    </div>
  </section>
</template>
