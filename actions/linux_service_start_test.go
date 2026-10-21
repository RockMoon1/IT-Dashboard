package actions

import (
	"fmt"
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

// The linux-service-start measure, against a stub systemctl that prints, like systemctl show -p,
// only the properties asked for, as systemd reports them in each state. A one-shot unit is done
// only when it ran since boot and systemd counted that run a success: systemd starts every unit
// with Result=success and reset-failed sets it back, so the measure checks the exit itself. An
// exit of 0, an exit code or signal listed in SuccessExitStatus=, and a failure of a command
// marked ExecStart=- are successes (ExecMainStatus is the raw status either way).
func TestLinuxServiceStartMeasure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX shell")
	}
	act := shipped(t, "linux-service-start")
	oneshot := "Type=oneshot\nRemainAfterExit=no\n"
	// ran: a one-shot that started since boot and is inactive with Result=success; how is
	// ExecMainCode (1 exited, 2 killed by a signal), status is ExecMainStatus
	ran := func(how, status int, more string) string {
		return oneshot + fmt.Sprintf("ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\nExecMainCode=%d\nExecMainStatus=%d\n", how, status) + more
	}
	// cmd is one ExecStart= line of systemctl show
	cmd := func(argv, ignore string, pid, status int) string {
		return fmt.Sprintf("ExecStart={ path=/usr/bin/x ; argv[]=%s ; ignore_errors=%s ; start_time=[Wed 2026-10-21 02:22:51 UTC] ; stop_time=[Wed 2026-10-21 02:22:51 UTC] ; pid=%d ; code=exited ; status=%d }\n", argv, ignore, pid, status)
	}
	never := "ExecMainStartTimestampMonotonic=0\nExecMainPID=0\nExecMainCode=0\nExecMainStatus=0\nExecStart={ path=/usr/bin/x ; argv[]=/usr/bin/x ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n"
	cases := []struct {
		name, show, enabled string
		change              bool
		plan                string
		blocked             bool
	}{
		{"one-shot never started", oneshot + "ActiveState=inactive\nResult=success\n" + never, "enabled", true, "Start", false},
		{"one-shot reset-failed after a failure", ran(1, 1, cmd("/usr/bin/x", "no", 4242, 1)), "enabled", true, "Start", false},
		{"one-shot stopped mid-run", ran(2, 15, cmd("/usr/bin/x", "no", 4242, 15)), "enabled", true, "Start", false},
		{"one-shot failed", oneshot + "ActiveState=failed\nResult=exit-code\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\nExecMainCode=1\nExecMainStatus=1\n" + cmd("/usr/bin/x", "no", 4242, 1), "enabled", true, "Start", false},
		{"one-shot ran and exited 0", ran(1, 0, cmd("/usr/bin/x", "no", 4242, 0)), "enabled", false, "Ran and finished", false},
		// systemd counts these runs a success although the status is not 0
		{"one-shot exit listed in SuccessExitStatus", ran(1, 65, "SuccessExitStatus=65 75 USR1\n"+cmd("/usr/bin/x", "no", 4242, 65)), "enabled", false, "Ran and finished", false},
		{"one-shot signal listed in SuccessExitStatus", ran(2, 15, "SuccessExitStatus=75 TERM\n"+cmd("/usr/bin/x", "no", 4242, 15)), "enabled", false, "Ran and finished", false},
		{"one-shot signal listed with a SIG prefix", ran(2, 10, "SuccessExitStatus=SIGUSR1\n"+cmd("/usr/bin/x", "no", 4242, 10)), "enabled", false, "Ran and finished", false},
		{"one-shot failure ignored (ExecStart=-)", ran(1, 1, cmd("/usr/bin/x", "yes", 4242, 1)), "enabled", false, "Ran and finished", false},
		{"one-shot failure ignored in the last of two commands", ran(1, 1, cmd("/usr/bin/a", "no", 4241, 0)+cmd("/usr/bin/x", "yes", 4242, 1)), "enabled", false, "Ran and finished", false},
		// and these are failures, cleared with reset-failed
		{"one-shot exit not in SuccessExitStatus", ran(1, 1, "SuccessExitStatus=65\n"+cmd("/usr/bin/x", "no", 4242, 1)), "enabled", true, "Start", false},
		{"one-shot signal number listed only as an exit code", ran(2, 15, "SuccessExitStatus=15\n"+cmd("/usr/bin/x", "no", 4242, 15)), "enabled", true, "Start", false},
		{"one-shot exit code listed only as a signal", ran(1, 15, "SuccessExitStatus=TERM\n"+cmd("/usr/bin/x", "no", 4242, 15)), "enabled", true, "Start", false},
		{"one-shot failed command not ignored, another one is", ran(1, 1, cmd("/usr/bin/a", "yes", 4241, 1)+cmd("/usr/bin/x", "no", 4242, 1)), "enabled", true, "Start", false},
		{"one-shot argv that looks like an ignored command", ran(1, 1, cmd("/bin/echo x ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=4242 ; code=exited ; status=0 }", "no", 4242, 1)), "enabled", true, "Start", false},
		{"one-shot ignored command from an earlier run", ran(1, 1, cmd("/usr/bin/x", "yes", 4100, 1)), "enabled", true, "Start", false},
		{"one-shot exited 0 but no exit code shown", oneshot + "ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainStatus=0\n", "enabled", true, "Start", false},
		{"long-running and active", "Type=simple\nRemainAfterExit=no\nActiveState=active\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\nExecMainCode=0\nExecMainStatus=0\n", "enabled", false, "Already running", false},
		{"long-running and stopped", "Type=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\nExecMainCode=1\nExecMainStatus=0\n", "enabled", true, "Start", false},
		{"masked", "Type=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\n" + never, "masked", true, "Start", true},
		{"not found", "Type=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\n" + never, "", true, "Start", true},
	}
	// show prints the lines of $STUB/show for each property named with -p, as systemctl does
	stub := `#!/bin/sh
case "$1" in
show)
  shift
  prev=
  for a in "$@"; do
    if [ "$prev" = -p ]; then grep "^$a=" "$STUB/show"; fi
    prev=$a
  done
  exit 0 ;;
is-enabled) cat "$STUB/enabled"; [ "$(cat "$STUB/enabled")" = enabled ] ;;
esac
`
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
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
