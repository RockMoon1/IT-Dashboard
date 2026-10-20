package executor

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// TestLaunchCostAroundTimeZoneChange: after a time zone change, Windows PowerShell's module
// search took 11 to 20 s in every process that had to look a command up (its analysis cache is
// keyed on local-time file stamps). The agent imports what a script needs by path instead, so its
// launches must stay fast. The raw launch is logged beside them to show the search it avoids.
// Opt-in (ARH_LIVE_APPLY=1): it really changes the time zone and restores it.
func TestLaunchCostAroundTimeZoneChange(t *testing.T) {
	if os.Getenv("ARH_LIVE_APPLY") != "1" {
		t.Skip("set ARH_LIVE_APPLY=1 on a throwaway Windows machine: this changes the time zone")
	}
	ps := func(script string) string {
		out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script).CombinedOutput()
		if err != nil {
			t.Logf("%q: %v %s", script, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	orig := ps("(Get-TimeZone).Id")
	if orig == "" {
		t.Fatal("cannot read the time zone")
	}
	t.Cleanup(func() { ps("Set-TimeZone -Id '" + orig + "'") })
	other := "Eastern Standard Time"
	if orig == other {
		other = "Mountain Standard Time"
	}

	const lookup = "$null = Get-Service -Name Spooler"
	agentEnv := childEnv(os.Environ(), profiles.Check{CleanEnv: true, FixedPath: true})
	raw := func(stage string) {
		cmd := exec.Command(powerShellPath(), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", lookup)
		cmd.Env = agentEnv
		cmd.Dir = filepath.Join(systemRoot(), "System32")
		start := time.Now()
		err := cmd.Run()
		t.Logf("%-10s %-22s %6d ms err %v", stage, "raw (module search)", time.Since(start).Milliseconds(), err)
	}
	agent := func(stage string, strict bool) {
		for _, c := range []profiles.Check{
			{ID: "action", Shell: "powershell", Command: []string{lookup}, TimeoutSeconds: 120, CleanEnv: true, FixedPath: true, LongScript: true},
			{ID: "scan", Shell: "powershell", Command: []string{lookup}, TimeoutSeconds: 120},
		} {
			r := Run(context.Background(), c, func(string, []byte) {})
			t.Logf("%-10s %-22s %6d ms exit %d", stage, "agent "+c.ID, r.Duration.Milliseconds(), r.ExitCode)
			if strict && (r.ExitCode != 0 || r.Duration > 3*time.Second) {
				t.Errorf("an agent %s launch after a time zone change took %s (exit %d)", c.ID, r.Duration, r.ExitCode)
			}
		}
	}
	setZone := func(id string) {
		ps("Set-TimeZone -Id '" + id + "'")
		t.Logf("time zone now %q", ps("(Get-TimeZone).Id"))
	}

	raw("before")
	agent("before", false)
	setZone(other)
	raw("changed")
	agent("changed", true)
	setZone(orig)
	raw("restored")
	agent("restored", true)
}
