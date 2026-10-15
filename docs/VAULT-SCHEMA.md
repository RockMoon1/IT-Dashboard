# Vault schema: what was found and what the dashboard proposes to write

> **Status: waiting for the inspection report and your approval.** The ARH IT vault lives on
> Lisandro's PC (OneDrive). The cloud session that built this app cannot read it, so Step 0
> of the brief is delivered as a read-only script, `scripts/Inspect-Vault.ps1`. Nothing is
> written to the vault until the mapping below is approved and **Live writes** is switched on
> in Settings (the app enforces that order: live writes stay off while "schema approved" is off).

## 1. Run the inspection (read-only)

```powershell
cd $HOME\Documents\IT-Dashboard
npm run inspect-vault
# or with an explicit path / output file:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Inspect-Vault.ps1 `
  -VaultPath "$env:USERPROFILE\OneDrive\Documents\Obsidian Vault\ARH IT" `
  -OutFile "$env:TEMP\arh-vault-report.md"
```

The script refuses to write its report inside the vault. It records, per note: size, line
endings, encoding, frontmatter keys, heading outline, dated headings, up to 3 sample task lines,
table header rows, existing `DASH:` markers, dataview/tasks query blocks and callout types; and for
the whole vault: folder tree, enabled core and community plugins (including the Tasks plugin
global filter), OneDrive conflict copies and cloud-only (not downloaded) files, top tags and most
linked notes. Only short samples are included so the report is safe to paste back.

**Send the report back** (paste it into the chat or attach the file). The mapping below is then
adjusted to what the vault actually uses: heading names, the task format and due-date style the
Tasks/Dataview plugins expect, and whether a device or inventory table already exists in
`Assets/` or the hub.

## 2. What is known today (from the folder listing you provided)

| Item                                                                                 | Type    | Known role                                                  |
| ------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------- |
| `ARH IT Hub`                                                                         | note    | index / dashboard of current state                          |
| `ARH Work Log`                                                                       | note    | primary append-only record (dates, activities, resolutions) |
| `ARH Open Loops`                                                                     | note    | open items and reminders                                    |
| `ARH Change Log`                                                                     | note    | changes to systems                                          |
| `ARH Decision Log`                                                                   | note    | decisions and their reasons                                 |
| `Assets/`                                                                            | folder  | hardware/asset records (format unknown)                     |
| `Comms/`, `Forms/`, `Incidents/`, `Projects/`, `Reference/`, `Runbooks/`, `Tickets/` | folders | not touched by the dashboard                                |

Unknown until the report: frontmatter conventions, task checkbox and due-date syntax, heading
names used for dates, whether `Assets/` already holds a device table, and plugin settings.

## 3. Proposed mapping (provisional)

Every write goes between marker comments the dashboard owns. Text outside the markers is never
changed. If a note has no markers yet, the block is appended once at the end of the note. No
note is ever created.

| Data                              | Note             | Block (marker key) | Content                                                                                                | Update rule                                                          |
| --------------------------------- | ---------------- | ------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Device inventory                  | `ARH IT Hub`     | `DEVICES`          | table: device, serial, OS, agent version, last seen, last scan, health                                 | regenerated each write                                               |
| Recent scans                      | `ARH IT Hub`     | `DEVICE-SCANS`     | latest 20 scans as foldable `[!info]-` callouts with findings and a metrics table                      | regenerated each write                                               |
| Health findings → follow-ups      | `ARH Open Loops` | `HEALTH-LOOPS`     | one task per finding: `- [ ] HOST: finding (Purpose scan DATE, Category) ⏫ 📅 DUE ^loop-id`           | append-only by `^loop-id`; ticked lines are kept exactly as they are |
| Scan record                       | `ARH Work Log`   | `SCAN-LOG`         | one line per scan: date time, host (serial), purpose, profile vN, status, findings, technician, run id | append-only by run id                                                |
| Change Log, Decision Log, folders | —                | —                  | —                                                                                                      | not written in version 1                                             |

Due dates for generated tasks: critical findings next day, warnings in 7 days. The due-date
syntax is a setting: Tasks plugin emoji (`📅 2026-10-21`, default), Dataview (`[due:: …]`),
plain (`(due: …)`) or none. It will be set to whatever the report shows the vault uses.

Example of the four blocks as they would appear (from the test suite, synthetic data):

```markdown
<!-- DASH:DEVICES:START -->

| Device                | Serial     | OS      | Agent | Last seen        | Last scan                        | Health   |
| --------------------- | ---------- | ------- | ----- | ---------------- | -------------------------------- | -------- |
| Exam room 2 laptop 🟢 | SN-TEST-01 | windows | 0.2.0 | 2026-10-14 14:00 | 2026-10-14 · Security Check · ok | critical |

<!-- DASH:DEVICES:END -->

<!-- DASH:HEALTH-LOOPS:START -->

- [ ] EXAM2-LT: Microsoft Defender antivirus is disabled (Security Check scan 2026-10-14, Antivirus) ⏫ 📅 2026-10-15 ^loop-1k3x9q
- [ ] EXAM2-LT: Disk C: has 12% free (28 GB) (Security Check scan 2026-10-14, Storage) 📅 2026-10-21 ^loop-8hd2pz
<!-- DASH:HEALTH-LOOPS:END -->

<!-- DASH:SCAN-LOG:START -->

- 2026-10-14 14:05 · EXAM2-LT (SN-TEST-01) · Security Check · windows-security-check v1 · ok · 2 finding(s) · Lisandro · r_1
<!-- DASH:SCAN-LOG:END -->
```

### Open questions for the approval

1. Should the scan log live inside the `ARH Work Log` marker block (proposed: one block, so the
   writer never edits your dated sections), or should each scan go under the day's own heading?
   The second option edits text outside markers, which the brief rules out, so it is not built.
2. If `Assets/` already has a device note per machine, should the device table stay in the hub
   or move into an existing assets note?
3. Is the Tasks plugin's global filter set (e.g. `#task`)? If so, generated tasks must carry it.

## 4. Safety rules the writer enforces (tested)

- Never creates, renames or deletes a file in the vault.
- Dry-run is the default; a preview shows the exact unified diff per note.
- Live writes require "schema approved" first.
- Before the first live write to a note, a backup goes to `%APPDATA%\ARH IT Dashboard\vault-backups`.
- Writes are atomic: temp file in `%APPDATA%\ARH IT Dashboard\vault-tmp`, then replace.
- Malformed markers (duplicated, unbalanced, reversed) stop the write instead of guessing.
- After each write the note's folder is checked for OneDrive conflict copies, which are reported.
- Line endings (CRLF/LF) of each note are preserved.
