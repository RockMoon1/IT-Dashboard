<script setup lang="ts">
import { ref } from 'vue'
import { useDashboard } from '../store'

const dash = useDashboard()
const { state } = dash
const fwMessage = ref('')

async function enableFirewall(): Promise<void> {
  fwMessage.value = await dash.enableFirewall()
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* clipboard unavailable */
  }
}
</script>

<template>
  <div class="space-y-5 p-6">
    <div class="grid grid-cols-2 gap-4">
      <div class="card card-gold p-4">
        <p class="eyebrow">Dashboard identity</p>
        <p class="mt-2 text-xs text-mist-500">
          Fingerprint (SHA-256 of the host certificate; agents pin it after enrollment)
        </p>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 break-all font-mono text-xs">{{
            state.link?.hostFingerprint || 'not generated'
          }}</code>
          <button
            class="btn-ghost px-2 py-1 text-[10px]"
            @click="copy(state.link?.hostFingerprint ?? '')"
          >
            copy
          </button>
        </div>
        <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt class="text-mist-500">Listening</dt>
          <dd>{{ state.link?.listening ? `tcp/${state.link.port} (TLS 1.3, mutual)` : 'no' }}</dd>
          <dt class="text-mist-500">Beacons</dt>
          <dd>
            {{
              state.link?.beaconInterfaces.length
                ? state.link.beaconInterfaces.join(', ')
                : 'none (no link adapter is up)'
            }}
          </dd>
          <dt class="text-mist-500">Private key</dt>
          <dd>{{ state.link?.secretStore }}</dd>
          <dt class="text-mist-500">Agent binary</dt>
          <dd class="break-all">
            {{ state.link?.agentBinary ?? 'not found — run npm run agent:build' }}
          </dd>
        </dl>
        <p v-if="state.link?.lastError" class="mt-2 text-xs text-bad-400">
          {{ state.link.lastError }}
        </p>
      </div>
      <div class="card p-4">
        <p class="eyebrow">Windows firewall</p>
        <p class="mt-2 text-sm">
          Inbound rule for the link port:
          <span
            :class="
              state.link?.firewallRulePresent
                ? 'text-ok-400'
                : state.link?.firewallRulePresent === false
                  ? 'text-warn-400'
                  : 'text-mist-500'
            "
          >
            {{
              state.link?.firewallRulePresent == null
                ? 'not applicable on this OS'
                : state.link?.firewallRulePresent
                  ? 'present'
                  : 'missing'
            }}
          </span>
        </p>
        <p class="mt-1 text-xs text-mist-500">
          Agents connect inbound to this PC on TCP {{ state.link?.port }}. Creating the rule needs
          one UAC approval.
        </p>
        <button
          class="btn-gold mt-3"
          :disabled="state.link?.firewallRulePresent !== false || state.busy !== null"
          @click="enableFirewall"
        >
          Create firewall rule (UAC)
        </button>
        <p v-if="fwMessage" class="mt-2 text-xs text-mist-300">{{ fwMessage }}</p>
      </div>
    </div>

    <div class="card">
      <div class="flex items-center justify-between border-b border-white/5 px-4 py-2">
        <h3 class="display text-lg">Network adapters</h3>
        <label class="flex items-center gap-2 text-xs text-mist-500">
          <input
            type="checkbox"
            :checked="state.settings?.beaconAllAdapters"
            @change="
              dash.saveSettings({ beaconAllAdapters: ($event.target as HTMLInputElement).checked })
            "
          />
          beacon on every adapter (testing on a LAN or VM)
        </label>
      </div>
      <table class="w-full text-xs">
        <thead>
          <tr class="text-left text-mist-500">
            <th class="px-4 py-1 font-medium">Name</th>
            <th class="py-1 pr-3 font-medium">Description</th>
            <th class="py-1 pr-3 font-medium">Status</th>
            <th class="py-1 pr-3 font-medium">Link</th>
            <th class="py-1 pr-3 font-medium">IPv4</th>
            <th class="py-1 pr-3 font-medium">IPv6 link-local</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in state.link?.adapters ?? []"
            :key="a.name"
            class="border-t border-white/5"
            :class="{ 'text-gold-300': a.isLink }"
          >
            <td class="px-4 py-1">{{ a.name }}</td>
            <td class="py-1 pr-3 text-mist-300">{{ a.description }}</td>
            <td class="py-1 pr-3">{{ a.status }}</td>
            <td class="py-1 pr-3" :title="a.linkReason">{{ a.isLink ? 'yes' : '' }}</td>
            <td class="py-1 pr-3 font-mono">{{ a.ipv4.join(', ') }}</td>
            <td class="py-1 pr-3 font-mono">{{ a.ipv6LinkLocal.join(', ') }}</td>
          </tr>
          <tr v-if="!state.link?.adapters.length">
            <td colspan="6" class="px-4 py-3 text-mist-500">
              No adapters enumerated (Windows only).
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="border-b border-white/5 px-4 py-2">
        <h3 class="display text-lg">Dashboard log</h3>
      </div>
      <div class="max-h-72 overflow-y-auto p-3 font-mono text-[11px] leading-5 text-mist-300">
        <div v-for="(l, i) in state.logLines.slice(-150)" :key="i">
          <span class="text-mist-700">{{ l.at.slice(11, 19) }}</span>
          <span class="text-gold-300">[{{ l.source }}]</span> {{ l.text }}
        </div>
        <p v-if="!state.logLines.length" class="text-mist-700">Nothing logged yet this session.</p>
      </div>
    </div>
  </div>
</template>
