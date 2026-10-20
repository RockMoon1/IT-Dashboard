package executor

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// TestLaunchCostAroundTimeZoneChange times how the agent starts PowerShell before a time zone
// change, after it and after putting the zone back, each twice. On hosted runners every action
// process took 11 to 20 seconds after a change, and kept doing so after the zone was restored,
// while launches with the inherited PSModulePath stayed at 0.2 s. Opt-in (ARH_LIVE_APPLY=1): it
// really changes the time zone and restores it.
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

	ownCache := filepath.Join(t.TempDir(), "ModuleAnalysisCache")
	machinePath := filepath.Join(os.Getenv("ProgramFiles"), "WindowsPowerShell", "Modules") + ";" +
		filepath.Join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "Modules")
	// set replaces (or with an empty value removes) one variable in the final environment.
	set := func(name, value string) func([]string) []string {
		return func(env []string) []string {
			out := env[:0:0]
			for _, kv := range env {
				if k, _, _ := strings.Cut(kv, "="); !strings.EqualFold(k, name) {
					out = append(out, kv)
				}
			}
			if value != "" {
				out = append(out, name+"="+value)
			}
			return out
		}
	}
	const lookup = "$null = Get-Service -Name Spooler -ErrorAction SilentlyContinue"
	action := func(script string) profiles.Check {
		return profiles.Check{ID: "probe", Shell: "powershell", Command: []string{script}, Format: "text", TimeoutSeconds: 120,
			Access: "read", CleanEnv: true, FixedPath: true, LongScript: true}
	}
	plain := profiles.Check{ID: "probe", Shell: "powershell", Command: []string{lookup}, Format: "text", TimeoutSeconds: 120, Access: "read"}
	variants := []struct {
		name  string
		check profiles.Check
		env   func([]string) []string
	}{
		{"plain", plain, nil},
		{"action", action(lookup), nil},
		{"action-exit0", action("exit 0"), nil},
		{"modpath-unset", action(lookup), set("PSModulePath", "")},
		{"modpath-machine", action(lookup), set("PSModulePath", machinePath)},
		{"own-cache", action(lookup), set("PSModuleAnalysisCachePath", ownCache)},
	}
	probe := func(stage string) {
		for _, v := range variants {
			cmd, h, err := command(context.Background(), v.check)
			if err != nil {
				t.Fatal(err)
			}
			if v.env != nil {
				if cmd.Env == nil {
					cmd.Env = os.Environ()
				}
				cmd.Env = v.env(cmd.Env)
			}
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			start := time.Now()
			if err = cmd.Start(); err == nil {
				h.afterStart()
				err = cmd.Wait()
			}
			h.done()
			t.Logf("%-16s %-16s %6d ms err %v", stage, v.name, time.Since(start).Milliseconds(), err)
		}
		start := time.Now()
		ps(lookup)
		t.Logf("%-16s %-16s %6d ms", stage, "-Command", time.Since(start).Milliseconds())
	}
	setZone := func(id string) {
		if r := Run(context.Background(), action("Set-TimeZone -Id '"+id+"'"), func(string, []byte) {}); r.ExitCode != 0 {
			t.Fatalf("Set-TimeZone %q: exit %d", id, r.ExitCode)
		}
	}

	probe("before")
	probe("before again")
	setZone(other)
	probe("changed")
	probe("changed again")
	setZone(orig)
	probe("restored")
	probe("restored again")
}
