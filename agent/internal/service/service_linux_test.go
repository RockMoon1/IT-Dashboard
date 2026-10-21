package service

import (
	"strconv"
	"strings"
	"testing"
)

// SIGTERM reaches the agent alone, so its drain decides how long a running change or custom
// command gets, and systemd waits longer than that drain before it kills anything.
func TestUnitLetsTheAgentDrain(t *testing.T) {
	u := unit(DefaultLayout())
	for _, want := range []string{"\nKillMode=mixed\n", "\nTimeoutStopSec=" + strconv.Itoa(StopSeconds) + "\n"} {
		if !strings.Contains(u, want) {
			t.Errorf("unit has no %q:\n%s", strings.TrimSpace(want), u)
		}
	}
}
