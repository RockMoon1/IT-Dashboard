package executor

import (
	"regexp"
	"sort"
	"strings"
)

/*
  Windows PowerShell finds a command it has not loaded by searching every module on its module
  path, with the help of a per-account analysis cache that it validates against each module's
  last-write time in local time. A time zone change invalidates every entry, and short-lived
  processes (scan checks, action phases) never manage to save a whole new cache, so after a
  change, or with a cold cache, each process spent 11 to 20 seconds searching (measured on CI
  runners). Importing the modules a script uses by their full path skips the search entirely and
  stays at 0.2 s in every state; it also fixes which module files run, whatever the module path
  says. Commands not in this table still load the usual way.
*/

// alwaysImported are the modules almost every script uses (Get-ItemProperty, Select-Object, …).
var alwaysImported = []string{"Microsoft.PowerShell.Management", "Microsoft.PowerShell.Utility"}

// moduleOf maps a command (lower case) to the module folder under $PSHOME\Modules that has it.
// Defender commands live in ConfigDefender on current Windows and in Defender on older builds.
var moduleOf = func() map[string][]string {
	m := map[string][]string{}
	add := func(mods []string, cmds ...string) {
		for _, c := range cmds {
			m[strings.ToLower(c)] = mods
		}
	}
	one := func(mod string, cmds ...string) { add([]string{mod}, cmds...) }
	one("CimCmdlets", "Get-CimInstance", "Invoke-CimMethod", "Get-CimClass", "Get-CimAssociatedInstance",
		"New-CimSession", "Remove-CimSession", "Set-CimInstance")
	one("Microsoft.PowerShell.Diagnostics", "Get-WinEvent", "Get-Counter")
	one("Microsoft.PowerShell.LocalAccounts", "Get-LocalGroupMember", "Get-LocalUser", "Get-LocalGroup")
	one("Microsoft.PowerShell.Security", "Get-Acl", "Set-Acl", "Get-AuthenticodeSignature", "Get-ExecutionPolicy")
	one("NetSecurity", "Get-NetFirewallProfile", "Set-NetFirewallProfile", "Get-NetFirewallRule",
		"Set-NetFirewallRule", "Get-NetFirewallPortFilter", "Get-NetFirewallApplicationFilter")
	one("NetTCPIP", "Get-NetIPAddress", "Get-NetRoute", "Get-NetTCPConnection", "Get-NetIPConfiguration",
		"Get-NetUDPEndpoint", "Get-NetIPInterface", "Test-NetConnection")
	one("NetAdapter", "Get-NetAdapter", "Get-NetAdapterStatistics", "Get-NetAdapterAdvancedProperty")
	one("NetConnection", "Get-NetConnectionProfile")
	one("DnsClient", "Clear-DnsClientCache", "Get-DnsClientCache", "Get-DnsClientServerAddress",
		"Resolve-DnsName", "Get-DnsClient")
	one("Storage", "Get-PhysicalDisk", "Get-StorageReliabilityCounter", "Get-Volume", "Get-Disk", "Get-Partition")
	one("PnpDevice", "Get-PnpDevice", "Get-PnpDeviceProperty")
	one("BitLocker", "Get-BitLockerVolume")
	one("SmbShare", "Get-SmbServerConfiguration", "Get-SmbShare", "Get-SmbConnection")
	one("SecureBoot", "Confirm-SecureBootUEFI")
	one("Appx", "Get-AppxPackage")
	one("ScheduledTasks", "Get-ScheduledTask", "Get-ScheduledTaskInfo")
	one("PrintManagement", "Get-Printer", "Get-PrintJob")
	add([]string{"ConfigDefender", "Defender"}, "Get-MpComputerStatus", "Get-MpPreference", "Set-MpPreference",
		"Add-MpPreference", "Remove-MpPreference", "Get-MpThreat", "Get-MpThreatDetection", "Start-MpScan",
		"Update-MpSignature")
	return m
}()

var commandWord = regexp.MustCompile(`[A-Za-z]+-[A-Za-z][A-Za-z0-9]*`)

// modulesFor lists the modules to import for a script: the always-imported ones, then those
// whose commands the script names, each once, in a stable order.
func modulesFor(script string) []string {
	seen := map[string]bool{}
	out := append([]string(nil), alwaysImported...)
	for _, m := range alwaysImported {
		seen[m] = true
	}
	var extra []string
	for _, w := range commandWord.FindAllString(script, -1) {
		for _, m := range moduleOf[strings.ToLower(w)] {
			if !seen[m] {
				seen[m] = true
				extra = append(extra, m)
			}
		}
	}
	sort.Strings(extra)
	return append(out, extra...)
}

// importLines is the PowerShell that loads those modules by full path before the script runs.
// A module this version of Windows lacks is skipped quietly; its commands then load as usual.
func importLines(script string) string {
	var b strings.Builder
	for _, m := range modulesFor(script) {
		b.WriteString(`Import-Module -Name "$PSHOME\Modules\` + m + `" -ErrorAction SilentlyContinue` + "\n")
	}
	return b.String()
}
