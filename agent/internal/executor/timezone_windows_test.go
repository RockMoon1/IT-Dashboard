package executor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// TestLaunchCostAroundTimeZoneChange times how PowerShell starts with the agent's environment
// before a time zone change, after it and after putting the zone back. On hosted runners every
// agent process took 11 to 20 seconds after a change (and with an empty module analysis cache of
// its own, every time), while launches with the runner's own PSModulePath stayed at 0.2 s. This
// version checks whether a cache file of the agent's own recovers once one long-lived process has
// written it, and whether importing a module by path skips the slow command lookup.
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

	ownCache := filepath.Join(t.TempDir(), "ModuleAnalysisCache")
	agentEnv := childEnv(os.Environ(), profiles.Check{CleanEnv: true, FixedPath: true})
	withCache := append(append([]string(nil), agentEnv...), "PSModuleAnalysisCachePath="+ownCache)
	cache := func() string {
		fi, err := os.Stat(ownCache)
		if err != nil {
			return "no cache file"
		}
		return fmt.Sprintf("cache %d bytes, written %s ago", fi.Size(), time.Since(fi.ModTime()).Round(time.Second))
	}
	run := func(stage, name string, env []string, script string) {
		cmd := exec.Command(powerShellPath(), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
		cmd.Env = env
		cmd.Dir = filepath.Join(systemRoot(), "System32")
		start := time.Now()
		out, err := cmd.CombinedOutput()
		msg := ""
		if err != nil {
			msg = fmt.Sprintf(" err %v %.200s", err, out)
		}
		t.Logf("%-22s %-18s %6d ms  %s%s", stage, name, time.Since(start).Milliseconds(), cache(), msg)
	}
	const lookup = "$null = Get-Service -Name Spooler"
	const imported = `Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1"; $null = Get-Service -Name Spooler`
	const warm = "$null = Get-Module -ListAvailable; Start-Sleep -Seconds 15"
	probe := func(stage string) {
		run(stage, "agent-env", agentEnv, lookup)
		run(stage, "agent-env+import", agentEnv, imported)
		run(stage, "own-cache", withCache, lookup)
		run(stage, "own-cache again", withCache, lookup)
	}
	setZone := func(id string) {
		start := time.Now()
		ps("Set-TimeZone -Id '" + id + "'")
		t.Logf("time zone now %q (%s)", ps("(Get-TimeZone).Id"), time.Since(start).Round(time.Millisecond))
	}

	probe("before")
	run("before", "warm own cache", withCache, warm)
	probe("before, warmed")
	setZone(other)
	probe("changed")
	run("changed", "warm own cache", withCache, warm)
	probe("changed, warmed")
	setZone(orig)
	probe("restored")
	run("restored", "warm own cache", withCache, warm)
	probe("restored, warmed")
}
