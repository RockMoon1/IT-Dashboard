package link

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/actions"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/protocol"
)

func liveOS() string {
	return map[string]string{"windows": "windows", "darwin": "macos", "linux": "linux"}[runtime.GOOS]
}

func liveAgent(t *testing.T) *Agent {
	dir := t.TempDir()
	a := New(Config{DataDir: dir, OS: liveOS(), Logger: log.New(io.Discard, "", 0)})
	a.rootCtx = context.Background()
	return a
}

// TestShippedActionsMeasureHere runs the measure step of every action for this OS, as the agent
// does for a preview. Opt-in (ARH_LIVE_ACTIONS=1): CI runs it elevated on Windows, macOS and
// Linux runners. Each measure must exit 0, give a plan, and write only lines the agent knows.
func TestShippedActionsMeasureHere(t *testing.T) {
	if os.Getenv("ARH_LIVE_ACTIONS") != "1" {
		t.Skip("set ARH_LIVE_ACTIONS=1 to run every action's measure step on this machine")
	}
	a := liveAgent(t)
	list := actions.ForOS(liveOS())
	if len(list) == 0 {
		t.Fatal("no actions for this OS")
	}
	for _, act := range list {
		act := act
		t.Run(act.Name, func(t *testing.T) {
			params := map[string]string{}
			for _, p := range act.Params {
				params[p.Name] = p.Default
				if params[p.Name] == "" {
					params[p.Name] = p.Examples.OK[0]
				}
			}
			m := a.phase(context.Background(), act, params, actions.PhaseMeasure, "live-"+act.Name, actions.MeasureTimeout)
			t.Logf("items %v info %v plan %v %q blockers %v warnings %v", m.Items, m.Info, deref(m.Change), m.Plan, m.Blockers, m.Warnings)
			if m.ExitCode != 0 || m.TimedOut {
				t.Errorf("measure exit %d timedOut=%v", m.ExitCode, m.TimedOut)
			}
			if m.Change == nil {
				t.Error("measure gave no plan")
			}
			if m.Ignored != 0 {
				t.Errorf("%d result lines not understood", m.Ignored)
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

func sh(t *testing.T, script string) string {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	} else {
		cmd = exec.Command("/bin/sh", "-c", script)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Logf("prep %q: %v %s", script, err, out)
	}
	return strings.TrimSpace(string(out))
}

func runLive(t *testing.T, a *Agent, name string, params map[string]string) actions.Result {
	t.Helper()
	var act actions.Action
	for _, x := range actions.ForOS(liveOS()) {
		if x.Name == name {
			act = x
		}
	}
	if act.Name == "" {
		t.Fatalf("no action %s", name)
	}
	full := map[string]string{}
	for _, p := range act.Params {
		full[p.Name] = p.Default
		if v, ok := params[p.Name]; ok {
			full[p.Name] = v
		}
	}
	id := name + "-" + time.Now().Format("150405.000")
	clock := &phaseClock{}
	codec := protocol.NewCodec(clock)
	a.attach(codec)
	started := time.Now()
	a.runAction(context.Background(), act, full, protocol.Message{RunID: id, Mode: "apply", Technician: "ci", Reason: "live test"}, "cable")
	a.detach(codec)
	r, ok := a.journal.find(id)
	if !ok {
		t.Fatalf("%s left no result", name)
	}
	t.Logf("%s: %s in all; phases %s", name, time.Since(started).Round(time.Millisecond), clock.String())
	t.Logf("%s: applied=%v skipped=%q before=%v after=%v", name, r.Applied, r.Skipped, items(r.Before), items(r.After))
	if r.Apply != nil {
		t.Logf("%s: apply exit %d notes %v changes %v warnings %v", name, r.Apply.ExitCode, r.Apply.Notes, r.Apply.Changes, r.Apply.Warnings)
	}
	return r
}

// phaseClock stands in for the dashboard and keeps how long each phase's process ran, from the
// agent's own check-end messages, so a slow run in CI shows which phase took the time.
type phaseClock struct {
	mu    sync.Mutex
	lines []string
}

func (c *phaseClock) Read([]byte) (int, error) { return 0, io.EOF }

func (c *phaseClock) Write(b []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var m protocol.Message
		if json.Unmarshal([]byte(line), &m) == nil && m.Type == "check-end" {
			c.lines = append(c.lines, fmt.Sprintf("%s %dms", m.CheckID, m.DurationMs))
		}
	}
	return len(b), nil
}

func (c *phaseClock) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.lines, ", ")
}

func items(m *actions.Measurement) []actions.Item {
	if m == nil {
		return nil
	}
	return m.Items
}

func value(m *actions.Measurement, item string) string {
	if m == nil {
		return ""
	}
	for _, x := range m.Items {
		if x.Item == item {
			return x.Value
		}
	}
	return ""
}

func wantApplied(t *testing.T, r actions.Result) {
	t.Helper()
	if !r.Applied || r.Apply == nil || r.Apply.ExitCode != 0 || r.After == nil {
		t.Fatalf("not applied: skipped=%q apply=%+v", r.Skipped, r.Apply)
	}
}

// TestShippedActionsApplyHere really changes the machine and undoes it: only on a throwaway CI
// runner (ARH_LIVE_APPLY=1, elevated). Each case checks the measured after value and that the
// undo restores the measured before value.
func TestShippedActionsApplyHere(t *testing.T) {
	if os.Getenv("ARH_LIVE_APPLY") != "1" {
		t.Skip("set ARH_LIVE_APPLY=1 on a throwaway machine to apply actions for real")
	}
	a := liveAgent(t)
	restart := func(t *testing.T, osName string) {
		r := runLive(t, a, osName+"-restart", map[string]string{"minutes": "10"})
		wantApplied(t, r)
		c := runLive(t, a, osName+"-restart-cancel", nil)
		wantApplied(t, c)
		if _, pending := a.restartPending(); pending {
			t.Fatal("restart still recorded as pending after the cancel")
		}
	}
	switch runtime.GOOS {
	case "windows":
		t.Run("dns-flush", func(t *testing.T) { wantApplied(t, runLive(t, a, "windows-dns-flush", nil)) })
		t.Run("timezone", func(t *testing.T) {
			target := "Eastern Standard Time"
			if sh(t, "(Get-TimeZone).Id") == target {
				target = "Mountain Standard Time"
			}
			r := runLive(t, a, "windows-timezone-set", map[string]string{"zone": target})
			wantApplied(t, r)
			if got := value(r.After, "Time zone"); got != target {
				t.Fatalf("after %q, want %q", got, target)
			}
			u := runLive(t, a, "windows-timezone-set", r.Before.Restore)
			wantApplied(t, u)
			if value(u.After, "Time zone") != value(r.Before, "Time zone") {
				t.Fatalf("undo left %q, before was %q", value(u.After, "Time zone"), value(r.Before, "Time zone"))
			}
		})
		t.Run("wake-timers", func(t *testing.T) {
			r := runLive(t, a, "windows-wake-timers-set", map[string]string{"plugged": "off", "battery": "off"})
			if r.Before != nil && len(r.Before.Blockers) > 0 {
				t.Skip("no wake timer setting on this power plan")
			}
			if r.Applied {
				wantApplied(t, r)
				if value(r.After, "Wake timers plugged in") != "off" || value(r.After, "Wake timers on battery") != "off" {
					t.Fatalf("after %v", r.After.Items)
				}
				u := runLive(t, a, "windows-wake-timers-set", r.Before.Restore)
				wantApplied(t, u)
				if value(u.After, "Wake timers plugged in") != value(r.Before, "Wake timers plugged in") {
					t.Fatalf("undo %v before %v", u.After.Items, r.Before.Items)
				}
			}
		})
		t.Run("winhttp-proxy", func(t *testing.T) {
			sh(t, `netsh winhttp set proxy proxy-server="arh-test.invalid:3128" bypass-list="<local>"`)
			r := runLive(t, a, "windows-winhttp-proxy-clear", nil)
			wantApplied(t, r)
			if value(r.Before, "WinHTTP proxy") != "arh-test.invalid:3128" || value(r.Before, "WinHTTP bypass list") != "<local>" || value(r.After, "WinHTTP proxy") != "direct" {
				t.Fatalf("before %v after %v", r.Before.Items, r.After.Items)
			}
		})
		t.Run("firewall", func(t *testing.T) {
			sh(t, "Set-NetFirewallProfile -Profile Public -Enabled False")
			r := runLive(t, a, "windows-firewall-on", nil)
			if r.Before != nil && len(r.Before.Blockers) > 0 {
				t.Skipf("blocked here: %v", r.Before.Blockers)
			}
			wantApplied(t, r)
			if value(r.Before, "Firewall Public") != "off" || value(r.After, "Firewall Public") != "on" {
				t.Fatalf("before %v after %v", r.Before.Items, r.After.Items)
			}
		})
		t.Run("service-start", func(t *testing.T) {
			if sh(t, "(Get-Service Spooler).StartType") != "Automatic" {
				t.Skip("Spooler is not automatic on this runner")
			}
			sh(t, "Stop-Service Spooler -Force")
			r := runLive(t, a, "windows-service-start", map[string]string{"name": "Spooler"})
			wantApplied(t, r)
			if value(r.After, "Service Spooler") != "Running" {
				t.Fatalf("after %v", r.After.Items)
			}
			// RemoteRegistry is Automatic (trigger start) on Windows Server runners and Disabled on
			// desktops, so make it Manual for the refusal and put it back afterwards.
			was := sh(t, "(Get-Service RemoteRegistry).StartType")
			if was != "Automatic" && was != "Manual" && was != "Disabled" {
				t.Skipf("RemoteRegistry start type here: %q", was)
			}
			t.Cleanup(func() { sh(t, "Set-Service RemoteRegistry -StartupType "+was) })
			sh(t, "Stop-Service RemoteRegistry -Force -ErrorAction SilentlyContinue; Set-Service RemoteRegistry -StartupType Manual")
			refused := runLive(t, a, "windows-service-start", map[string]string{"name": "RemoteRegistry"})
			if refused.Applied {
				t.Fatal("started a service that is not automatic")
			}
			if refused.Before == nil || !strings.Contains(strings.Join(refused.Before.Blockers, "\n"), "Only automatic services") {
				t.Fatalf("no refusal reason: %+v", refused.Before)
			}
		})
		t.Run("time-resync", func(t *testing.T) { runLive(t, a, "windows-time-resync", nil) }) // reports; the VM's time source may refuse
		t.Run("restart-and-cancel", func(t *testing.T) { restart(t, "windows") })
	case "darwin":
		t.Run("dns-flush", func(t *testing.T) { wantApplied(t, runLive(t, a, "macos-dns-flush", nil)) })
		t.Run("firewall", func(t *testing.T) {
			sh(t, "/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off")
			r := runLive(t, a, "macos-firewall-on", nil)
			if r.Before != nil && len(r.Before.Blockers) > 0 {
				t.Skipf("blocked here: %v", r.Before.Blockers)
			}
			wantApplied(t, r)
			if value(r.Before, "Application firewall") != "off" || value(r.After, "Application firewall") != "on" {
				t.Fatalf("before %v after %v", r.Before.Items, r.After.Items)
			}
		})
		t.Run("time-resync", func(t *testing.T) { runLive(t, a, "macos-time-resync", nil) })
		t.Run("restart-and-cancel", func(t *testing.T) { restart(t, "macos") })
	case "linux":
		t.Run("dns-flush", func(t *testing.T) {
			r := runLive(t, a, "linux-dns-flush", nil)
			if r.Before != nil && len(r.Before.Blockers) > 0 {
				t.Skipf("blocked here: %v", r.Before.Blockers)
			}
			wantApplied(t, r)
		})
		t.Run("service-start", func(t *testing.T) {
			if sh(t, "systemctl is-enabled cron.service") != "enabled" {
				t.Skip("cron.service is not enabled on this runner")
			}
			sh(t, "systemctl stop cron.service")
			r := runLive(t, a, "linux-service-start", map[string]string{"name": "cron.service"})
			wantApplied(t, r)
			if value(r.After, "Service cron.service") != "active" {
				t.Fatalf("after %v", r.After.Items)
			}
			refused := runLive(t, a, "linux-service-start", map[string]string{"name": "emergency.service"})
			if refused.Applied {
				t.Fatal("started a service that is not enabled")
			}
		})
		t.Run("time-resync", func(t *testing.T) { runLive(t, a, "linux-time-resync", nil) })
		t.Run("restart-and-cancel", func(t *testing.T) { restart(t, "linux") })
	}
}
