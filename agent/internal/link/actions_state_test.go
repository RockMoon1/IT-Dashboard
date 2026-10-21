//go:build !windows

package link

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/actions"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/protocol"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/service"
)

// shAction builds a test action with its own name, flags, parameter and scripts.
func shAction(t *testing.T, name string, concurrent bool, param string, measure, apply []string) actions.Action {
	t.Helper()
	def := map[string]any{
		"schema": actions.Schema, "name": name, "version": 1, "os": "linux", "access": "execute", "category": "Test",
		"title": name, "description": "test", "impact": "quiet", "reversible": false, "undo": "", "manualUndo": "",
		"abortable": false, "concurrent": concurrent, "fixes": []string{}, "shell": "sh", "timeoutSeconds": 20, "settleSeconds": 0,
		"params": []map[string]any{{"name": param, "label": param, "pattern": "[a-z0-9]{1,10}", "maxLength": 10, "required": false, "default": "1",
			"choices": []string{}, "examples": map[string]any{"ok": []string{"on"}, "bad": []string{"ON"}}}},
		"measure": measure,
		"apply":   apply,
	}
	raw, _ := json.Marshal(def)
	a, err := actions.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func runMsg(a actions.Action, runID string, params map[string]string) protocol.Message {
	return protocol.Message{Type: "action", RunID: runID, Action: a.Name, Version: a.Version, SHA256: a.SHA256(), Mode: "apply",
		Params: params, Technician: "Lisandro", Reason: "test"}
}

// A concurrent action (restart-cancel) runs beside the slot holder and must not change the
// holder's phase: the holder is still measuring, so it can still be stopped.
func TestConcurrentActionLeavesTheSlotHolderMeasuring(t *testing.T) {
	h := newHarness(t, true)
	slow := testAction(t, false, ":")
	slow.Measure = append([]string{"sleep 3"}, slow.Measure...)
	side := shAction(t, "linux-test-side", true, "n", []string{`arh_plan true "go"`}, []string{":"})
	h.agent.catalog = func(string) []actions.Action { return []actions.Action{slow, side} }
	h.setPolicy("actions")
	c, _, closeFn := h.connect()
	defer closeFn()
	_ = c.Write(actionMsg(slow, "holder", "apply", "on"))
	until(t, c, "check-start")
	_ = c.Write(runMsg(side, "side", nil))
	for {
		m, _ := until(t, c, "run-end")
		if m.RunID == "side" {
			break
		}
	}
	h.agent.runMu.Lock()
	phase := h.agent.runPhase
	h.agent.runMu.Unlock()
	if phase != actions.PhaseMeasure {
		t.Fatalf("holder phase %q after a concurrent action, want measure", phase)
	}
	_ = c.Write(protocol.Message{Type: "abort", RunID: "holder"})
	end, seen := until(t, c, "run-end")
	for _, m := range seen {
		if m.Type == "abort-refused" {
			t.Fatalf("abort of a measuring run was refused: %+v", m)
		}
	}
	if end.RunID != "holder" || end.Result == nil || !end.Result.Aborted || end.Result.Applied {
		t.Fatalf("holder: %+v", end.Result)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "value")); err == nil {
		t.Fatal("the stopped run changed the device")
	}
}

// A stop that lands between measure and apply is not lost: the change is not started.
func TestStopBeforeApplyIsHonoured(t *testing.T) {
	a := New(Config{DataDir: t.TempDir(), Logger: log.New(io.Discard, "", 0)})
	ctx, cancel := context.WithCancel(context.Background())
	if !a.enterPhase(ctx, "r", actions.PhaseApply, false) {
		t.Fatal("a live run was refused apply")
	}
	cancel()
	if a.enterPhase(ctx, "r", actions.PhaseApply, false) {
		t.Fatal("a stopped run was let into apply")
	}
}

// Scheduling and cancelling a restart reach the dashboard at once, and a cancel that measures
// no restart waiting clears what the agent remembered.
func TestRestartStateIsReported(t *testing.T) {
	h := newHarness(t, true)
	restart := shAction(t, "linux-test-restart", false, "minutes", []string{`arh_plan true "restart"`}, []string{":"})
	cancelNone := shAction(t, "linux-test-restart-cancel", true, "n", []string{`arh_plan false "No restart is waiting"`}, []string{":"})
	h.agent.catalog = func(string) []actions.Action { return []actions.Action{restart, cancelNone} }
	h.setPolicy("actions")
	c, _, closeFn := h.connect()
	defer closeFn()

	_ = c.Write(runMsg(restart, "r1", map[string]string{"minutes": "30"}))
	st, _ := until(t, c, "state")
	if st.PendingRestartUntil == "" {
		t.Fatalf("no pending restart reported: %+v", st)
	}
	until(t, c, "run-end")
	if _, pending := h.agent.restartPending(); !pending {
		t.Fatal("the restart was not remembered")
	}

	_ = c.Write(runMsg(cancelNone, "c1", nil))
	st, _ = until(t, c, "state")
	if st.PendingRestartUntil != "" {
		t.Fatalf("pending restart still reported: %+v", st)
	}
	end, _ := until(t, c, "run-end")
	if end.Result == nil || end.Result.Applied || !strings.Contains(end.Result.Skipped, "No restart is waiting") {
		t.Fatalf("cancel: %+v", end.Result)
	}
	if _, pending := h.agent.restartPending(); pending {
		t.Fatal("the agent still holds changes for a restart that is not coming")
	}
}

// A run the agent was stopped in the middle of is reported as interrupted by the next start;
// a run that finished is not.
func TestInterruptedRunIsReportedAfterRestart(t *testing.T) {
	dir := t.TempDir()
	j := openJournal(dir)
	before := &actions.Measurement{Items: []actions.Item{{Item: "Test value", Value: "off"}}}
	_ = j.running(actions.Result{RunID: "mid-apply", Kind: "action", Action: "linux-test-set", Applied: true, AppliedAt: now(), Before: before})
	_ = j.running(actions.Result{RunID: "mid-measure", Kind: "action", Action: "linux-test-set"})
	_ = j.running(actions.Result{RunID: "finished", Kind: "action", Action: "linux-test-set"})
	_ = j.put(actions.Result{RunID: "finished", Kind: "action", Action: "linux-test-set", EndedAt: now()})

	a := New(Config{DataDir: dir, Logger: log.New(io.Discard, "", 0)})
	got := map[string]actions.Result{}
	for _, r := range a.journal.outbox() {
		got[r.RunID] = r
	}
	if r := got["mid-apply"]; !r.Aborted || !r.Applied || r.Error != interruptedNote || r.EndedAt == "" || r.Before == nil {
		t.Fatalf("mid-apply: %+v", r)
	}
	if r := got["mid-measure"]; !r.Aborted || r.Applied || r.Skipped == "" {
		t.Fatalf("mid-measure: %+v", r)
	}
	if r := got["finished"]; r.Aborted || r.Error != "" {
		t.Fatalf("finished run rewritten: %+v", r)
	}
	if n := len(a.journal.data.Running); n != 0 {
		t.Fatalf("%d runs still marked running", n)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "actions.log")); strings.Count(string(b), `"interrupted":true`) != 2 {
		t.Fatalf("audit log:\n%s", b)
	}
	// a second start finds nothing more to recover
	again := New(Config{DataDir: dir, Logger: log.New(io.Discard, "", 0)})
	if n := len(again.journal.outbox()); n != 3 {
		t.Fatalf("outbox has %d results after a second start, want 3", n)
	}
}

// When the agent is stopped, a running change gets a short time to finish and report.
func TestDrainWaitsForARunningChange(t *testing.T) {
	a := New(Config{DataDir: t.TempDir(), Logger: log.New(io.Discard, "", 0)})
	a.flight.Add(1)
	go func() {
		time.Sleep(300 * time.Millisecond)
		a.flight.Done()
	}()
	start := time.Now()
	a.drain(5 * time.Second)
	if d := time.Since(start); d < 250*time.Millisecond || d > 3*time.Second {
		t.Fatalf("drain took %s", d)
	}
	a.flight.Add(1)
	defer a.flight.Done()
	start = time.Now()
	a.drain(200 * time.Millisecond)
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("drain ignored its limit: %s", d)
	}
}

// A real custom command: stopping the agent (SIGTERM cancels the root context) lets it finish
// and report within the drain, abort still stops it at once, and one that outlasts the drain is
// ended and reported as aborted, not left running.
func TestDrainLetsACustomCommandFinish(t *testing.T) {
	sendExec := func(c *protocol.Codec, runID, script string) {
		t.Helper()
		_ = c.Write(protocol.Message{Type: "exec", RunID: runID, Shell: "sh", Script: script, Technician: "Lisandro", Reason: "test"})
		until(t, c, "check-start")
	}
	h := newHarness(t, true)
	h.setPolicy("full")
	c, _, closeFn := h.connect()
	defer closeFn()
	sendExec(c, "x0", "sleep 5")
	start := time.Now()
	_ = c.Write(protocol.Message{Type: "abort", RunID: "x0"})
	if end, _ := until(t, c, "run-end"); end.Result == nil || !end.Result.Aborted || time.Since(start) > 3*time.Second {
		t.Fatalf("abort of a custom command: %+v after %s", end.Result, time.Since(start))
	}

	finished := filepath.Join(h.dir, "finished")
	sendExec(c, "x1", "sleep 1\necho ok > '"+finished+"'")
	h.cancel() // what SIGTERM does
	start = time.Now()
	h.agent.drain(15 * time.Second)
	if d := time.Since(start); d > 10*time.Second {
		t.Fatalf("drain took %s", d)
	}
	if _, err := os.Stat(finished); err != nil {
		t.Fatalf("the agent stopping killed the custom command: %v", err)
	}
	if r, ok := h.agent.journal.find("x1"); !ok || r.Aborted || r.ExitCode == nil || *r.ExitCode != 0 {
		t.Fatalf("x1 result %+v", r)
	}

	h2 := newHarness(t, true)
	h2.setPolicy("full")
	c2, _, closeFn2 := h2.connect()
	defer closeFn2()
	late := filepath.Join(h2.dir, "late")
	sendExec(c2, "x2", "sleep 1\necho late > '"+late+"'")
	started := time.Now()
	h2.cancel()
	h2.agent.drain(200 * time.Millisecond)
	if d := time.Since(started); d > 8*time.Second {
		t.Fatalf("drain past its limit took %s", d)
	}
	if r, ok := h2.agent.journal.find("x2"); !ok || !r.Aborted {
		t.Fatalf("x2 result %+v", r)
	}
	time.Sleep(time.Until(started.Add(1500 * time.Millisecond)))
	if _, err := os.Stat(late); err == nil {
		t.Fatal("a custom command outlived the drain")
	}
}

// The whole drain fits in the time systemd and launchd give the agent before SIGKILL.
func TestDrainFitsTheServiceStopTimeout(t *testing.T) {
	if drainWait+drainEnd >= service.StopSeconds*time.Second {
		t.Fatalf("the drain (%s, then %s) does not fit in the %d s the service waits after SIGTERM", drainWait, drainEnd, service.StopSeconds)
	}
}

// A custom command that arrives once the agent is stopping is not started.
func TestNoCustomCommandStartsWhileStopping(t *testing.T) {
	h := newHarness(t, true)
	h.setPolicy("full")
	stopped, stop := context.WithCancel(context.Background())
	stop()
	h.agent.rootMu.Lock()
	h.agent.rootCtx = stopped
	h.agent.rootMu.Unlock()
	c, _, closeFn := h.connect()
	defer closeFn()
	ran := filepath.Join(h.dir, "ran")
	_ = c.Write(protocol.Message{Type: "exec", RunID: "x3", Shell: "sh", Script: "echo ran > '" + ran + "'", Technician: "Lisandro", Reason: "test"})
	if end, _ := until(t, c, "run-end"); end.Result == nil || !end.Result.Aborted {
		t.Fatalf("x3: %+v", end.Result)
	}
	if _, err := os.Stat(ran); err == nil {
		t.Fatal("a custom command started while the agent was stopping")
	}
}
