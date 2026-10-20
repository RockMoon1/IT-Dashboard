# Phase 3: read, write and execute on devices, with control in Settings

Status: design v2, 2026-10-20. Requested by Lisandro: "read, write, execute in full access but in
settings can be changed or custom on what exactly they want for better control."

v2 folds in an adversarial critique of v1 (security, operations, mechanics). The main changes:
each action is split into a read-only **measure** script and an **apply** script, so a preview
cannot change anything; results come from a file the agent owns, never from stdout; status is
worked out from measured before and after values; a started change finishes even if the cable is
pulled; changes run only over the cable, never over the clinic LAN; custom commands are off on a
device until enabled on that device.

## Kinds of work

| Kind        | Meaning                                           | Default                                   |
| ----------- | ------------------------------------------------- | ----------------------------------------- |
| **read**    | scans, unchanged                                  | on                                        |
| **write**   | changes a setting; old value measured and kept    | on                                        |
| **execute** | runs a task (update signatures, resync, restart)  | on                                        |
| **custom**  | a command the technician types (PowerShell or sh) | dashboard on, **device off** (see rule 2) |

Settings turns any kind, or any single action, off. A device can refuse more on its own.

## Rules

1. **Named actions are compiled into the agent** (`actions/<os>-<name>.json`, schema
   `arh-action/1`, embedded with `go:embed`, validated at load). The dashboard names an action,
   its version and the SHA-256 of its file; the agent refuses a mismatch. The dashboard shows the
   script text only from a copy whose hash matches what the device reported in `hello`.
2. **The device decides.** `policy.json` in the agent's data folder (SYSTEM/root only):
   `{write, execute, custom, lan, interrupts, deny: [names]}`. It is re-read on every request and
   on every ping (a change is sent to the dashboard as a `policy` message). Missing, unreadable or
   invalid file, or on macOS/Linux a file not owned by root or writable by others: **read only**,
   reported as `policy.error`. `arh-agent install --policy actions|full|read` writes it only when
   it is absent (reinstalling never erases a local veto): `actions` = named write and execute,
   `full` = also custom commands, `read` = scans only. The dashboard's install line uses the
   Settings choice (default `actions`). `arh-agent policy --allow custom` / `--deny write` /
   `--deny-action windows-restart` / `--role clinical` (no `interrupts` actions, no custom) change it
   on the device; no message from the dashboard can. A custom command needs custom, write and
   execute all allowed. Previews need only read. A device with custom on runs anything the
   dashboard key holder types as SYSTEM, so it can no longer trust its own policy file: the design
   says so in Settings and in the confirm dialog.
3. **Changes only over the cable.** `action` and `exec` are accepted only when the TCP peer is
   link-local (169.254.0.0/16, fe80::/10) and the local end of the connection is not on the
   interface that carries the default route. Any other session is read only (`lan: true` in
   policy allows it). `hello` reports `link: "cable" | "lan"`; the dashboard greys out changes on a
   LAN session. A stolen dashboard key therefore still needs someone at the machine with a cable.
4. **Measure, apply, measure.** Requests carry a required `mode: "preview" | "apply"`; a missing
   or unknown mode is refused, so no default can turn into a real change. Each action has
   `measure` (reads state, reports compared items, context info, a plan, blockers, warnings, and
   the parameters that would restore today's state) and `apply` (makes the change).
   **Preview runs only `measure`**: the apply script is never started, whatever a script does with
   flags. A real run measures again first; if the plan says nothing to do, or a blocker exists
   (Group Policy, Tamper Protection, another antivirus), apply is skipped and the result says why.
   After apply the agent waits `settleSeconds` and measures again. Before and after are those two
   measurements, item by item (e.g. one per firewall profile).
5. **Results never come from stdout.** The agent passes `ARH_RESULT_FILE`, a fresh file in its own
   data folder (exclusive create, random name). Scripts write tab-separated lines through the
   prelude helpers (`item`, `info`, `plan`, `blocker`, `warn`, `restore`, `note`, and in apply
   `change` for evidence a task leaves, e.g. sfc's CBS.log repair lines). The agent parses them strictly
   (known kinds, ≤ 64 items, ≤ 240 characters per value, control characters removed) and sends them
   in `run-end.result`. Output is still streamed for the technician to read. Custom commands get no
   result file: their effect is "not measured".
6. **Status is worked out from the measurements** (shared code, tested): preview _would change_ /
   _nothing to change_ / _blocked_; real _changed_, _already set_, _not applied_ (apply ran, the
   measured value did not move, or a blocker), _partly applied_, _failed_, _outcome unknown_ (link
   lost before the result arrived), _not verified_ (a result arrived but cannot confirm the change:
   measuring afterwards failed, was blocked or missed an item measured before, or the agent was
   stopped mid-run), _done_ (execute tasks), _not measured_ (custom). Only items measured both
   before and after can show a change. Every result is checked field by field when it arrives
   (types, sizes); anything else is dropped before the status or the vault reads it.
7. **A started change finishes.** Once apply starts, the action is no longer tied to the session:
   pulling the cable does not stop it. Abort works during measure, and during apply only for
   actions marked `abortable`; abort names the run id and is ignored for any other run. After an
   abort or timeout during apply the agent still measures (30 s limit) and reports what it found. Every result goes to the agent's outbox (`outbox.json`) and is sent
   again after the next `hello` until the dashboard acknowledges it; the dashboard records
   _outcome unknown, waiting for the device_ in the meantime, never _failed_. The dashboard
   acknowledges a result only once it is on its own disk, so a crash or a full disk never loses
   one, and a result it has no request on record for is kept as such rather than dropped. A run
   the agent itself was stopped in the middle of is reported by its next start as interrupted
   (_not verified_ if the change had started). On Windows each run
   is in a Job Object, so timeout and abort stop the whole process tree.
8. **No repeats.** The agent keeps the last 500 run ids on disk and refuses a repeated one (it
   re-sends the stored result instead). Refusals carry an `errorCode`: `busy`, `policy-denied`,
   `lan-session`, `unknown-action`, `version-mismatch`, `bad-param`, `bad-mode`, `duplicate-run`,
   `restart-pending`, `not-abortable`, `internal`. The dashboard fails a request whose `run-start`
   has not arrived in 15 s. The dashboard never retries a change by itself and
   disables Run until `run-start` arrives.
9. **Parameters never touch script text.** They are declared in the action file (pattern compiled
   as `^(?:…)$`, length limit, optional fixed choices, sample good and bad values that both the Go
   and the TypeScript tests check), travel as `ARH_PARAM_<NAME>` environment variables built only
   from the declared names (every declared name is set, empty when not sent), and are refused if
   they contain NUL, CR, LF or start with `-`. Inherited `ARH_*` variables and `PSModulePath` are
   cleared. Native programs are called through `Invoke-ArhNative` (PowerShell) with their exit
   code checked; apply runs with `$ErrorActionPreference = 'Stop'`. `actions/versions.lock` holds
   name@version → SHA-256, and a test fails if a released version's file changes without a bump. A Go test over every action refuses
   `Invoke-Expression`, `iex`, `ScriptBlock`, `Start-Process`, `cmd /c`, `sh -c`, `bash -c`,
   `eval` and unquoted `$ARH_PARAM_` in sh. Actions run with a fixed `PATH` and working folder.
10. **Confirm before changing** (Settings: on). The dialog leads with the preview's plain plan
    and before values, shows blockers, the impact (`quiet`, `slows`, `interrupts`), whether it can
    be undone and how, and asks **why** (goes to the Change Log). The Change Log checklist is
    pre-answered from measurements where possible (current state = the preview; backup = the
    restore values captured; could this interrupt patient care = impact plus whether someone is
    signed in). Script text is behind "Show script". Confirmation for `interrupts` actions cannot
    be switched off, and a restart while someone is signed in and the screen is not locked asks
    for the computer name to be typed.
11. **Main enforces the switches.** Settings gates are checked in the main process, not only in
    the page. A run needs a single-use ticket from a preview of the same request (same action,
    version, hash, parameters), valid 10 minutes, unless "preview first" is off.
12. **Records, accurately.**
    - Agent: `actions.log` (JSON lines: intent before the process starts, with technician and
      reason; outcome after; never output) in its data folder, rotated at 5 × 5 MiB, and the OS
      log (Windows Application log, syslog elsewhere).
    - Dashboard: `actions.jsonl` in app data, hash-chained (each entry carries the SHA-256 of
      the one before), never capped. Custom script text is kept here only; custom output is not
      saved unless Settings says so.
    - Vault, **ARH Change Log**: one row per real run of a write action that changed something
      or partly did, a task that left evidence of a change (sfc repairs), every custom command,
      and every change whose outcome is not known yet (followed by a "Result of run …" row when
      the device reports). Columns are the note's own (Timestamp (MT), System / machine, What
      changed, Why, Reversible?, Rollback, By). Timestamp is when apply started, by the
      dashboard clock. Machine is `label · hostname · serial`. What changed is per item,
      `before → after`. Rollback is a readable copy (`Undo in the dashboard: …` or `Manual: …`);
      it is never parsed back. By is `<technician> · run <id>`. Custom rows say "Custom command (effect not measured)" with the script's hash, line count
      and exit code: the vault never holds script text or output. The block is created only with the first change.
    - Vault, **ARH Work Log**: actions join scans in the same block, newest first, with status
      and before → after. Previews and refused requests never reach the vault.
    - Every string that came from a device passes one `vaultText()` cleaner (line breaks of every
      kind, control characters, Markdown, HTML and Obsidian syntax escaped, length capped).
    - Real runs need the technician name in Settings.

13. **Undo is a named action.** `restore` values from the before-measurement become the
    parameters of the action's declared `undo` action. Undo is offered only from the dashboard's
    own log, through the same preview and confirm, never from vault text.
14. **One job per device.** Scans and actions share the agent's run slot, and one slot object in
    the dashboard. Actions marked `concurrent` (cancel restart) may run while it is busy. After a
    restart is scheduled the agent refuses other changes until it happens or is cancelled, and
    reports `pendingRestartUntil` in `hello`.
15. **Findings link to fixes, carefully.** A Fix button appears on a finding that an action's
    `fixes` pattern matches; it opens the dialog with the reason prefilled and runs the preview at
    once. Fix is enabled only when the preview says _would change_ with no blocker. After a real
    run the dashboard re-runs the scan profile that raised the finding and shows whether it is
    gone.

## Protocol additions (protocol 2; agents and dashboards at 1 keep working read-only)

- `hello` gains `protocol: 2`, `link`, `bootTime`, `actions: [{name, version, sha256}]`,
  `policy: {write, execute, custom, lan, interrupts, deny, error}`, `running` (run id) and
  `pendingRestartUntil`. After `welcome` the agent sends each result still in its outbox as a
  `result` message. A `hello` without `policy` means read only.
- host → agent `action`: `{runId, action, version, sha256, params, mode, technician, reason}`.
- host → agent `exec`: `{runId, shell, script, timeoutSeconds, technician, reason}`; script ≤ 64
  KiB, timeout ≤ 3600 s, the whole line under the 256 KiB message limit. On Windows the script goes
  through standard input to a fixed bootstrap; on macOS/Linux through file descriptor 3 with
  standard input empty, so a command that reads input cannot swallow the rest of the script.
  Never a temp file, never the command line.
- host → agent `abort`: `{runId}`.
- host → agent `ack`: `{runId}` removes a result from the outbox.
- Replies reuse `run-start` (echoing what will run: action, version, sha256, mode, the checked
  parameters, timeout), `check-start`, `check-output`, `check-end` (`measure`, `apply`,
  `measure-after`, or `exec`) and `run-end`, which gains `result` and `errorCode`.
- Golden NDJSON fixtures (`tests/fixtures/protocol/`) are decoded and re-encoded by both the Go
  and the TypeScript tests so the two sides cannot drift.

## Settings

```
Access and control
  Vault:   [x] read notes   [x] write the dashboard's sections   [x] write after every scan/action
  Devices: [x] read (scans) [x] write settings  [x] run tasks  [x] custom commands
  [x] ask before every change (always on for actions that interrupt)   [x] preview first
  Actions: one switch per action, grouped by category, with impact and what it does
  Per device: normal / no interrupting actions / read only
```

## First action set

Windows: update Defender signatures; Defender quick scan; Defender real-time protection on;
Defender PUA blocking on; firewall: turn on profiles that are off; resync the clock; set the time
zone; flush DNS; clear the system (WinHTTP) proxy; wake timers to "important only"; check for
Windows updates (search only, installs nothing); start an automatic service that is stopped;
restart with warning (delay 2 to 60 minutes, default 10); cancel the restart the dashboard
scheduled; system file check (sfc /scannow, results from CBS.log).
macOS: flush DNS, list updates, application firewall on, resync clock, restart with warning,
cancel restart. Linux: flush DNS (where systemd-resolved runs), resync clock, start an enabled
service, restart with warning, cancel restart.

## Not in this phase (and why)

- Deleting files, installing or removing software, accounts and passwords, anything touching user
  documents, email or patient data.
- A hardware-backed approval key on the dashboard PC (TPM, Windows Hello) that the agent pins and
  checks on each change. It would stop a thief who has both the dashboard key and the cable;
  rule 3 already requires the cable. Recorded as the next security step.
- Clinic hours per site in Settings (an interrupting action during hours needs a reason).
- Signed receipts from the device for each run.
