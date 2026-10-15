# Vault schema: what the inspection found and what the dashboard proposes to write

> **Status: proposal, waiting for your approval. Nothing has been written to the vault.**
> Source: `scripts/Inspect-Vault.ps1` report generated 2026-10-15 09:01 (read-only).
> The app keeps every write a dry run until **Vault schema approved** and then **Live writes**
> are ticked in Settings, in that order.

## 1. Evidence from the report

Numbers are copied from the report. "Inference" marks a conclusion drawn from them.

| Item                                      | Finding                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Files                                     | 93 (92 Markdown, 1 `.gs`) in Assets, Comms, Forms, Incidents, Projects, Reference, Runbooks, Tickets and the root                                                        |
| OneDrive                                  | 0 conflict copies, 0 cloud-only files. Every file is flagged as a reparse point. Inference: OneDrive Files On-Demand placeholders, all downloaded                        |
| `.obsidian` inside `ARH IT`               | none. Inference: the vault root is a parent folder (probably `Obsidian Vault`), so plugin settings were not read                                                         |
| Tasks                                     | 652 open `- [ ]`, 57 done `- [x]`, 0 other statuses, 0 numbered                                                                                                          |
| Due dates                                 | 0 `📅`, 0 `⏳`, 0 `🛫`, 0 `[due::]`, 0 `(due::)`, 0 `due:`, 0 `@date`                                                                                                    |
| Done dates                                | 16 lines with `✅ YYYY-MM-DD`                                                                                                                                            |
| Tasks plugin priority                     | the 366 in the report is **invalid**: the script's character class matched any emoji sharing a UTF-16 surrogate half (🔴, 📅, 🚨 …). Fixed; re-run to get the real count |
| Dates                                     | 680 ISO `YYYY-MM-DD`, 15 US `M/D/YYYY`                                                                                                                                   |
| Times                                     | labelled `MT` (Work Log `### 08:14 MT — …`, Change Log column `Timestamp (MT)`)                                                                                          |
| Line endings                              | LF everywhere except `ARH IT Hub.md` (CRLF). No BOMs                                                                                                                     |
| Dashboard markers, dataview/tasks queries | 0 and 0                                                                                                                                                                  |

### The notes the dashboard would touch

| Note                        | Shape found                                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARH Open Loops.md`         | frontmatter `tags`, `updated`. Sections by level: `## 🔴 Now — live incident`, `## 🟠 This week`, `## 🟡 …`, `## ⚪ Waiting on …`, `## 🧊 Later`, plus topic sections. Tasks look like `- [ ] **Title.** detail → [[link]]`, sometimes led by `🔴`. No due dates |
| `ARH Work Log.md`           | frontmatter `tags`, `updated`. Newest day first: `## 2026-10-13 (Tuesday)`, then `### HH:MM MT — Title` or `### ~(time approx) — Title`                                                                                                                          |
| `Assets/Asset Inventory.md` | `## Computers` table `Name, Location, Room / role, Model, Serial, MAC, IP, OS, Age, Warranty, PHI?, Notes`. Frontmatter status says computers are not captured yet                                                                                               |
| `ARH IT Hub.md`             | no frontmatter, CRLF. Sections include `## 🚨 Read this first — vault safety rule for ARH`, `## Live work`, `## Standing rules`. The report lists headings only, so the rule text is not known here                                                              |

Not touched in version 1: `ARH Change Log`, `ARH Decision Log`, `Tickets/*` and `Ticket Index`
(ticketing is out of scope), `Reference/*`, `Runbooks/*`, everything else.

## 2. Proposed mapping

Every write goes between a pair of marker comments that the dashboard owns. Text outside the
markers is never changed, frontmatter included (`updated:` stays as you set it). If a note has
no markers, the pair is appended once at the end of the note. No note is ever created.

| Data               | Note                        | Marker key      | Content                                                           | Update rule                                                                                                   |
| ------------------ | --------------------------- | --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Computers          | `Assets/Asset Inventory.md` | `DEVICES`       | the `## Computers` columns plus `Last scan` and `Health`          | rows matched by serial, then name. Scan columns refresh. **Your columns are kept as you type them**           |
| Findings to act on | `ARH Open Loops.md`         | `HEALTH-LOOPS`  | one task per warning or critical finding, in the note's own style | a line is never edited once written. Ticked lines stay. A ticked problem seen on a later scan gets a new line |
| Scan record        | `ARH Work Log.md`           | `SCAN-LOG`      | one entry per scan, newest first, MT                              | append-only by run id                                                                                         |
| Health at a glance | `ARH IT Hub.md` (optional)  | `DEVICE-HEALTH` | one row per computer: health, last scan, open findings            | regenerated. Leave **Hub note** empty in Settings and the hub is never touched                                |

Column ownership in the computers table:

- **Filled from scans:** Name (hostname), Model, Serial, MAC and IP (the adapter that is up and
  has a gateway, never the cable link), OS, Last scan, Health. A value a scan did not supply is
  left as it was.
- **Yours:** Location, Room / role (seeded once from the enrollment label if empty), Age,
  Warranty, PHI?, Notes. The dashboard never guesses PHI.
- Rows the dashboard does not know (typed by hand) are kept.

What goes to Open Loops: only **warning** and **critical** findings (for example antivirus off,
disk under 15% free, no Windows update in 30+ days, a failed-sign-in spike). Info items such as
"reboot pending" stay in the dashboard. Health per computer is the worst result among the latest
scan of each purpose, so a newer Slow Performance scan does not hide a critical Security Check.

Times are converted to Mountain Time (`America/Denver`, MDT or MST by date) and labelled `MT`.

### Exactly what would be written (sample scan, synthetic data)

`Assets/Asset Inventory.md`:

```markdown
<!-- DASH:DEVICES:START -->

## 🖥️ Computers — from ARH IT Dashboard scans

_Name, Model, Serial, MAC, IP, OS, Last scan and Health are filled from scans (times MT). Location, Room / role, Age, Warranty, PHI? and Notes are yours: the dashboard keeps whatever you type there._

| Name        | Location | Room / role  | Model             | Serial     | MAC | IP  | OS                                 | Age | Warranty | PHI? | Notes | Last scan                                 | Health      |
| ----------- | -------- | ------------ | ----------------- | ---------- | --- | --- | ---------------------------------- | --- | -------- | ---- | ----- | ----------------------------------------- | ----------- |
| ARH-CEN-FD1 |          | Front desk 1 | HP ProBook 450 G8 | 5CG1234XYZ |     |     | Windows 11 Pro 10.0.22631 (64-bit) |     |          |      |       | 2026-10-14 14:32 MT · Security Check · ok | 🔴 critical |

<!-- DASH:DEVICES:END -->
```

`ARH Open Loops.md`:

```markdown
<!-- DASH:HEALTH-LOOPS:START -->

## 🩺 Device health findings — ARH IT Dashboard

_Written by the ARH IT Dashboard when a scan crosses a health threshold. Tick a line when it is fixed. The dashboard never edits a line once written; if a ticked problem shows up on a later scan it adds a new line. Device details: [[Asset Inventory]]._

- [ ] 🔴 **ARH-CEN-FD1 — Defender real-time protection is off.** Antivirus · Security Check scan 2026-10-14 14:32 MT · run r_mgx81k2a_3f9c1d. ^loop-c8fe0429
- [ ] 🟠 **ARH-CEN-FD1 — No Windows update installed for 41 days (latest KB5044284).** Updates · Security Check scan 2026-10-14 14:32 MT · run r_mgx81k2a_3f9c1d. ^loop-97aab97a
<!-- DASH:HEALTH-LOOPS:END -->
```

`ARH Work Log.md`:

```markdown
<!-- DASH:SCAN-LOG:START -->

## 🖥️ Device scans — ARH IT Dashboard

_One entry per scan, newest first (MT). Written by the ARH IT Dashboard; findings that need action go to [[ARH Open Loops]]._

- 2026-10-14 14:32 MT · **ARH-CEN-FD1** · serial 5CG1234XYZ · Security Check · windows-security-check v1 · ok · 1 min 12 s · 3 findings · Lisandro · run r_mgx81k2a_3f9c1d - 🔴 Defender real-time protection is off - 🟠 No Windows update installed for 41 days (latest KB5044284)
<!-- DASH:SCAN-LOG:END -->
```

`ARH IT Hub.md` (CRLF kept):

```markdown
<!-- DASH:DEVICE-HEALTH:START -->

## 🖥️ Device health — ARH IT Dashboard

| Computer    | Health      | Last scan                                 | Open findings |
| ----------- | ----------- | ----------------------------------------- | ------------- |
| ARH-CEN-FD1 | 🔴 critical | 2026-10-14 14:32 MT · Security Check · ok | 2             |

Inventory: [[Asset Inventory]] · findings: [[ARH Open Loops]] · scan record: [[ARH Work Log]]

<!-- DASH:DEVICE-HEALTH:END -->
```

The scan record carries every field the brief asks for: time, serial, hostname, profile and
version, technician, duration and exit status (`ok`, `failed: reason` or `aborted`). The
`^loop-…` id at the end of each task is an Obsidian block id: hidden in reading view, it lets
the dashboard recognise its own lines.

### Where the blocks land

By default each marker pair is appended at the end of its note, and each block starts with its
own `##` heading so it reads as a separate section. To put a block somewhere else, paste the two
empty marker lines there **before the first live write**; the writer fills them in place:

| Note            | Suggested spot                                       | Lines to paste                                                            |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Asset Inventory | just above `## Network equipment`                    | `<!-- DASH:DEVICES:START -->` and `<!-- DASH:DEVICES:END -->`             |
| Work Log        | just below `# ARH Work Log`, so scans sit on top     | `<!-- DASH:SCAN-LOG:START -->` and `<!-- DASH:SCAN-LOG:END -->`           |
| Open Loops      | end of the note (default) or below `## 🟠 This week` | `<!-- DASH:HEALTH-LOOPS:START -->` and `<!-- DASH:HEALTH-LOOPS:END -->`   |
| Hub             | under `## Live work`                                 | `<!-- DASH:DEVICE-HEALTH:START -->` and `<!-- DASH:DEVICE-HEALTH:END -->` |

## 3. Questions to settle with the approval

1. **Hub safety rule.** Does `## 🚨 Read this first — vault safety rule for ARH` or
   `## Standing rules` limit tool-written content in the hub? If yes or unsure, leave **Hub note**
   empty in Settings; nothing else depends on the hub block.
2. **Account names in findings.** A few per-user findings name the Windows account they concern
   (for example "Office is configured to enable all macros for jdoe", or an Outlook data file
   name, which is usually the mailbox address). No patient data, documents or mail content is
   collected. Does `## 🔴 What never goes in the vault` in the IT Note-Taking Standard allow
   staff account names? If not, they can be replaced with "a user profile" in vault text only.
3. **Plugins.** Only matters if you want due dates on generated tasks (default: none, matching
   the vault). Re-run the updated `Inspect-Vault.ps1`: it now walks up to the parent folder's
   `.obsidian` and reports the Tasks plugin and its global filter.

## 4. How to approve

1. Settings: check the four note names (defaults: `Assets/Asset Inventory.md`,
   `ARH Open Loops.md`, `ARH Work Log.md`, `ARH IT Hub.md` or empty), your technician name.
2. Optional: paste marker pairs where you want the blocks (table above).
3. **Preview vault write** and read each diff. Every line should start with `+`.
4. Tick **Vault schema approved**, then **Live writes**, then **Apply**.

## 5. Safety rules the writer enforces (tested)

- Never creates, renames or deletes a file in the vault.
- Dry run is the default; the preview is the exact unified diff per note.
- Live writes require "schema approved" first (enforced in the settings loader, not only in the UI).
- Before the first live write to a note, a copy goes to `%APPDATA%\ARH IT Dashboard\vault-backups`.
- Writes are atomic: temp file in `%APPDATA%\ARH IT Dashboard\vault-tmp`, then replace, with retries
  while OneDrive or antivirus holds the file.
- The note is read again just before the replace. If Obsidian or OneDrive changed it in between,
  nothing is written and the result says so, so an edit you just made is never overwritten.
- Malformed markers (duplicated, unbalanced, reversed) stop the write instead of guessing.
- After each write the note's folder is checked for OneDrive conflict copies, which are reported.
- Line endings are preserved per note (the hub stays CRLF).

Tests run against a synthetic copy of these note shapes in a temp folder
(`tests/fixtures/vault/ARH IT`), never the live vault. To run them against a sanitised copy of
the real vault: `$env:ARH_VAULT_FIXTURE = 'D:\copy-of-ARH-IT'; npm test`.
