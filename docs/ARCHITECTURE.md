# Architecture (Phase 3)

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

## Computer lookup (offline)

`src/main/services/lookup/`. A computer page is built from what is already on this PC, so the
computer does not need to be connected:

- `vaultindex.ts` keeps every vault note in memory. Each lookup stats the notes and re-reads only
  those whose size or modification time changed (at most every 2 s). Read only.
- `computers.ts` merges enrolled devices, every stored scan and the computer rows of Asset
  Inventory into one record per machine (by device id, then serial, then name; two serials under
  one name stay two machines). It then collects tickets, Open Loops lines, Work Log parts,
  Change Log rows (the `CHANGES` block of the note Settings names, every table of the root ARH
  Change Log) and other mentions by whole-word match on the computer's names and serials,
  skipping the dashboard's own marker blocks. Vault times written in MT are converted to UTC
  so the timeline sorts correctly with scan times.
- Trends use `HealthReport.values`, raw numbers each scan now stores (disk free per drive, days
  since an update, failed sign-ins, battery health, RAM, CPU and more), drawn against the same
  thresholds that raise findings.
- Notes open in Obsidian through `obsidian://open?path=…`; the main process refuses any path
  outside the vault folder.

A test builds a vault ten times the size of ARH IT (900 extra notes) and requires a computer
page in under 1.5 s with the index warm.

## Note reader (inside the dashboard)

`src/shared/markdown.ts` turns a note into a tree (frontmatter, headings, lists and task boxes,
callouts, tables, code, wikilinks, tags), never HTML; `MdBlocks.vue` and `MdInline.vue` draw it
with text nodes only, so note content cannot inject markup or script. Comments, the dashboard's
own markers and `^block-ids` are hidden as in Obsidian's reading view, and every block keeps its
source line so a click can jump to and mark that line. The main process (`lookup/notes.ts`)
reads only notes the vault index knows, resolves each `[[link]]` the way Obsidian does (exact
path, else file name; same folder first, then the shortest path) and lists backlinks.
Opening Obsidian itself is a separate, explicit action.

## Actions (Phase 3)

Design, threat model and the critique it went through: [PHASE3-DESIGN.md](PHASE3-DESIGN.md).

- **Files:** `actions/*.json` (schema `arh-action/1`), each with a read-only `measure` script and
  an `apply` script. The agent embeds them (`actions/embed.go`, validated and linted at load:
  no eval-like constructs, quoted sh parameters, native exit codes checked, parameter patterns
  anchored as a whole and tested with sample values); the dashboard ships the same files and
  hashes them byte for byte. `actions/versions.lock` pins each released version's hash.
- **Agent** (`agent/internal/link/actions.go`): checks the device policy (`agent/internal/policy`)
  and the cable on every request, runs measure → apply → measure with a result file it owns,
  keeps results in an outbox until acknowledged, refuses repeated run ids, and writes
  `actions.log` plus the OS log (`agent/internal/audit`). One agent process uses the data folder
  at a time (`agent/internal/datalock`), so a second one cannot report the first one's live run
  as interrupted. The executor gives actions a clean environment and system PATH, sends long
  scripts on stdin (Windows) or fd 3 (macOS/Linux), and ends the whole process tree on timeout
  (Job Objects, process groups).
- **Dashboard** (`src/main/services/actions/`): `ActionCatalog`, `ActionRunner` (every gate in
  main: Settings, policy, cable, agent copy, preview ticket, reason, technician, typed name),
  `ActionLog` (hash-chained JSONL), `DeviceSlots` (one run per device, shared with scans).
  `src/shared/actions.ts` works out the status from the measurements; the vault blocks
  (`vault/content.ts`: `mergeChanges`, `mergeLog`) and `vaultText()` turn records into rows.
- **Page:** `ComputerActions.vue`, `ActionDialog.vue`, `ActionRun.vue`, `ExecDialog.vue`,
  Settings › Access and control.

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
- Changes are bound to the cable, not to a hardware key: someone with both the dashboard's key
  and a cable to a computer could run the named actions there. A TPM-backed approval key the
  agent pins is the next step (PHASE3-DESIGN.md, "Not in this phase").
- A LAN adapter whose DHCP failed (so it holds only a self-assigned 169.254 address) looks like
  a cable to the agent: someone holding the dashboard's key on the same network segment could
  then make changes on that computer until its DHCP works again. Every other network adapter
  (with any routable address, default route or not) is treated as the network.
- On Windows, install refuses a data folder that already exists and does not belong to SYSTEM or
  an administrator (`C:\ProgramData` lets any user create folders), takes the folder for SYSTEM,
  and trusts `policy.json` only when SYSTEM or an administrator owns it.
- Windows PowerShell looks up a command it has not loaded by searching every module, through
  a cache keyed on local-time file stamps; after a time zone change (or with a cold cache) that
  search took 11 to 20 s per process on test machines. The agent imports the modules a scan check
  or action uses by full path first (a table in `agent/internal/executor/modules.go`, proven
  complete for the shipped scripts in CI with the search turned off), so its launches stay at
  about 0.2 s. A custom command that uses a command outside that table may still be slow then.
- A restart is recorded as scheduled; whether it happened is not yet confirmed from the next
  `bootTime`.
- The note viewer reads a note's block structure once to hide `%%` comments and again to show it,
  so that no comment shows and no command in a code block is cut. Notes of several MB with many
  comments or deeply nested lists open about 1.5 to 2.5 times slower than before that rule (on
  test machines about 0.5 to 1 s for 2 MB, up to 2 s for a 4 MB note); everyday notes take
  milliseconds. The parse runs in the main process, so the window waits for it.
- Restart counts as "signed in" anyone who owns a process in a session above 0, not only those
  running `explorer.exe`, so a process left over for a moment after sign-out can still make the
  dashboard ask for the typed computer name.
- `linux-service-start` reads how a one-shot service's last run ended from this boot's journal
  (PID 1's success, failure or skip record for the unit). Without such a record (journald off,
  `LogLevelMax=` below info on the unit, or systemd older than 246), it reads the status of every
  command of the run. A start that timed out, was killed with a signal listed in
  `SuccessExitStatus=` and was then cleared with `reset-failed` reads as done in that case, and a
  one-shot systemd has unloaded since its run reads as never started.
- Actions need the Phase 3 agent on each device (reinstall with a new token); older agents stay
  read only, and the security-check profile is now v2.
- Saving Settings in an older build (Phase 2) drops the settings it does not know, the settings
  version among them. The next time this build starts it is back at full access, live vault
  writes and the shipped Change Log note.
