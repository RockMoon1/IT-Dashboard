# Vault schema: what the inspection found and what the dashboard proposes to write

> **Status: approved by Lisandro on 2026-10-20** ("go for it; don't change the data, the format
> is up to you, the data must be correct"). Source: `scripts/Inspect-Vault.ps1` report generated
> 2026-10-15 09:01 (read-only). The dashboard writes only its own sections between its markers;
> existing text is never changed. Every switch (approval, live writes, writing after each scan
> or action) stays in Settings and can be turned off.

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

Not touched: `ARH Decision Log`, `Tickets/*` and `Ticket Index` (ticketing is out of scope),
`Reference/*`, `Runbooks/*`, everything else. `ARH Change Log` gets the dashboard's own block
from Phase 3 on, only once a first change is made on a device (below).

## 2. Proposed mapping

Every write goes between a pair of marker comments that the dashboard owns. Text outside the
markers is never changed, frontmatter included (`updated:` stays as you set it). If a note has
no markers, the pair is appended once at the end of the note. No note is ever created.

| Data               | Note                        | Marker key      | Content                                                           | Update rule                                                                                                   |
| ------------------ | --------------------------- | --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Computers          | `Assets/Asset Inventory.md` | `DEVICES`       | the `## Computers` columns plus `Last scan` and `Health`          | rows matched by serial, then name. Scan columns refresh. **Your columns are kept as you type them**           |
| Findings to act on | `ARH Open Loops.md`         | `HEALTH-LOOPS`  | one task per warning or critical finding, in the note's own style | a line is never edited once written. Ticked lines stay. A ticked problem seen on a later scan gets a new line |
| Scan record        | `ARH Work Log.md`           | `SCAN-LOG`      | one entry per scan, action or custom command, newest first, MT    | append-only by run id                                                                                         |
| Changes on devices | `ARH Change Log.md`         | `CHANGES`       | one row per change, in the note's own columns, oldest first       | append-only by run id; created with the first change; Settings: empty **Change Log note** turns it off        |
| Health at a glance | `ARH IT Hub.md` (optional)  | `DEVICE-HEALTH` | one row per computer: health, last scan, open findings            | regenerated (block id kept). Leave **Hub note** empty in Settings and the hub is never touched                |

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

`ARH Work Log.md` (each entry's first line ends with its run id; findings are indented below):

<!-- prettier-ignore -->
```markdown
<!-- DASH:SCAN-LOG:START -->

## 🖥️ Device scans and actions — ARH IT Dashboard

_One entry per scan, action or custom command, newest first (MT). Written by the ARH IT Dashboard; findings that need action go to [[ARH Open Loops]], changes to [[ARH Change Log]]._

- 2026-10-14 14:40 MT · **ARH-CEN-FD1** · serial 5CG1234XYZ · Action: Turn on firewall profiles that are off (windows-firewall-on v1) · changed · Firewall Public: off → on · why: Fix: Firewall profile "Public" is disabled · Lisandro · run a_mgx8f0q1_0b12aa
- 2026-10-14 14:32 MT · **ARH-CEN-FD1** · serial 5CG1234XYZ · Security Check · windows-security-check v2 · ok · 1 min 12 s · 3 findings · Lisandro · run r_mgx81k2a_3f9c1d
    - 🔴 Defender real-time protection is off
    - 🟠 No Windows update installed for 41 days (latest KB5044284)
<!-- DASH:SCAN-LOG:END -->
```

`ARH Change Log.md` (the block is added only with the first change; your own table above it is
never touched):

```markdown
<!-- DASH:CHANGES:START -->

## 🔧 Device changes — ARH IT Dashboard

_One row per change the ARH IT Dashboard made on a computer, oldest first (times MT, by the dashboard's clock). What changed is measured on the device before and after; custom commands are listed but not measured. Full record: the dashboard's action log. Scans and every action are also in [[ARH Work Log]]._

| Timestamp (MT)   | System / machine                               | What changed              | Why                                        | Reversible?  | Rollback                                                                | By                               |
| ---------------- | ---------------------------------------------- | ------------------------- | ------------------------------------------ | ------------ | ----------------------------------------------------------------------- | -------------------------------- |
| 2026-10-14 14:40 | Front desk 1 · ARH-CEN-FD1 · serial 5CG1234XYZ | Firewall Public: off → on | Fix: Firewall profile "Public" is disabled | Yes, by hand | Manual: Set-NetFirewallProfile -Profile \<the profiles\> -Enabled False | Lisandro · run a_mgx8f0q1_0b12aa |

<!-- DASH:CHANGES:END -->
```

What gets a Change Log row: a real run of an action that changes a setting and changed it (or
partly did), a task that left evidence of a change (sfc repairs), every custom command (listed
as not measured, with the script's hash, never its text or output), and a change whose outcome
is not known yet because the cable was pulled, or that was applied but could not be confirmed
(`NOT VERIFIED: …` with the reason). A row written while the outcome is unknown ends
`· run <id> · result pending` and gets a second row, `Result of run …` ending `· result <id>`,
when the device reports, whatever the run ended as (changed, not applied, done, failed…). The
dashboard finds its own rows by that ending only, never by text elsewhere in a row, so a reason
or a device value that names a run cannot add or block a row. Work Log entries, scans included,
are found the same way, by the end of their first line; the block id Obsidian adds there when
a technician copies a link to an entry (` ^a1b2c3`) is allowed. The id in that ending is always
one the dashboard made: a result a device reports under any other id (one with no request on
record) is kept under an id made from the device and what it sent (`d_` and 16 hex digits). A
padded or realigned header row (table plugins) is still recognised. A link to a whole table
(Change Log, computers, hub) or list (Work Log, Open Loops) puts its block id on a line of its
own after it, a blank line between (`^chg-table`). That line stays there on every write: after
the rows (in the hub, above the `Inventory:` line), or after the list with its blank line; new
Open Loops tasks join the list above it. That holds for an id put there while the list is still
empty, and for an id on the empty list's placeholder: the one "Copy link to block" puts at the
end of its line (`_No open device findings._ ^a1b2c3`), or one typed on the line right under it
(no blank line between, so Obsidian reads it as the placeholder's). The placeholder stays as it
is until the list's first item; then it goes, and each id it carried is the list's, on its own
line after the list with a blank line before it, ahead of ids typed there. Inside the markers, a
line you type in the Work Log or Open Loops block is kept, italic or not, unless it repeats the
block's heading or one of the dashboard's own italic lines (a line in underscores that names the
ARH IT Dashboard counts as its intro); the blank lines between such lines are not kept, and a
table block keeps only its rows (the hub's are rebuilt) and block ids. Type notes outside the
markers, and put a block id on its own line right after the list or table. Previews, things already
set, and refused requests never reach the vault. Every value that came from a device is cleaned
first: no line breaks of any kind, and the characters Markdown, HTML and Obsidian give a meaning
to are escaped. Both logs list as changed only items measured before and after, so a Work Log
entry for a run that was already set, blocked or could not measure lists none. A time no date
reads (only in a record an older build kept) is written as `time unknown`.

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
| Change Log      | just below its `## Log` table                        | `<!-- DASH:CHANGES:START -->` and `<!-- DASH:CHANGES:END -->`             |

## 3. Decisions (2026-10-20)

1. **Hub:** the compact device-health block goes into the hub (`ARH IT Hub.md`).
2. **Account names:** included. Findings that name a Windows account or mailbox file keep the
   name in vault text ("everything must go in"). No patient data, documents or mail content is
   collected by scans.
3. **Due dates:** none on generated tasks, matching the vault (0 of 709 tasks carry one).
4. **When the vault is written:** after every scan or action, automatically (Settings:
   "Write to the vault after every scan or action"). The preview and **Apply** remain for a
   manual write at any time.
5. **Data accuracy:** values in the vault come only from measurements (scan output, an action's
   measured before and after), never from what was intended. Times are Mountain Time.

## 4. Turning it off again

Settings: untick **Live writes** (nothing is written), or **Write to the vault after every scan
or action** (writes happen only when you press Apply on a preview), or **Vault schema approved**
(everything back to dry run).

## 5. Safety rules the writer enforces (tested)

- Never creates, renames or deletes a file in the vault.
- The preview is the exact unified diff per note, available before any write.
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
