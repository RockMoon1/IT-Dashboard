package executor

import (
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// TestLaunchCostAroundTimeZoneChange times every way the agent starts PowerShell before a time
// zone change, after it and after putting the zone back. On hosted runners every action process
// took about 15 seconds after windows-timezone-set ran, and kept doing so after the zone was
// restored. Opt-in (ARH_LIVE_APPLY=1): it really changes the time zone and restores it.
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
	for _, name := range []string{"PSModulePath", "PSModuleAnalysisCachePath", "LOCALAPPDATA"} {
		t.Logf("%s=%q", name, os.Getenv(name))
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

	const lookup = "$null = Get-Service -Name Spooler -ErrorAction SilentlyContinue"
	variants := []struct {
		name               string
		clean, fixed, long bool
		script             string
	}{
		{"plain", false, false, false, lookup},
		{"stdin", false, false, true, lookup},
		{"clean-env", true, false, false, lookup},
		{"fixed-path", false, true, false, lookup},
		{"action", true, true, true, lookup},
		{"action-exit0", true, true, true, "exit 0"},
	}
	check := func(name string, clean, fixed, long bool, script string) profiles.Check {
		return profiles.Check{ID: name, Shell: "powershell", Command: []string{script}, Format: "text", TimeoutSeconds: 120,
			Access: "read", CleanEnv: clean, FixedPath: fixed, LongScript: long}
	}
	probe := func(stage string) {
		for _, v := range variants {
			r := Run(context.Background(), check(v.name, v.clean, v.fixed, v.long, v.script), func(string, []byte) {})
			t.Logf("%-14s %-13s %6d ms exit %d", stage, v.name, r.Duration.Milliseconds(), r.ExitCode)
		}
		// the action launch without the Job Object
		cmd, h, err := command(context.Background(), check("no-job", true, true, true, lookup))
		if err == nil {
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			start := time.Now()
			err = cmd.Run()
			h.done()
			t.Logf("%-14s %-13s %6d ms err %v", stage, "action-no-job", time.Since(start).Milliseconds(), err)
		}
		start := time.Now()
		ps(lookup)
		t.Logf("%-14s %-13s %6d ms", stage, "-Command", time.Since(start).Milliseconds())
	}

	probe("before")
	if r := Run(context.Background(), check("set", true, true, true, "Set-TimeZone -Id '"+other+"'"), func(string, []byte) {}); r.ExitCode != 0 {
		t.Fatalf("Set-TimeZone %q: exit %d", other, r.ExitCode)
	}
	probe("changed")
	if r := Run(context.Background(), check("restore", true, true, true, "Set-TimeZone -Id '"+orig+"'"), func(string, []byte) {}); r.ExitCode != 0 {
		t.Fatalf("Set-TimeZone %q: exit %d", orig, r.ExitCode)
	}
	probe("restored")
}
