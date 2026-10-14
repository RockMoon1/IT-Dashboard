# ARH IT Dashboard

Electron + Vue 3 desktop app for the ARH IT workflow: see what is attached to the technician's
Windows PC, pick the purpose of a visit, run a known diagnostic command set on the target over
WinRM or SSH, watch the output live, and append the results to the existing notes in the
**ARH IT** Obsidian vault (`ARH IT Hub` and `ARH Work Log`). It never creates new notes.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, the Phase 1 review and the
facts that changed the plan.

## Requirements (technician PC)

- Windows 10/11 with Windows PowerShell 5.1 (built in) or PowerShell 7.
- Node.js 22.18 or newer (runs TypeScript tests without a build step).
- Access to the Obsidian vault folder (OneDrive path is the default in Settings).

## Setup

```powershell
npm install
npm run dev        # Electron with hot reload
npm test           # unit tests (node:test, no PowerShell needed)
npm run typecheck  # tsc for main/preload, vue-tsc for the renderer
npm run build      # production bundle in out/
npm run dist:win   # NSIS installer in dist/ (electron-builder)
```

## Target prerequisites

| Target  | Protocol | One-time setup on the target                                                                  |
| ------- | -------- | --------------------------------------------------------------------------------------------- |
| Windows | WinRM    | Run as admin: `Enable-PSRemoting -Force` (opens 5985; firewall rule on Private/Domain only)   |
| Windows | SSH      | Settings → Optional features → OpenSSH Server, then `Start-Service sshd`                      |
| macOS   | SSH      | System Settings → General → Sharing → Remote Login (or `sudo systemsetup -setremotelogin on`) |
| Linux   | SSH      | `sudo apt install openssh-server` (or distro equivalent)                                      |

**Workgroup Windows targets over WinRM.** When the target is not domain-joined and you connect
by IP or plain host name, Windows refuses Negotiate authentication unless the host is trusted on
the _technician's_ PC. Run once as admin on the technician PC:

```powershell
Set-Item WSMan:\localhost\Client\TrustedHosts -Value '192.168.1.*' -Concatenate -Force
```

Use HTTPS (5986) with a proper certificate if you prefer not to widen TrustedHosts.

## How a session works

1. Devices appear in the left pane: this PC, hosts added by hand, LAN neighbours from the ARP
   table, and USB peripherals (via `Get-PnpDevice`, refreshed on WMI device-change events).
2. Double-click a device → choose the purpose (System Diagnostics, Security Check, Email Setup,
   Hardware Issues, Slow Performance, Phishing Assessment, Other).
3. Probe the host (ports 22/5985/5986/3389/445 plus SSH banner) to get a protocol and OS
   proposal, enter credentials, tick the authorisation confirmation, run.
4. Output streams per command. When the run finishes the findings and metrics are appended as a
   foldable callout under `## Device Scans` in `ARH IT Hub.md` and as one dated line in
   `ARH Work Log.md`.

## Obsidian layout written by the app

`ARH IT Hub.md`

```markdown
## Device Scans

> [!info]- 2026-10-14 14:05 · LAPTOP-01 · System Diagnostics
> **Target:** 192.168.1.20 via WinRM (windows) · **Result:** OK · **Session:** 3f9a1c2b
> **Findings (1):**
>
> - Disk C: has only 8.1% free (12.3 GB)
>
> | Metric | Value                                        |
> | ------ | -------------------------------------------- |
> | OS     | Microsoft Windows 11 Pro 10.0.26100 (64-bit) |
```

`ARH Work Log.md`

```markdown
## 2026-10-14

- 14:05 · Device scan · **LAPTOP-01** · System Diagnostics via WinRM (192.168.1.20) → 1 finding(s): Disk C: has only 8.1% free · see [[ARH IT Hub#Device Scans]]
```

If a dated heading for today already exists (any heading that starts with the ISO date), the
line is appended under it; otherwise a new `## YYYY-MM-DD` heading is added at the bottom
(or at the top with the "newest first" setting).

## Security notes

- Credentials live in memory for one session; the settings file stores only paths, intervals
  and SSH host-key fingerprints.
- WinRM passwords are passed to the local PowerShell child through its environment block, not
  the command line. Scripts are base64-encoded (`-EncodedCommand`).
- SSH host keys are pinned on first use; a changed key aborts the connection. Strict mode
  (reject unknown hosts) is available in Settings.
- The renderer runs sandboxed with context isolation; it reaches the OS only through the
  `window.arh` bridge defined in `src/preload`.
- There is no consent prompt on the target: WinRM and SSH authenticate with credentials and
  run without user interaction. The dashboard records the technician's authorisation
  confirmation with every session instead.

## Project layout

```
src/main/                 Electron main process (Node)
  index.ts                window + app lifecycle
  ipc.ts                  AppContext: settings, device sources, sessions, IPC handlers
  services/devices/       usb.ts (PnP/WMI), network.ts (ARP neighbours), probe.ts, registry.ts
  services/remoting/      powershell.ts, winrm.ts, ssh.ts (ssh2), session.ts (orchestration)
  services/diagnostics/   windows.ts + posix.ts command catalogs, summary.ts findings rules
  services/vault/         obsidian.ts (append-only note writer)
src/preload/              contextBridge API (window.arh)
src/renderer/             Vue 3 + Tailwind v4 UI
src/shared/               types and IPC channel names shared by all layers
tests/                    node:test suites for every Electron-free module
```
