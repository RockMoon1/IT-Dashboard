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
// only the properties asked for, as systemd reports them in each state, and a stub journalctl
// that answers only the query for this boot's records that PID 1 wrote about the unit. A one-shot
// unit is done only when it ran since boot and systemd counted that run a success. systemd starts
// every unit with Result=success, and reset-failed sets it back, so the measure asks the journal
// how the last run ended ("Deactivated successfully" or "Failed with result ..."), and without a
// record of that run reads the status of every command of it: an exit of 0, an exit code or signal
// listed in SuccessExitStatus=, and a failure of a command marked with "-" are successes. A unit
// systemd unloaded after its run (nothing refers to it) has lost that state, so then only the
// journal can say it ran.
func TestLinuxServiceStartMeasure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX shell")
	}
	act := shipped(t, "linux-service-start")
	oneshot := "Id=arh-test.service\nType=oneshot\nRemainAfterExit=no\n"
	// ran: a one-shot whose main process (pid 4242) started since boot and that is now inactive
	// with Result=success; status is how the main process ended, as systemctl prints it ("1" an
	// exit, "15/TERM" a signal), and more holds the unit's Exec*= lines
	ran := func(status, more string) string {
		how, num := 1, status
		if i := strings.Index(status, "/"); i >= 0 {
			how, num = 2, status[:i]
		}
		return oneshot + fmt.Sprintf("ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\nExecMainCode=%d\nExecMainStatus=%s\n", how, num) + more
	}
	// cmd is one Exec*= line of systemctl show
	cmd := func(kind, argv, ignore string, pid int, status string) string {
		code := "exited"
		if strings.Contains(status, "/") {
			code = "killed"
		}
		return fmt.Sprintf("%s={ path=/usr/bin/x ; argv[]=%s ; ignore_errors=%s ; start_time=[Wed 2026-10-21 02:22:51 UTC] ; stop_time=[Wed 2026-10-21 02:22:51 UTC] ; pid=%d ; code=%s ; status=%s }\n", kind, argv, ignore, pid, code, status)
	}
	// start is the main command's line
	start := func(ignore, status string) string { return cmd("ExecStart", "/usr/bin/x", ignore, 4242, status) }
	// never: what systemd shows for a unit with no run in memory (never started, or loaded afresh
	// after systemd unloaded it)
	never := "ExecMainStartTimestampMonotonic=0\nExecMainPID=0\nExecMainCode=0\nExecMainStatus=0\nExecStart={ path=/usr/bin/x ; argv[]=/usr/bin/x ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n"
	idle := oneshot + "ActiveState=inactive\nResult=success\n" + never
	// logged is the newest record journalctl -o export gives: the unit succeeded, failed or was
	// skipped, at a monotonic time (the main process above started at 81234567)
	const succeeded, failed, skipped = "7ad2d189f7e94e70a38c781354912448", "d9b373ed55a64feb8242e02dbe79a49c", "0e4284a0caca4bfc81c0bb6786972673"
	logged := func(id string, at int) string {
		return fmt.Sprintf("__CURSOR=s=1;i=2\n__REALTIME_TIMESTAMP=1792540000000000\n__MONOTONIC_TIMESTAMP=%d\n_BOOT_ID=4c398f739c8447eb99d3fe100ad1b0fa\nPRIORITY=6\n_PID=1\nMESSAGE_ID=%s\nUNIT=arh-test.service\nMESSAGE=arh-test.service: ...\n", at, id)
	}
	cases := []struct {
		name, show, journal, enabled string
		change                       bool
		plan                         string
		blocked                      bool
	}{
		{"one-shot never started", idle, "", "enabled", true, "Start", false},
		// systemd unloaded it after the run: only the journal knows
		{"one-shot unloaded after a run that succeeded", idle, logged(succeeded, 5000000), "enabled", false, "Ran and finished", false},
		{"one-shot unloaded after a failure cleared with reset-failed", idle, logged(failed, 5000000), "enabled", true, "Start", false},
		{"one-shot whose last start was skipped", idle, logged(skipped, 5000000), "enabled", true, "Start", false},
		{"one-shot unloaded after a run, named by an alias", strings.Replace(idle, "Id=arh-test.service", "Id=arh-real.service", 1), strings.Replace(logged(succeeded, 5000000), "UNIT=arh-test.service", "UNIT=arh-real.service", 1), "enabled", false, "Ran and finished", false},
		// no record of the run in the journal: the commands' status decides
		{"one-shot reset-failed after a failure", ran("1", start("no", "1")), "", "enabled", true, "Start", false},
		{"one-shot stopped mid-run", ran("15/TERM", start("no", "15/TERM")), "", "enabled", true, "Start", false},
		{"one-shot failed", oneshot + "ActiveState=failed\nResult=exit-code\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\nExecMainCode=1\nExecMainStatus=1\n" + start("no", "1"), "", "enabled", true, "Start", false},
		{"one-shot ran and exited 0", ran("0", start("no", "0")), "", "enabled", false, "Ran and finished", false},
		// systemd counts these runs a success although the status is not 0
		{"one-shot exit listed in SuccessExitStatus", ran("65", "SuccessExitStatus=65 75 USR1\n"+start("no", "65")), "", "enabled", false, "Ran and finished", false},
		{"one-shot signal listed in SuccessExitStatus", ran("15/TERM", "SuccessExitStatus=75 TERM\n"+start("no", "15/TERM")), "", "enabled", false, "Ran and finished", false},
		{"one-shot signal listed with a SIG prefix", ran("10/USR1", "SuccessExitStatus=SIGUSR1\n"+start("no", "10/USR1")), "", "enabled", false, "Ran and finished", false},
		// the signal's name is the one systemd prints, not this shell's kill -l (30 is USR1 on
		// macOS, PWR on Linux; signal numbers differ between systems)
		{"one-shot signal named by systemd, whatever its number here", ran("30/USR1", "SuccessExitStatus=USR1\n"+start("no", "30/USR1")), "", "enabled", false, "Ran and finished", false},
		{"one-shot failure ignored (ExecStart=-)", ran("1", start("yes", "1")), "", "enabled", false, "Ran and finished", false},
		{"one-shot failure ignored in the last of two commands", ran("1", cmd("ExecStart", "/usr/bin/a", "no", 4241, "0")+start("yes", "1")), "", "enabled", false, "Ran and finished", false},
		{"one-shot ExecStartPre, ExecStartPost and ExecStopPost ran fine", ran("0", cmd("ExecStartPre", "/usr/bin/p", "no", 4241, "0")+start("no", "0")+cmd("ExecStartPost", "/usr/bin/q", "no", 4243, "0")+cmd("ExecStopPost", "/usr/bin/r", "no", 4244, "0")), "", "enabled", false, "Ran and finished", false},
		{"one-shot ExecStartPost failure ignored (ExecStartPost=-)", ran("0", start("no", "0")+cmd("ExecStartPost", "/usr/bin/q", "yes", 4243, "1")), "", "enabled", false, "Ran and finished", false},
		{"one-shot ExecStartPost exit listed in SuccessExitStatus", ran("0", "SuccessExitStatus=65\n"+start("no", "0")+cmd("ExecStartPost", "/usr/bin/q", "no", 4243, "65")), "", "enabled", false, "Ran and finished", false},
		// and these are failures, cleared with reset-failed
		{"one-shot exit not in SuccessExitStatus", ran("1", "SuccessExitStatus=65\n"+start("no", "1")), "", "enabled", true, "Start", false},
		{"one-shot signal number listed only as an exit code", ran("15/TERM", "SuccessExitStatus=15\n"+start("no", "15/TERM")), "", "enabled", true, "Start", false},
		{"one-shot exit code listed only as a signal", ran("15", "SuccessExitStatus=TERM\n"+start("no", "15")), "", "enabled", true, "Start", false},
		{"one-shot failed command not ignored, another one is", ran("1", cmd("ExecStart", "/usr/bin/a", "yes", 4241, "1")+start("no", "1")), "", "enabled", true, "Start", false},
		{"one-shot argv that looks like an ignored command", ran("1", cmd("ExecStart", "/bin/echo x ; ignore_errors=yes ; start_time=[n/a] ; stop_time=[n/a] ; pid=4242 ; code=exited ; status=0 }", "no", 4242, "1")), "", "enabled", true, "Start", false},
		{"one-shot ignored command from an earlier run", ran("1", cmd("ExecStart", "/usr/bin/x", "yes", 4100, "1")), "", "enabled", true, "Start", false},
		{"one-shot exited 0 but no command shown", oneshot + "ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainStatus=0\n", "", "enabled", true, "Start", false},
		{"one-shot whose ExecStartPost failed", ran("0", start("no", "0")+cmd("ExecStartPost", "/usr/bin/q", "no", 4243, "1")), "", "enabled", true, "Start", false},
		{"one-shot whose ExecStart=- and ExecStartPost failed", ran("1", start("yes", "1")+cmd("ExecStartPost", "/usr/bin/q", "no", 4243, "1")), "", "enabled", true, "Start", false},
		{"one-shot whose ExecStopPost failed", ran("0", start("no", "0")+cmd("ExecStopPost", "/usr/bin/r", "no", 4244, "2")), "", "enabled", true, "Start", false},
		{"one-shot whose ExecStop was killed", ran("0", start("no", "0")+cmd("ExecStop", "/usr/bin/s", "no", 4244, "9/KILL")), "", "enabled", true, "Start", false},
		// a record of this run in the journal decides; one from before the run does not
		{"one-shot whose start timed out (TERM listed), the journal has the failure", ran("15/TERM", "SuccessExitStatus=TERM\n"+start("no", "15/TERM")), logged(failed, 82234567), "enabled", true, "Start", false},
		{"one-shot whose ExecStartPost failed, the journal has the failure", ran("0", start("no", "0")), logged(failed, 82234567), "enabled", true, "Start", false},
		{"one-shot that succeeded, the journal agrees", ran("0", start("no", "0")), logged(succeeded, 82234567), "enabled", false, "Ran and finished", false},
		{"one-shot that succeeded, no command shown, the journal says so", oneshot + "ActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\n", logged(succeeded, 82234567), "enabled", false, "Ran and finished", false},
		{"one-shot that succeeded after a failure the journal still holds", ran("0", start("no", "0")), logged(failed, 80000000), "enabled", false, "Ran and finished", false},
		{"one-shot that failed after a success the journal still holds", ran("1", start("no", "1")), logged(succeeded, 80000000), "enabled", true, "Start", false},
		{"long-running and active", "Id=arh-test.service\nType=simple\nRemainAfterExit=no\nActiveState=active\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\nExecMainCode=0\nExecMainStatus=0\n", "", "enabled", false, "Already running", false},
		{"long-running and stopped", "Id=arh-test.service\nType=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\nExecMainStartTimestampMonotonic=81234567\nExecMainPID=4242\nExecMainCode=1\nExecMainStatus=0\n" + start("no", "0"), logged(succeeded, 82234567), "enabled", true, "Start", false},
		{"masked", "Id=arh-test.service\nType=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\n" + never, "", "masked", true, "Start", true},
		{"not found", "Id=arh-test.service\nType=simple\nRemainAfterExit=no\nActiveState=inactive\nResult=success\n" + never, "", "", true, "Start", true},
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
	// journalctl prints $STUB/journal only for this boot's records written by PID 1 (no other
	// process can forge _PID) about the unit's id, as systemctl show gives it
	journal := `#!/bin/sh
id=$(sed -n 's/^Id=//p' "$STUB/show")
[ -n "$id" ] && [ -f "$STUB/journal" ] || exit 0
case " $* " in *" -b "*) ;; *) exit 0 ;; esac
case " $* " in *" _PID=1 "*) ;; *) exit 0 ;; esac
case " $* " in *" UNIT=$id "*) ;; *) exit 0 ;; esac
cat "$STUB/journal"
`
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, body := range map[string]string{"systemctl": stub, "journalctl": journal} {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			_ = os.WriteFile(filepath.Join(dir, "show"), []byte(c.show), 0o644)
			if c.journal != "" {
				_ = os.WriteFile(filepath.Join(dir, "journal"), []byte(c.journal), 0o644)
			}
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
			if out, err := cmd.CombinedOutput(); err != nil || len(out) > 0 {
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
