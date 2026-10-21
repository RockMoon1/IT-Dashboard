package actions

import (
	"regexp"
	"strings"
	"testing"
)

// windows-restart must count a person signed in to any session, whatever its shell (a kiosk app,
// RemoteApp's rdpshell.exe, a session whose explorer.exe stopped), or the restart goes ahead
// without the computer name typed. PowerShell is not available on every test machine, so this
// reads the script: the list comes from the owners of every process in sessions above 0, kept
// when the account's SID is a person's. The Windows live test runs it.
func TestWindowsRestartCountsEverySession(t *testing.T) {
	measure := strings.Join(shipped(t, "windows-restart").Measure, "\n")
	if !strings.Contains(measure, "Get-Process -IncludeUserName | Where-Object { $_.SessionId -gt 0 }") {
		t.Error("the session list does not come from the owners of every process in sessions above 0")
	}
	if regexp.MustCompile(`(?i)Name\s*=\s*'explorer\.exe'`).MatchString(measure) {
		t.Error("the session list still depends on explorer.exe")
	}
	if !strings.Contains(measure, "Get-Process -Name LogonUI") {
		t.Error("locked sessions are no longer found")
	}
	pats := regexp.MustCompile(`-match '(\^S-1-[^']*)'`).FindAllStringSubmatch(measure, -1)
	if len(pats) == 0 {
		t.Fatal("no pattern for a person's SID")
	}
	people := []string{"S-1-5-21-1004336348-1177238915-682003330-1001", "S-1-12-1-3580285163-1143736151-2427133113-3346405476"}
	others := []string{"S-1-5-18", "S-1-5-19", "S-1-5-20", "S-1-5-90-0-1", "S-1-5-96-0-2", "S-1-5-32-544", "S-1-5-21",
		"S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", "S-1-5-82-3006700770-424185619-1745488364-794895919-4004696415"}
	for _, p := range pats {
		re := regexp.MustCompile(p[1])
		for _, sid := range people {
			if !re.MatchString(sid) {
				t.Errorf("%s does not match a person's SID %s", p[1], sid)
			}
		}
		for _, sid := range others {
			if re.MatchString(sid) {
				t.Errorf("%s matches %s, which is not a person", p[1], sid)
			}
		}
	}
}
