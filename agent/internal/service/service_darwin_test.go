package service

import (
	"strconv"
	"strings"
	"testing"
)

// launchd waits longer than the agent's drain before it sends SIGKILL.
func TestPlistLetsTheAgentDrain(t *testing.T) {
	p := plist(DefaultLayout())
	if want := "<key>ExitTimeOut</key><integer>" + strconv.Itoa(StopSeconds) + "</integer>"; !strings.Contains(p, want) {
		t.Errorf("plist has no %s:\n%s", want, p)
	}
}
