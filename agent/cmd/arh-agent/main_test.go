package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/agent/internal/datalock"
)

// With ARH_AGENT_MAIN=1 the test binary is the agent itself.
func TestMain(m *testing.M) {
	if os.Getenv("ARH_AGENT_MAIN") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// "arh-agent run" on a data folder another agent is using (the service, mid-change) exits with
// a clear error and touches nothing: the service's live run is not reported as interrupted, in
// runs.json or in the audit log.
func TestSecondRunLeavesTheRunningAgentAlone(t *testing.T) {
	dir := t.TempDir()
	runs := []byte(`{"ids":["live-run"],"running":[{"runId":"live-run","kind":"action","action":"linux-test-set","applied":true}],"outbox":[]}`)
	if err := os.WriteFile(filepath.Join(dir, "runs.json"), runs, 0o600); err != nil {
		t.Fatal(err)
	}
	release, err := datalock.Acquire(dir) // what the running service holds
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "run", "--data-dir", dir)
	cmd.Env = append(os.Environ(), "ARH_AGENT_MAIN=1")
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || !strings.Contains(string(out), "already using the data folder") {
		t.Errorf("second run: %v\n%s", err, out)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "runs.json")); !bytes.Equal(b, runs) {
		t.Errorf("runs.json changed:\n%s", b)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "actions.log")); err == nil {
		t.Errorf("audit log written:\n%s", b)
	}
}
