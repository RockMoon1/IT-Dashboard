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
