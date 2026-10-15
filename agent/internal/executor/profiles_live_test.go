package executor

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// TestShippedProfilesRunHere executes every check of every profile for this OS on the machine
// running the test, exactly as the agent would. It is opt-in (ARH_RUN_PROFILES=1) because it
// takes minutes and reads system state; CI runs it on Windows, macOS and Linux runners.
//
// A required check must exit 0; a json check must print parseable JSON. Optional checks are
// reported but never fail the test.
func TestShippedProfilesRunHere(t *testing.T) {
	if os.Getenv("ARH_RUN_PROFILES") != "1" {
		t.Skip("set ARH_RUN_PROFILES=1 to run the shipped profiles on this machine")
	}
	osName := map[string]string{"windows": "windows", "darwin": "macos", "linux": "linux"}[runtime.GOOS]
	list := profiles.ForOS(osName)
	if len(list) == 0 {
		t.Fatalf("no profiles for %s", osName)
	}
	seen := map[string]bool{}
	for _, p := range list {
		for _, c := range p.Checks {
			key := c.ID + "\x00" + c.Script()
			if seen[key] {
				continue // the same check is shared by several profiles
			}
			seen[key] = true
			p, c := p, c
			t.Run(p.Purpose+"/"+c.ID, func(t *testing.T) {
				var stdout, stderr strings.Builder
				res := Run(context.Background(), c, func(stream string, chunk []byte) {
					if stream == "stdout" {
						stdout.Write(chunk)
					} else {
						stderr.Write(chunk)
					}
				})
				t.Logf("%s: exit %d in %s, %d bytes out, timedOut=%v truncated=%v", c.Title, res.ExitCode, res.Duration.Round(1e6), stdout.Len(), res.TimedOut, res.Truncated)
				if s := strings.TrimSpace(stderr.String()); s != "" {
					t.Logf("stderr: %s", firstLines(s, 6))
				}
				failed := res.Err != nil || res.TimedOut || res.ExitCode != 0
				if c.Format == "json" && !failed {
					if !parsesAsJSON(stdout.String()) {
						t.Logf("stdout: %s", firstLines(stdout.String(), 6))
						if !c.Optional {
							t.Errorf("%s: output is not JSON", c.ID)
						}
					}
				}
				if failed && !c.Optional {
					t.Logf("stdout: %s", firstLines(stdout.String(), 10))
					t.Errorf("%s: required check failed (exit %d, timedOut %v, err %v)", c.ID, res.ExitCode, res.TimedOut, res.Err)
				}
			})
		}
	}
}

func parsesAsJSON(s string) bool {
	s = strings.TrimSpace(strings.TrimPrefix(s, "\uFEFF"))
	if json.Valid([]byte(s)) {
		return true
	}
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		l := strings.TrimSpace(lines[i])
		if (strings.HasPrefix(l, "{") || strings.HasPrefix(l, "[")) && json.Valid([]byte(l)) {
			return true
		}
	}
	return false
}

func firstLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = append(lines[:n], "…")
	}
	return strings.Join(lines, " | ")
}
