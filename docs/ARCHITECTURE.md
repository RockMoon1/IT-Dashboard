# Architecture and Phase 1 review

This document records the Phase 1 foundation, what was verified, and where the implementation
departs from the original plan because the plan assumed something that is not how the
underlying technology works. Each departure states the fact and the resulting design.

## 1. Obsidian vault integration

Vault: `C:\Users\lpell\OneDrive\Documents\Obsidian Vault\ARH IT` (configurable).

| Note              | Role in the schema        | What the app writes                                        |
| ----------------- | ------------------------- | ---------------------------------------------------------- |
| `ARH IT Hub.md`   | index / current state     | foldable callout per run under `## Device Scans` (H2)      |
| `ARH Work Log.md` | append-only record, dated | one `- HH:MM · Device scan · …` line under `## YYYY-MM-DD` |

Rules implemented in `src/main/services/vault/obsidian.ts`:

- No file creation. Missing vault folder or missing note → `VaultError`, surfaced in the UI.
- `## Device Scans` is created inside the hub note if absent; a section ends at the next heading
  of level ≤ 2, fenced code blocks are skipped when scanning for headings.
- The work-log date heading is matched by prefix (`## 2026-10-14 (Tue)` counts), consecutive
  list items stay in one list, line endings (CRLF/LF) are preserved.
- Entries are plain Markdown with Obsidian callouts (`> [!info]-`) and wikilinks; no plugins
  required.

## 2. Device detection and remoting: what changed and why

### USB cannot discover computers

USB is an asymmetric host/device bus. A PC connected to another PC with an ordinary USB cable
does not enumerate as a device (that requires a bridge cable with its own chip). What
`Get-PnpDevice` sees are peripherals: storage, phones in MTP mode, HID, USB network adapters.

Design consequence: the USB pane is kept for hardware triage and identification (`usb.ts` groups
PnP interfaces into one entry per physical device, with VID/PID/serial and status), but remote
diagnostics always target a **network host**. Hosts come from the IPv4 neighbour table
(`Get-NetNeighbor`, i.e. machines this PC has already exchanged packets with), reverse DNS, a
port probe, and manual entry.

The "connect via cord" workflow still works, through a different cord: an Ethernet cable between
the two PCs, or a Thunderbolt/USB4 cable on machines that support host-to-host networking, forms
a two-node network where both ends self-assign link-local `169.254.x.x` addresses. Those
neighbours are deliberately kept in discovery and labelled as link-local.

### There is no consent prompt on the target

WinRM and SSH authenticate with credentials and run non-interactively. The target shows nothing.
Instead of a fake "Allow remote commands? (Yes/No)" the UI has an authorisation checkbox that is
required to start a session and recorded with it. If the technician is physically at the device,
the local run path (`This PC` device) covers the on-site case without remoting.

### Protocol per target OS

| Target  | Protocol | Transport in this app                                                |
| ------- | -------- | -------------------------------------------------------------------- |
| Windows | WinRM    | local `Invoke-Command` driven by the host's PowerShell (`winrm.ts`)  |
| Windows | SSH      | ssh2 → `powershell.exe -EncodedCommand …` (default shell can be cmd) |
| macOS   | SSH      | ssh2 → script piped to `/bin/sh -s` (zsh never parses it)            |
| Linux   | SSH      | same as macOS                                                        |

OS detection is a heuristic (`probe.ts`): SSH banner text (`OpenSSH_for_Windows`, distro
suffixes), then WinRM ports, then RDP/SMB. A bare `OpenSSH_9.x` banner cannot distinguish macOS
from Linux, so the UI lets the technician choose; unknown + SSH runs the Linux set, which is the
most portable.

### Execution and streaming

- Commands run one at a time per session with a per-command timeout (default 90 s) and an
  abort signal; stdout/stderr chunks are forwarded over IPC as they arrive.
- PowerShell scripts carry a preamble (`$ProgressPreference`, UTF-8 console output) and run via
  `-EncodedCommand` so quoting never breaks.
- WinRM: password and target script travel in the child process environment, the script runs in
  a `[scriptblock]`, remote non-terminating errors are reported on stderr, transport errors give
  exit 1.
- SSH: host keys pinned per `host:port` (SHA-256) in settings; trust-on-first-use by default,
  strict mode optional; a changed key aborts.

## 3. Command catalog corrections

| Plan item                  | Fact                                                                                                          | Implementation                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Get-ComputerInfo`         | 10–30 s on many machines, output is huge                                                                      | CIM classes (`Win32_OperatingSystem`, `Win32_ComputerSystem`, …) emitted as JSON                                                                                                                                       |
| "system temps (WMI)"       | `MSAcpi_ThermalZoneTemperature` is unsupported on most consumer PCs                                           | optional command, reports `supported: false` instead of failing                                                                                                                                                        |
| `Get-Mailbox`              | Exchange Online cmdlet; needs the EXO module and admin consent on the technician's machine, not the target    | replaced by Outlook/M365 install + profile + OST checks on the target, TCP reachability of M365 endpoints, MX/autodiscover/SPF DNS for the UPN domain                                                                  |
| "recent suspicious emails" | mailbox content is not readable over WinRM without Outlook COM in an interactive session or Graph permissions | client-side Outlook rules via COM when interactive (forward/redirect rules are the classic compromise indicator), plus proxy/DNS/hosts tampering, SmartScreen/PUA/macro settings, risky downloads with Mark-of-the-Web |
| per-user state over WinRM  | HKCU and %LOCALAPPDATA% belong to the remoting account, not the console user                                  | every per-user command reports `evaluatedAs`; the UI explains it                                                                                                                                                       |
| performance counters       | counter names are localised                                                                                   | wrapped in try/catch, nulls are tolerated in the summariser                                                                                                                                                            |
| Express backend            | redundant inside Electron (IPC is already the RPC layer)                                                      | dropped; `ipcMain.handle` + `contextBridge`                                                                                                                                                                            |

Every command's raw output is kept with the session; the "findings" are threshold rules in
`summary.ts` (documented constants) so the technician can check the reasoning.

## 4. Stack

| Component        | Choice                                         | Note                                                            |
| ---------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Shell            | Electron ≥ 38, electron-vite 3                 | sandboxed renderer, CJS main/preload output                     |
| UI               | Vue 3 `<script setup>`, Tailwind v4            | dark theme tokens in `src/renderer/src/styles.css`              |
| Remoting         | host PowerShell (WinRM), ssh2 (SSH)            | no native modules required                                      |
| Device detection | PowerShell/CIM, `Win32_DeviceChangeEvent`      | event-driven refresh with a slow polling fallback               |
| Vault            | Node `fs`                                      | direct append to existing notes                                 |
| Tests            | `node --test` with Node's TypeScript stripping | no test framework dependency; covers every Electron-free module |

```
Electron app
├── Main process (src/main)
│   ├── AppContext (ipc.ts): settings, DeviceRegistry, sessions
│   ├── devices: UsbWatcher · NetworkDiscovery · probeHost
│   ├── remoting: runPowerShell · WinRM executor · SshSession · runSession
│   └── vault: writeSessionToVault
├── Preload (src/preload): window.arh = typed IPC bridge
└── Renderer (src/renderer): store.ts + DeviceList · DevicePanel · OutputConsole · SummaryCard
```

## 5. Known limits and next steps

- The repository build was verified with `node --test` and `tsc` on the Electron-free modules.
  The Electron/Vue bundle itself must be built on a machine with npm registry access; the
  CI workflow (`.github/workflows/ci.yml`, windows-latest) runs install, typecheck, tests and build.
- WinRM to a workgroup host by IP needs TrustedHosts on the technician PC (README).
- Outlook rules over WinRM will report "unavailable" (COM needs an interactive session); for
  Microsoft 365 use `Get-InboxRule` from an admin host — a candidate for a host-side command set.
- No scheduling or multi-device batch runs yet; sessions are one device at a time.
- The ChristFields visual language was not available in this repository; colours and fonts are
  isolated as CSS theme tokens so they can be swapped without touching components.
