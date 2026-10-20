package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
)

const taskName = "ARH Agent"
const ruleName = "ARH Agent beacon (UDP 47911)"

func defaultLayout() Layout {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	install := filepath.Join(pf, "ARH Agent")
	data := filepath.Join(pd, "ARH Agent")
	return Layout{InstallDir: install, ExePath: filepath.Join(install, "arh-agent.exe"), DataDir: data, LogPath: filepath.Join(data, "agent.log")}
}

// registerScript creates a SYSTEM task at startup. schtasks.exe /Create cannot clear the default
// 72-hour execution time limit, which would stop the agent after three days, so the task is
// registered through the ScheduledTasks module with an unlimited limit, restart-on-failure and
// battery settings that keep a laptop agent running unplugged. The executable path arrives in
// the environment so no quoting is needed.
const registerScript = `
$ErrorActionPreference = 'Stop'
$a = New-ScheduledTaskAction -Execute $env:ARH_EXE -Argument 'run'
$t = New-ScheduledTaskTrigger -AtStartup
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $env:ARH_TASK -Action $a -Trigger $t -Principal $p -Settings $s -Description 'ARH IT Dashboard read-only diagnostics agent' -Force | Out-Null
Start-ScheduledTask -TaskName $env:ARH_TASK
`

func powershell(script string, env ...string) (string, error) {
	cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), &runError{name: "powershell register task", err: err, out: string(out)}
	}
	return string(out), nil
}

type runError struct {
	name string
	err  error
	out  string
}

func (e *runError) Error() string { return e.name + ": " + e.err.Error() + ": " + e.out }

func register(l Layout) error {
	_, err := powershell(registerScript, "ARH_EXE="+l.ExePath, "ARH_TASK="+taskName)
	return err
}

func stop(l Layout) error {
	_, _ = run("schtasks.exe", "/End", "/TN", taskName)
	_, _ = run("taskkill.exe", "/IM", "arh-agent.exe", "/F")
	return nil
}

func unregister(l Layout) error {
	_ = stop(l)
	_, err := run("schtasks.exe", "/Delete", "/TN", taskName, "/F")
	return err
}

func firewallAllow(l Layout) error {
	_, _ = run("netsh.exe", "advfirewall", "firewall", "delete", "rule", "name="+ruleName)
	_, err := run("netsh.exe", "advfirewall", "firewall", "add", "rule", "name="+ruleName, "dir=in", "action=allow",
		"protocol=UDP", "localport="+strconv.Itoa(BeaconPort), "program="+l.ExePath, "enable=yes", "profile=any")
	return err
}

func firewallRemove(l Layout) error {
	_, err := run("netsh.exe", "advfirewall", "firewall", "delete", "rule", "name="+ruleName)
	return err
}

// restrictDataDir gives the folder and everything in it to SYSTEM and leaves only SYSTEM and
// Administrators (well-known SIDs) with access; what is inside inherits that and nothing else.
func restrictDataDir(l Layout) error {
	if _, err := run("icacls.exe", l.DataDir, "/setowner", "*S-1-5-18", "/T", "/C", "/Q"); err != nil {
		return err
	}
	if _, err := run("icacls.exe", l.DataDir, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"); err != nil {
		return err
	}
	// explicit entries on files inside go; an empty folder has nothing to reset
	_, _ = run("icacls.exe", filepath.Join(l.DataDir, "*"), "/reset", "/T", "/C", "/Q")
	return nil
}
