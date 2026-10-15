# Architecture (Phase 2)

The dashboard is a local Windows application for one technician. A computer plugged into the
technician's PC with a cable is detected, identified, and scanned through a small agent that
runs on that computer. Results stream to the dashboard and are recorded in existing Obsidian
notes. Phase 1's WinRM/SSH design was replaced; the reasons are below.

```
 Technician PC (Windows)                                   Target computer (Win/macOS/Linux)
 ┌──────────────────────────────────────────┐   cable     ┌───────────────────────────────┐
 │ Electron main (Node)                     │  network    │ arh-agent (Go, one binary)     │
 │  detection: WMI events → Get-NetAdapter  │◄──────────► │  listens for beacons (UDP)     │
 │  beacon: UDP 47911 broadcast + ff02::…   │  link       │  dials out TLS 1.3 → tcp/47912 │
 │  link server: TLS 1.3, mutual, pinned    │             │  key in DPAPI/Keychain/0600    │
 │  enrollment tokens, device registry      │             │  runs only embedded profiles   │
 │  scan runner → health → scan log         │             │  read-only checks, 1 MiB cap   │
 │  vault writer (markers, dry-run, backup) │             └───────────────────────────────┘
 │  secrets: Windows Credential Manager     │
 ├──────────────────────────────────────────┤
 │ Preload: typed window.arh bridge         │
 │ Renderer: Vue 3 + Tailwind (dark)        │
 └──────────────────────────────────────────┘
```

## Decisions and reasons

| Decision                                                            | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agent in Go, standard library only**                              | One static binary per OS/arch (≈5 MB), no runtime on the target, cross-compiled from one machine. No third-party modules means nothing to audit or download. Considered: Node (needs a runtime or a 40+ MB bundle), PowerShell/bash only (no macOS/Linux parity for TLS pinning and a keystore), Rust (equal result, slower to iterate).                                                                                                                                   |
| **The agent dials out; the host never connects in**                 | Matches the brief: no inbound SSH/WinRM on targets. The agent needs one inbound UDP rule for the beacon (added at install, which already needs admin). The host needs one inbound TCP rule for 47912 (one UAC prompt from the Link tab).                                                                                                                                                                                                                                   |
| **"USB" means a network link over a cable**                         | USB is a host/device bus; two PCs on a plain USB-A cable do not talk. What works: an Ethernet cable through a USB-Ethernet adapter, a USB-C/Thunderbolt/USB4 host-to-host networking cable, or a USB bridge cable that exposes a network adapter. Each appears on Windows as a network adapter whose PnP id starts with `USB\` (or a Thunderbolt/USB4 networking adapter), and both ends self-assign link-local addresses (169.254/16 and fe80::/10).                      |
| **Beacon on IPv4 broadcast and an IPv6 link-local multicast group** | Windows and macOS self-assign 169.254.x.x on a link with no DHCP; Linux usually does not, but always has an fe80:: address. The agent joins `ff02::4152:4831` on every interface (rescanned every 10 s, so a USB adapter that appears later is covered).                                                                                                                                                                                                                   |
| **Mutual TLS with pinned fingerprints, not a CA**                   | Two parties only. The device id _is_ the SHA-256 of the agent's certificate; the agent pins the dashboard's certificate after enrollment. No certificate authority to run or expire.                                                                                                                                                                                                                                                                                       |
| **Enrollment: one-time token + HMAC proof**                         | `ARH-<fp8>-<80-bit secret>`, valid 10 minutes, single use. The dashboard proves it knows the secret (HMAC over the agent's nonce and the dashboard fingerprint) before the agent pins it, so another machine on the link cannot impersonate the dashboard. Re-installing the agent on the same machine (same serial) moves the record to the new key.                                                                                                                      |
| **Keys**                                                            | Dashboard: TLS private key in Windows Credential Manager (generic credential, local machine persistence, < 2560 bytes); fallback Electron safeStorage (DPAPI) if Credential Manager fails. Agent: Windows DPAPI machine scope in `C:\ProgramData\ARH Agent` (ACL: SYSTEM + Administrators), macOS System keychain, Linux root-only 0600 file (a system daemon has no Secret Service session; same posture as SSH host keys). Never in plaintext files, never in the vault. |
| **Profiles are data, compiled into the agent**                      | The host sends only `{profile, version}`. The agent refuses unknown names, version mismatches and any check whose `access` is not `read`. Write/execute actions need a new agent build _and_ a per-action approval message that version 1 does not have.                                                                                                                                                                                                                   |
| **Windows agent runs as a SYSTEM scheduled task**                   | No service-control dependency. Registered through the ScheduledTasks module because `schtasks /Create` cannot remove the default 72-hour execution limit. Restart on failure, runs on battery.                                                                                                                                                                                                                                                                             |
| **Per-user data under SYSTEM**                                      | HKCU would be SYSTEM's hive. Per-user checks enumerate `Win32_UserProfile` and read each loaded `HKEY_USERS\<SID>` hive and each profile folder instead, and label results by user.                                                                                                                                                                                                                                                                                        |
| **Express dropped (since Phase 1)**                                 | Electron IPC is already the RPC layer.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Vault writes behind markers + dry-run**                           | See `docs/VAULT-SCHEMA.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Detection (WMI)

`scripts/Verify-Wmi.ps1` checks every class and event subscription below on the machine it runs on;
CI runs it on `windows-latest`. Run it once on the technician PC (`npm run verify-wmi`).

| Purpose                       | Subscription                                                                                             | Why this one                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Any device arrival/removal    | `Win32_DeviceChangeEvent` (root/cimv2, extrinsic)                                                        | Pushed by the OS, no polling cost. Triggers a debounced `Get-PnpDevice` refresh.  |
| Network adapter added/removed | `__InstanceCreationEvent` / `__InstanceDeletionEvent WITHIN 2` on `MSFT_NetAdapter` (root/StandardCimv2) | Adapter-level, carries `PnPDeviceID` and `InterfaceDescription`.                  |
| Adapter link up/down          | `__InstanceModificationEvent WITHIN 2 … State <> PreviousInstance.State` on `MSFT_NetAdapter`            | The cable is plugged after the adapter exists.                                    |
| (verified, not used)          | `__InstanceCreationEvent WITHIN 5` on `Win32_PnPEntity`                                                  | Polls every PnP entity; heavier than the device-change event for the same signal. |

Polling fallbacks (15 s adapters, 10 s USB) cover a WMI listener that dies; the listener is restarted.

## Scan flow

1. Adapter comes up → beacon starts on its addresses → enrolled agent connects → device turns green.
2. Double-click → purpose dialog, pre-selected from history (last purpose; Security Check if the
   last scan had critical findings; repeat a failed scan).
3. Confirm → profile `<os>-<purpose>` v1 runs immediately; each check streams `check-start`,
   `check-output`, `check-end`. "Other" runs the baseline System Diagnostics profile in v1.
4. Health evaluation applies the thresholds (`src/main/services/scans/health.ts`): disk < 15 %
   free, AV or real-time protection off, no update in > 30 days, ≥ 20 failed sign-ins in 24 h,
   SMART failure, firewall profile off, and more. Findings marked `loop` become Open Loop tasks.
5. Scan log (JSONL in app data): timestamp, run id, device id, serial, hostname, OS, purpose,
   profile and version, technician, duration, status, exit status, check and finding counts.
6. Vault: preview diff (default) → apply when live writes are on.

## Data collected and not collected

Configuration and health only: OS, hardware, storage, drivers, services, security settings,
update state, event counts, installed software names, extension names and permissions, names of
executable files in Downloads (counts only for archives and macro documents). No document
contents, no email content, no browser history, no patient data. Event log checks return counts
and first lines of System/Security events, not message bodies of application logs.

## Known limits

- Outlook client rules need an interactive Outlook session; they are not read in v1.
- `MSAcpi_ThermalZoneTemperature` is missing on most consumer boards (optional check).
- macOS per-sensor temperatures need `powermetrics` (root, slow); not collected.
- The agent is unsigned; Windows SmartScreen and macOS Gatekeeper will warn on first run
  (macOS: `xattr -d com.apple.quarantine arh-agent-darwin-arm64`).
