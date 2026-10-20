package executor

import (
	"reflect"
	"strings"
	"testing"
)

func TestModulesForAScript(t *testing.T) {
	for _, c := range []struct {
		script string
		want   []string
	}{
		{"exit 0", []string{"Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility"}},
		{"Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object Enabled",
			[]string{"Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "NetSecurity"}},
		{"$s = get-mpcomputerstatus; Get-CimInstance Win32_OperatingSystem; Get-MpPreference",
			[]string{"Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility", "CimCmdlets", "ConfigDefender", "Defender"}},
		{"Add-ArhNote 'ARH-FD01 Real-Time x-y'", []string{"Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility"}},
	} {
		if got := modulesFor(c.script); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: %v, want %v", c.script, got, c.want)
		}
	}
	lines := importLines("Clear-DnsClientCache")
	if !strings.Contains(lines, `Import-Module -Name "$PSHOME\Modules\DnsClient" -ErrorAction SilentlyContinue`) {
		t.Fatalf("import lines:\n%s", lines)
	}
}
