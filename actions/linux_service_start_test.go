package actions

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func shipped(t *testing.T, name string) Action {
	t.Helper()
	all, err := All()
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range all {
		if a.Name == name {
			return a
		}
	}
	t.Fatalf("no action %s", name)
	return Action{}
}

// The linux-service-start measure, against a stub systemctl that prints what systemd reports in
// each state. A one-shot unit is done only when it ran since boot and exited 0: systemd starts
// every unit with Result=success, and reset-failed sets it back to success.
func TestLinuxServiceStartMeasure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX shell")
	}
	act := shipped(t, "linux-service-start")
	oneshot := "Type=oneshot\nRemainAfterExit=no\n"
	cases := []struct {
		name, show, enabled string
		change              bool
		plan                string
		blocked             bool
	}{
		{"one-shot never started", oneshot + "ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=0\nExecMainStatus=0\n", "enabled", true, "Start", false},
		{"one-shot reset-failed after a failure", oneshot + "ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainStatus=1\n", "enabled", true, "Start", false},
		{"one-shot stopped mid-run", oneshot + "ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainStatus=15\n", "enabled", true, "Start", false},
		{"one-shot failed", oneshot + "ActiveState=failed\nResult=exit-code\nExecMainStartTimestampMonotonic=81234567\nExecMainStatus=1\n", "enabled", true, "Start", false},
		{"one-shot ran and exited 0", oneshot + "ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainStatus=0\n", "enabled", false, "Ran and finished", false},
		{"long-running and active", "Type=simple\nRemainAfterExit=no\nActiveState=active\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainStatus=0\n", "enabled", false, "Already running", false},
		{"long-running and stopped", "Type=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainStatus=0\n", "enabled", true, "Start", false},
		{"masked", "Type=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=0\nExecMainStatus=0\n", "masked", true, "Start", true},
		{"not found", "Type=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=0\nExecMainStatus=0\n", "", true, "Start", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			stub := "#!/bin/sh\ncase \"$1\" in\nshow) cat \"$STUB/show\" ;;\nis-enabled) cat \"$STUB/enabled\"; [ \"$(cat \"$STUB/enabled\")\" = enabled ] ;;\nesac\n"
			if err := os.WriteFile(filepath.Join(dir, "systemctl"), []byte(stub), 0o755); err != nil {
				t.Fatal(err)
			}
			_ = os.WriteFile(filepath.Join(dir, "show"), []byte(c.show), 0o644)
			enabled := ""
			if c.enabled != "" {
				enabled = c.enabled + "\n"
			}
			_ = os.WriteFile(filepath.Join(dir, "enabled"), []byte(enabled), 0o644)
			result := filepath.Join(dir, "result")
			cmd := exec.Command("/bin/sh", "-s")
			cmd.Stdin = strings.NewReader(act.Script(PhaseMeasure))
			cmd.Env = append(act.Env(map[string]string{"name": "arh-test.service"}, PhaseMeasure, result),
				"PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"), "STUB="+dir)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			raw, _ := os.ReadFile(result)
			m := Parse(raw, act.RestoreNames())
			if m.Change == nil || *m.Change != c.change || !strings.Contains(m.Plan, c.plan) {
				t.Errorf("plan %v %q, want %v %q\n%s", deref(m.Change), m.Plan, c.change, c.plan, raw)
			}
			if (len(m.Blockers) > 0) != c.blocked {
				t.Errorf("blockers %q, want blocked=%v", m.Blockers, c.blocked)
			}
			if m.Ignored != 0 {
				t.Errorf("%d lines ignored in %q", m.Ignored, raw)
			}
		})
	}
}

func deref(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}
