package link

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/RockMoon1/IT-Dashboard/actions"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/executor"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/policy"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/protocol"
	"github.com/RockMoon1/IT-Dashboard/profiles"
)

const (
	maxScript         = 64 * 1024
	defaultExecTime   = 300
	maxTechnician     = 100
	maxReason         = 500
	afterAbortMeasure = 30 * time.Second
	restartGrace      = 10 * time.Minute
)

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// send writes to whichever session is connected now. Actions outlive the session that started
// them, so their output and result go to the current session, or nowhere (the outbox keeps the
// result) while none is connected.
func (a *Agent) send(m protocol.Message) {
	a.sessMu.Lock()
	c := a.codec
	a.sessMu.Unlock()
	if c != nil {
		_ = c.Write(m)
	}
}

func (a *Agent) attach(c *protocol.Codec) {
	a.sessMu.Lock()
	a.codec = c
	a.sessMu.Unlock()
}

func (a *Agent) detach(c *protocol.Codec) {
	a.sessMu.Lock()
	if a.codec == c {
		a.codec = nil
	}
	a.sessMu.Unlock()
}

func refuse(codec *protocol.Codec, runID, code, why string) {
	_ = codec.Write(protocol.Message{Type: "run-end", RunID: runID, OK: protocol.BoolPtr(false), ErrorCode: code, Error: why})
}

// lookupAction distinguishes an unknown action from one whose version or file differs.
func (a *Agent) lookupAction(name string, version int, sha string) (actions.Action, string, error) {
	for _, act := range a.catalog(a.cfg.OS) {
		if act.Name != name {
			continue
		}
		if act.Version != version {
			return actions.Action{}, protocol.CodeVersion, fmt.Errorf("action %s is version %d on this agent, the dashboard asked for %d", name, act.Version, version)
		}
		if !strings.EqualFold(act.SHA256(), sha) {
			return actions.Action{}, protocol.CodeVersion, fmt.Errorf("action %s v%d on this agent differs from the dashboard's copy (agent %.12s, dashboard %.12s); update the agent or the dashboard", name, version, act.SHA256(), sha)
		}
		return act, "", nil
	}
	return actions.Action{}, protocol.CodeUnknownAction, fmt.Errorf("this agent has no action %q for %s", name, a.cfg.OS)
}

func (a *Agent) restartPending() (time.Time, bool) {
	a.runMu.Lock()
	defer a.runMu.Unlock()
	if a.restartAt.IsZero() || time.Now().After(a.restartAt.Add(restartGrace)) {
		return time.Time{}, false
	}
	return a.restartAt, true
}

func checkWho(m protocol.Message) error {
	if len(m.Technician) > maxTechnician || len(m.Reason) > maxReason {
		return fmt.Errorf("technician is limited to %d characters and reason to %d", maxTechnician, maxReason)
	}
	if m.RunID == "" || len(m.RunID) > 100 || strings.ContainsAny(m.RunID, "\x00\r\n") {
		return fmt.Errorf("a run id of 1 to 100 characters is required")
	}
	return nil
}

// takeSlot claims the single run slot for an action or custom command. The agent stopping does
// not cancel a custom command that has started: drain gives it time to finish and ends it after
// that; abort still stops it at once. One that arrives once the agent is stopping never starts.
func (a *Agent) takeSlot(runID, kind string) (context.Context, func(), string) {
	a.runMu.Lock()
	defer a.runMu.Unlock()
	if a.runCancel != nil {
		return nil, nil, a.runID
	}
	parent := a.root()
	if kind == "exec" && parent.Err() == nil {
		parent = context.WithoutCancel(parent)
	}
	ctx, cancel := context.WithCancel(parent)
	a.runCancel, a.runID, a.runKind, a.runPhase, a.runAbortable = cancel, runID, kind, actions.PhaseMeasure, true
	return ctx, func() {
		cancel()
		a.runMu.Lock()
		a.runCancel, a.runID, a.runKind, a.runPhase, a.runAbortable = nil, "", "", "", false
		a.runMu.Unlock()
	}, ""
}

// enterPhase moves the run holding the slot to the next phase. A concurrent action is not the
// slot holder and changes nothing here. The check and the switch happen under runMu, the lock
// abort and sessionEnded cancel under, so a stop that arrives before apply is never lost: it
// reports false and the change is not started.
func (a *Agent) enterPhase(ctx context.Context, runID, phase string, abortable bool) bool {
	a.runMu.Lock()
	defer a.runMu.Unlock()
	if phase == actions.PhaseApply && ctx.Err() != nil {
		return false
	}
	if a.runID == runID {
		a.runPhase, a.runAbortable = phase, abortable
	}
	return true
}

func (a *Agent) startAction(codec *protocol.Codec, link string, m protocol.Message) {
	if err := checkWho(m); err != nil {
		refuse(codec, m.RunID, protocol.CodeBadParam, err.Error())
		return
	}
	if m.Mode != "preview" && m.Mode != "apply" {
		refuse(codec, m.RunID, protocol.CodeBadMode, `mode must be "preview" or "apply"`)
		return
	}
	act, code, err := a.lookupAction(m.Action, m.Version, m.SHA256)
	if err != nil {
		refuse(codec, m.RunID, code, err.Error())
		return
	}
	if err := act.CheckParams(m.Params); err != nil {
		refuse(codec, m.RunID, protocol.CodeBadParam, err.Error())
		return
	}
	if m.Mode == "apply" {
		pol := policy.Load(a.cfg.DataDir)
		if code, why := pol.AllowAction(act.Name, act.Access, act.Impact, link == "cable"); code != "" {
			refuse(codec, m.RunID, code, why)
			return
		}
		if at, pending := a.restartPending(); pending && !act.Concurrent {
			refuse(codec, m.RunID, protocol.CodeRestartPending, "a restart is scheduled for "+at.UTC().Format(time.RFC3339)+"; cancel it first or wait for it")
			return
		}
	}
	if ok, err := a.journal.claim(m.RunID); err != nil {
		refuse(codec, m.RunID, protocol.CodeInternal, "cannot record the run id: "+err.Error())
		return
	} else if !ok {
		if r, found := a.journal.find(m.RunID); found {
			_ = codec.Write(protocol.Message{Type: "result", RunID: m.RunID, Result: &r})
		}
		refuse(codec, m.RunID, protocol.CodeDuplicateRun, "this run id was already used; nothing was run again")
		return
	}
	params := map[string]string{}
	for _, p := range act.Params {
		v := m.Params[p.Name]
		if v == "" {
			v = p.Default
		}
		params[p.Name] = v
	}
	if act.Concurrent {
		a.flight.Add(1)
		go func() {
			defer a.flight.Done()
			a.runAction(context.WithoutCancel(a.root()), act, params, m, link)
		}()
		return
	}
	ctx, release, holder := a.takeSlot(m.RunID, "action")
	if ctx == nil {
		refuse(codec, m.RunID, protocol.CodeBusy, "busy: run "+holder+" is in progress")
		return
	}
	a.flight.Add(1)
	go func() {
		defer a.flight.Done()
		defer release()
		a.runAction(ctx, act, params, m, link)
	}()
}

// runAction is measure, then (for a real run with something to do and nothing blocking) apply,
// a pause to let the setting take effect, and measure again.
func (a *Agent) runAction(ctx context.Context, act actions.Action, params map[string]string, m protocol.Message, link string) {
	started := time.Now()
	preview := m.Mode == "preview"
	res := actions.Result{RunID: m.RunID, Kind: "action", Action: act.Name, Version: act.Version, SHA256: act.SHA256(), Access: act.Access,
		Params: params, DryRun: preview, StartedAt: now()}
	checks := 3
	if preview {
		checks = 1
	}
	a.send(protocol.Message{Type: "run-start", RunID: m.RunID, Action: act.Name, Version: act.Version, SHA256: act.SHA256(), Mode: m.Mode,
		Params: params, TimeoutSeconds: act.TimeoutSeconds, Checks: checks, Title: act.Title, Link: link})
	_ = a.audit.Record("intent", map[string]any{"runId": m.RunID, "kind": "action", "action": act.Name, "version": act.Version, "sha256": act.SHA256(),
		"params": params, "mode": m.Mode, "technician": m.Technician, "reason": m.Reason, "link": link})
	a.cfg.Logger.Printf("run %s: action %s v%d (%s)", m.RunID, act.Name, act.Version, m.Mode)
	if err := a.journal.running(res); err != nil {
		a.cfg.Logger.Printf("run %s: cannot note the run as started: %v", m.RunID, err)
	}

	before := a.phase(ctx, act, params, actions.PhaseMeasure, m.RunID, actions.MeasureTimeout)
	res.Before = &before
	switch {
	case ctx.Err() != nil:
		res.Aborted = true
		res.Skipped = "stopped before any change"
	case preview:
	case before.ExitCode != 0 || before.TimedOut:
		res.Skipped = "the measurement failed, so nothing was changed"
	case len(before.Blockers) > 0:
		res.Skipped = "blocked: " + before.Blockers[0]
	case before.Change == nil:
		res.Skipped = "the measurement gave no plan, so nothing was changed"
	case !*before.Change:
		res.Skipped = "nothing to change: " + before.Plan
		if !preview && strings.HasSuffix(act.Name, "-restart-cancel") {
			a.setRestart(time.Time{}) // measured: no restart is waiting, whatever was scheduled
		}
	case !a.enterPhase(ctx, m.RunID, actions.PhaseApply, act.Abortable):
		res.Aborted = true
		res.Skipped = "stopped before any change"
	default:
		applyCtx := ctx
		if !act.Abortable {
			applyCtx = context.WithoutCancel(ctx) // a started change finishes
		}
		res.Applied, res.AppliedAt = true, now()
		if err := a.journal.running(res); err != nil {
			a.cfg.Logger.Printf("run %s: cannot note the change as started: %v", m.RunID, err)
		}
		ap := a.phase(applyCtx, act, params, actions.PhaseApply, m.RunID, time.Duration(act.TimeoutSeconds)*time.Second)
		res.Apply = &ap
		res.Aborted = applyCtx.Err() != nil
		a.noteRestart(act, params, ap)
		a.enterPhase(ctx, m.RunID, actions.PhaseAfter, false)
		limit := actions.MeasureTimeout
		if res.Aborted || ap.TimedOut {
			limit = afterAbortMeasure
		} else if act.SettleSeconds > 0 {
			time.Sleep(time.Duration(act.SettleSeconds) * time.Second)
		}
		after := a.phase(context.WithoutCancel(ctx), act, params, actions.PhaseAfter, m.RunID, limit)
		res.After = &after
	}
	res.EndedAt = now()
	if err := a.journal.put(res); err != nil {
		a.cfg.Logger.Printf("run %s: cannot keep the result in the outbox: %v", m.RunID, err)
	}
	outcome := map[string]any{"runId": m.RunID, "kind": "action", "action": act.Name, "mode": m.Mode, "applied": res.Applied,
		"skipped": res.Skipped, "aborted": res.Aborted, "before": before.Items}
	if res.Apply != nil {
		outcome["exitCode"] = res.Apply.ExitCode
		outcome["changes"] = res.Apply.Changes
	}
	if res.After != nil {
		outcome["after"] = res.After.Items
	}
	_ = a.audit.Record("outcome", outcome)
	ok := !res.Aborted && before.ExitCode == 0 && !before.TimedOut && (res.Apply == nil || (res.Apply.ExitCode == 0 && !res.Apply.TimedOut))
	a.send(protocol.Message{Type: "run-end", RunID: m.RunID, OK: protocol.BoolPtr(ok), DurationMs: time.Since(started).Milliseconds(), Result: &res})
	a.cfg.Logger.Printf("run %s finished ok=%v applied=%v in %s", m.RunID, ok, res.Applied, time.Since(started).Round(time.Millisecond))
}

// noteRestart remembers a restart the dashboard scheduled, so no other change starts before it.
func (a *Agent) noteRestart(act actions.Action, params map[string]string, ap actions.Measurement) {
	if ap.ExitCode != 0 {
		return
	}
	switch {
	case strings.HasSuffix(act.Name, "-restart-cancel"):
		a.setRestart(time.Time{})
	case strings.HasSuffix(act.Name, "-restart"):
		if n, err := strconv.Atoi(params["minutes"]); err == nil {
			a.setRestart(time.Now().Add(time.Duration(n) * time.Minute))
		}
	}
}

// setRestart records the pending restart (zero for none) and tells the connected dashboard,
// whose gates hold every other change while one is pending.
func (a *Agent) setRestart(at time.Time) {
	a.runMu.Lock()
	a.restartAt = at
	a.runMu.Unlock()
	a.send(a.stateMessage())
}

// stateMessage reports the device state that can change during a session besides the policy.
func (a *Agent) stateMessage() protocol.Message {
	m := protocol.Message{Type: "state"}
	if at, pending := a.restartPending(); pending {
		m.PendingRestartUntil = at.UTC().Format(time.RFC3339)
	}
	return m
}

func phaseTitle(phase string) string {
	switch phase {
	case actions.PhaseApply:
		return "apply"
	case actions.PhaseAfter:
		return "measure after"
	}
	return "measure"
}

// phase runs one script of an action with a fresh result file and returns what it reported.
func (a *Agent) phase(ctx context.Context, act actions.Action, params map[string]string, phase, runID string, limit time.Duration) actions.Measurement {
	a.send(protocol.Message{Type: "check-start", RunID: runID, CheckID: phase, Title: act.Title + " · " + phaseTitle(phase), Category: act.Category})
	file, err := a.newResultFile()
	if err != nil {
		a.send(protocol.Message{Type: "check-output", RunID: runID, CheckID: phase, Stream: "stderr", Data: "cannot create the result file: " + err.Error() + "\n"})
		a.send(protocol.Message{Type: "check-end", RunID: runID, CheckID: phase, ExitCode: protocol.IntPtr(-1)})
		return actions.Measurement{ExitCode: -1}
	}
	defer os.Remove(file)
	access := "read"
	if phase == actions.PhaseApply {
		access = act.Access
	}
	check := profiles.Check{ID: phase, Title: act.Title, Category: act.Category, Shell: act.Shell, Command: []string{act.Script(phase)}, Format: "text",
		TimeoutSeconds: int(limit.Seconds()), Access: access, Env: act.Env(params, phase, file), CleanEnv: true, FixedPath: true, LongScript: true}
	res := executor.Run(ctx, check, func(stream string, chunk []byte) {
		a.send(protocol.Message{Type: "check-output", RunID: runID, CheckID: phase, Stream: stream, Data: string(chunk)})
	})
	if res.Err != nil {
		a.send(protocol.Message{Type: "check-output", RunID: runID, CheckID: phase, Stream: "stderr", Data: res.Err.Error() + "\n"})
	}
	a.send(protocol.Message{Type: "check-end", RunID: runID, CheckID: phase, ExitCode: protocol.IntPtr(res.ExitCode), DurationMs: res.Duration.Milliseconds(), TimedOut: res.TimedOut, Truncated: res.Truncated})
	raw := readLimited(file, actions.MaxResultFile+1)
	m := actions.Parse(raw, act.RestoreNames())
	m.ExitCode, m.TimedOut = res.ExitCode, res.TimedOut
	return m
}

// newResultFile creates an empty file with a random name in the agent's own data folder, which
// only SYSTEM/Administrators or root can write.
func (a *Agent) newResultFile() (string, error) {
	dir := filepath.Join(a.cfg.DataDir, "results")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	// a link or junction here would send SYSTEM's writes somewhere else
	if fi, err := os.Lstat(dir); err != nil || !fi.IsDir() || fi.Mode()&os.ModeType != os.ModeDir {
		return "", fmt.Errorf("%s is not a plain folder", dir)
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	p := filepath.Join(dir, hex.EncodeToString(b)+".tsv")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	return p, f.Close()
}

func readLimited(path string, n int64) []byte {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	b, _ := io.ReadAll(io.LimitReader(f, n))
	return b
}

func (a *Agent) startExec(codec *protocol.Codec, link string, m protocol.Message) {
	if err := checkWho(m); err != nil {
		refuse(codec, m.RunID, protocol.CodeBadParam, err.Error())
		return
	}
	pol := policy.Load(a.cfg.DataDir)
	if code, why := pol.AllowCustom(link == "cable"); code != "" {
		refuse(codec, m.RunID, code, why)
		return
	}
	want := "sh"
	if a.cfg.OS == "windows" {
		want = "powershell"
	}
	timeout := m.TimeoutSeconds
	if timeout == 0 {
		timeout = defaultExecTime
	}
	switch {
	case m.Shell != want:
		refuse(codec, m.RunID, protocol.CodeBadParam, "this device runs "+want+" commands, not "+m.Shell)
		return
	case strings.TrimSpace(m.Script) == "" || len(m.Script) > maxScript:
		refuse(codec, m.RunID, protocol.CodeBadParam, fmt.Sprintf("the command must be 1 to %d bytes", maxScript))
		return
	case timeout < 1 || timeout > int(actions.MaxTimeout.Seconds()):
		refuse(codec, m.RunID, protocol.CodeBadParam, "timeout must be 1 to 3600 seconds")
		return
	}
	if at, pending := a.restartPending(); pending {
		refuse(codec, m.RunID, protocol.CodeRestartPending, "a restart is scheduled for "+at.UTC().Format(time.RFC3339)+"; cancel it first or wait for it")
		return
	}
	if ok, err := a.journal.claim(m.RunID); err != nil || !ok {
		if err == nil {
			if r, found := a.journal.find(m.RunID); found {
				_ = codec.Write(protocol.Message{Type: "result", RunID: m.RunID, Result: &r})
			}
			refuse(codec, m.RunID, protocol.CodeDuplicateRun, "this run id was already used; nothing was run again")
		} else {
			refuse(codec, m.RunID, protocol.CodeInternal, "cannot record the run id: "+err.Error())
		}
		return
	}
	ctx, release, holder := a.takeSlot(m.RunID, "exec")
	if ctx == nil {
		refuse(codec, m.RunID, protocol.CodeBusy, "busy: run "+holder+" is in progress")
		return
	}
	a.flight.Add(1)
	go func() {
		defer a.flight.Done()
		defer release()
		a.runExec(ctx, m, timeout, link)
	}()
}

// runExec runs a custom command. Nothing about its effect is measured; the record keeps the
// script's hash and line count (and, on the device only, the text), never its output.
func (a *Agent) runExec(ctx context.Context, m protocol.Message, timeout int, link string) {
	started := time.Now()
	sum := sha256.Sum256([]byte(m.Script))
	digest := hex.EncodeToString(sum[:])
	lines := strings.Count(strings.TrimRight(m.Script, "\n"), "\n") + 1
	res := actions.Result{RunID: m.RunID, Kind: "exec", SHA256: digest, Lines: lines, StartedAt: now(), Applied: true, AppliedAt: now()}
	a.send(protocol.Message{Type: "run-start", RunID: m.RunID, Shell: m.Shell, SHA256: digest, TimeoutSeconds: timeout, Checks: 1, Title: "Custom command", Mode: "apply", Link: link})
	_ = a.audit.Record("intent", map[string]any{"runId": m.RunID, "kind": "exec", "shell": m.Shell, "scriptSha256": digest, "script": m.Script,
		"technician": m.Technician, "reason": m.Reason, "link": link})
	a.cfg.Logger.Printf("run %s: custom command (%d lines, sha256 %.12s)", m.RunID, lines, digest)
	if err := a.journal.running(res); err != nil {
		a.cfg.Logger.Printf("run %s: cannot note the run as started: %v", m.RunID, err)
	}
	a.send(protocol.Message{Type: "check-start", RunID: m.RunID, CheckID: "exec", Title: "Custom command", Category: "Custom"})
	check := profiles.Check{ID: "exec", Title: "Custom command", Category: "Custom", Shell: m.Shell, Command: []string{m.Script}, Format: "text",
		TimeoutSeconds: timeout, Access: "execute", CleanEnv: true, LongScript: true}
	r := executor.Run(ctx, check, func(stream string, chunk []byte) {
		a.send(protocol.Message{Type: "check-output", RunID: m.RunID, CheckID: "exec", Stream: stream, Data: string(chunk)})
	})
	if r.Err != nil {
		a.send(protocol.Message{Type: "check-output", RunID: m.RunID, CheckID: "exec", Stream: "stderr", Data: r.Err.Error() + "\n"})
	}
	a.send(protocol.Message{Type: "check-end", RunID: m.RunID, CheckID: "exec", ExitCode: protocol.IntPtr(r.ExitCode), DurationMs: r.Duration.Milliseconds(), TimedOut: r.TimedOut, Truncated: r.Truncated})
	res.ExitCode = protocol.IntPtr(r.ExitCode)
	res.Aborted = ctx.Err() != nil
	if r.TimedOut {
		res.Error = "timed out"
	}
	res.EndedAt = now()
	if err := a.journal.put(res); err != nil {
		a.cfg.Logger.Printf("run %s: cannot keep the result in the outbox: %v", m.RunID, err)
	}
	_ = a.audit.Record("outcome", map[string]any{"runId": m.RunID, "kind": "exec", "scriptSha256": digest, "exitCode": r.ExitCode, "timedOut": r.TimedOut, "aborted": res.Aborted})
	ok := r.ExitCode == 0 && !r.TimedOut && !res.Aborted
	a.send(protocol.Message{Type: "run-end", RunID: m.RunID, OK: protocol.BoolPtr(ok), DurationMs: time.Since(started).Milliseconds(), Result: &res})
}

// abort stops the named run when that is safe: a scan, an action still measuring, an abortable
// action, or a custom command. A started change that cannot be stopped is refused, with a reason.
func (a *Agent) abort(codec *protocol.Codec, runID string) {
	a.runMu.Lock()
	if a.runCancel == nil || (runID != "" && runID != a.runID) || (runID == "" && a.runKind != "scan") {
		a.runMu.Unlock()
		return
	}
	if a.runKind == "action" && (a.runPhase == actions.PhaseAfter || (a.runPhase == actions.PhaseApply && !a.runAbortable)) {
		id := a.runID
		a.runMu.Unlock()
		_ = codec.Write(protocol.Message{Type: "abort-refused", RunID: id, ErrorCode: protocol.CodeNotAbortable,
			Error: "the change has started and this action cannot be stopped safely; it will finish and report what it did"})
		return
	}
	a.runCancel()
	a.runMu.Unlock()
}

// sessionEnded stops what should not outlive the session: scans, and actions that have not
// started changing anything. A started change and a custom command keep running.
func (a *Agent) sessionEnded() {
	a.runMu.Lock()
	defer a.runMu.Unlock()
	if a.runCancel == nil {
		return
	}
	if a.runKind == "scan" || (a.runKind == "action" && a.runPhase == actions.PhaseMeasure) {
		a.runCancel()
	}
}
