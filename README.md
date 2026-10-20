# ARH IT Dashboard

A local Windows app that works as a virtual IT workstation for Advanced Regenerative Health.
Plug a computer into the technician PC with a cable, and the dashboard detects it, identifies
it, asks the purpose of the visit, runs a read-only scan through a small agent on that
computer, streams the results on a dark-mode dashboard, and records them in the existing
**ARH IT** Obsidian notes, without ever creating a new file in the vault.

- How it works and why: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Wire protocol, enrollment and profile format: [docs/PROTOCOL.md](docs/PROTOCOL.md)
- Vault mapping (needs your approval): [docs/VAULT-SCHEMA.md](docs/VAULT-SCHEMA.md)

## What you need

| Item                              | Notes                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows 10/11 technician PC       | Admin rights once, for the firewall rule.                                                                                                                                                                                |
| A cable that makes a network link | USB-to-Ethernet adapter + Ethernet cable (works with any target), or a USB-C/Thunderbolt/USB4 host-to-host networking cable. A plain USB-A to USB-A cable does **not** work: USB cannot connect two computers by itself. |
| Admin/sudo on each target, once   | To install the agent.                                                                                                                                                                                                    |
| A spare computer or a VM          | For the first end-to-end test, before any ARH device.                                                                                                                                                                    |

## Install on the technician PC

### Option A: download the installer (no build tools)

1. Open the pull request on GitHub → **Checks** → **CI** → the latest run → **Artifacts**.
2. Download **ARH-IT-Dashboard-setup** (the installer) and **arh-agent-binaries** (agents for
   every OS). Unzip both.
3. Run the setup `.exe`. Windows SmartScreen will warn because the app is unsigned:
   **More info → Run anyway**.

### Option B: build from source

In PowerShell (close and reopen it after the two `winget` lines):

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
winget install --id GoLang.Go -e

cd $HOME\Documents
git clone https://github.com/RockMoon1/IT-Dashboard.git
cd IT-Dashboard
git checkout claude/modest-lamport-us3739   # not needed once the pull request is merged into main
npm install
npm run agent:build      # builds agent/dist/arh-agent-* for Windows, macOS and Linux
npm run dev              # starts the dashboard
```

`npm run dist:win` produces the same installer as Option A in `dist\`.

## First-time setup (in this order)

1. **Check WMI on this PC** (read-only):
   `npm run verify-wmi`, or from an installed copy
   `powershell -ExecutionPolicy Bypass -File scripts\Verify-Wmi.ps1`.
   Every required line must say `OK`.
2. **Vault mapping**: read [docs/VAULT-SCHEMA.md](docs/VAULT-SCHEMA.md) (built from the
   read-only `npm run inspect-vault` report). Until you tick **Vault schema approved** in
   Settings, every vault write stays a preview (dry run).
3. **Settings**: enter your name as the technician; check the vault path and note names.
4. **Link tab → Create firewall rule (UAC)**: one admin prompt that lets agents connect
   to TCP 47912.

## Enroll a device (once per computer)

1. Connect the device to the technician PC with the cable. Wait until the Link tab shows the
   adapter as `Up` with a `169.254.x.x` or `fe80::` address.
2. Click **Enroll device**, type a label (for example `Exam room 2 laptop`), **Generate token**.
   The token is valid for 10 minutes and works once.
3. Copy the matching agent from `arh-agent-binaries` to the device (USB stick is fine) and run,
   as administrator / with sudo:

   | Device              | Command                                                                                                                                  |
   | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
   | Windows (Intel/AMD) | `.\arh-agent-windows-amd64.exe install --token ARH-XXXXXXXX-XXXXXXXXXXXXXXXX` (in an **Administrator** PowerShell)                       |
   | Windows on ARM      | `.\arh-agent-windows-arm64.exe install --token …`                                                                                        |
   | Mac (Apple silicon) | `xattr -d com.apple.quarantine arh-agent-darwin-arm64; chmod +x arh-agent-darwin-arm64; sudo ./arh-agent-darwin-arm64 install --token …` |
   | Mac (Intel)         | same with `arh-agent-darwin-amd64`                                                                                                       |
   | Linux               | `chmod +x arh-agent-linux-amd64; sudo ./arh-agent-linux-amd64 install --token …`                                                         |

4. Within a few seconds the device appears under **Enrolled devices** with a green dot.
   `arh-agent status` on the device shows its id and the pinned dashboard.

## Look up a computer (nothing needs to be plugged in)

Press **Ctrl K** anywhere (or open the **Computers** tab) and type a name, serial, IP, MAC, room
or a person's name. A computer's page puts together everything already on record:

- **From scans** (stored on this PC): current findings, problems by how often they come back,
  trends across scans (disk free, days since an update, failed sign-ins, battery health, RAM…),
  the last known value of every measurement, and the scan list. Click a point or a row to open
  that scan.
- **From the vault** (read only): its Asset Inventory row, tickets that mention it, its lines
  in ARH Open Loops, Work Log entries, Change Log rows and any other note that names it. Click
  any of them to open the note in Obsidian.
- **History**: one timeline of scans, tickets, work log entries and changes, newest first.

Names and serials are matched as whole words. A hostname made only of letters (for example
`COMPUTER`) is matched with its exact case, so the word "computer" in a sentence does not count.
Typing a word that is not a computer, such as a person's name, shows every ticket and note that
mentions it. Clicking a device in the left list opens its page; double-click still starts a scan.

## Run a scan

Double-click a green device → choose the purpose (a suggestion comes from its last scan) →
**Run scan**. Checks stream in **Active scan**; **Results** shows them by category; **Health**
lists findings by severity. **Preview vault write** shows the exact diff for Asset Inventory,
Open Loops, the Work Log and (optionally) the hub. **Apply** is available only after the schema
is approved and live writes are on in Settings.

## Test on a virtual machine first

1. Hyper-V Manager → Virtual Switch Manager → **New → Internal** switch. Give the VM a network
   adapter on that switch.
2. In the dashboard's Link tab, tick **beacon on every adapter** (the Hyper-V vEthernet adapter
   is virtual, so it is not treated as a cable link by default).
3. Enroll the VM as above, run each purpose once, and check the dry-run previews.
4. Untick **beacon on every adapter** before using real devices.

## Uninstall the agent from a device

`arh-agent uninstall` (admin / sudo) removes the service, the firewall rule, the device key and
the data folder. Remove the device from the dashboard with ✕ in the device list.

## Development

```powershell
npm test                 # Node tests: vault writer, markers, enrollment, link server, scans, health
npm run test:go          # Go tests: protocol, executor, keystore, identity, profiles, end-to-end session
npm run typecheck
npm run format:check
$env:ARH_RUN_PROFILES = '1'; go test ./agent/internal/executor -run TestShippedProfilesRunHere -v
                         # runs every shipped check for this OS on this machine (read-only)
$env:ARH_VAULT_FIXTURE = 'D:\copy-of-ARH-IT'; npm test
                         # runs the writer tests against a COPY of the real vault in a temp folder
```

| Path                 | What it is                                                                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/`             | Go agent: `cmd/arh-agent`, `internal/{link,executor,keystore,identity,service,protocol,sysinfo}`                                                                                    |
| `profiles/`          | Versioned, read-only scan profiles (JSON) shared by agent and dashboard                                                                                                             |
| `src/main/services/` | `detection` (WMI, adapters), `devices` (USB), `link` (TLS server, beacon, tokens), `scans` (runner, health, log), `secrets` (Credential Manager), `vault` (markers, writer, reader) |
| `src/renderer/`      | Vue 3 dashboard                                                                                                                                                                     |
| `scripts/`           | `Inspect-Vault.ps1`, `Verify-Wmi.ps1`, `build-agent.mjs`                                                                                                                            |
| `tests/`             | Node tests and the synthetic vault fixture                                                                                                                                          |
