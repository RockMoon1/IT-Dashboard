package executor

import (
	"context"
	"strings"
	"testing"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

func TestPowerShellStreamsUTF8AndExitCode(t *testing.T) {
	var so, se strings.Builder
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "powershell", TimeoutSeconds: 60, Command: []string{
		"Write-Output 'héllo ✓'",
		"[Console]::Error.WriteLine('oops')",
		"exit 3",
	}}, func(stream string, chunk []byte) {
		if stream == "stdout" {
			so.Write(chunk)
		} else {
			se.Write(chunk)
		}
	})
	if res.Err != nil || res.ExitCode != 3 || res.TimedOut {
		t.Fatalf("unexpected result %+v", res)
	}
	if strings.TrimSpace(strings.TrimPrefix(so.String(), "\uFEFF")) != "héllo ✓" {
		t.Fatalf("stdout %q", so.String())
	}
	if !strings.Contains(se.String(), "oops") {
		t.Fatalf("stderr %q", se.String())
	}
}

func TestPowerShellTimeout(t *testing.T) {
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "powershell", TimeoutSeconds: 2, Command: []string{"Start-Sleep -Seconds 30"}}, func(string, []byte) {})
	if !res.TimedOut {
		t.Fatalf("expected timeout, got %+v", res)
	}
	if res.Duration.Seconds() > 10 {
		t.Fatalf("timeout took %s", res.Duration)
	}
}

// Started says whether powershell.exe ran at all (and so was put in its Job Object).
func TestPowerShellReportsWhetherItStarted(t *testing.T) {
	check := profiles.Check{ID: "t", Shell: "powershell", TimeoutSeconds: 60, LongScript: true, Command: []string{"exit 3"}}
	if res := Run(context.Background(), check, func(string, []byte) {}); !res.Started || res.ExitCode != 3 {
		t.Fatalf("normal run: %+v", res)
	}
	stopped, stop := context.WithCancel(context.Background())
	stop()
	if res := Run(stopped, check, func(string, []byte) {}); res.Started || res.ExitCode != -1 || res.Err == nil {
		t.Fatalf("cancelled run: %+v", res)
	}
}

func TestEncodeCommandIsUTF16LE(t *testing.T) {
	if got := EncodeCommand("A✓"); got != "QQATJw==" {
		t.Fatalf("EncodeCommand = %s", got)
	}
}

// Long scripts go through standard input: 100 KB is far past the 32,767-character command line.
func TestPowerShellLongScriptAndExitCode(t *testing.T) {
	var so strings.Builder
	lines := []string{}
	for i := 0; i < 2000; i++ {
		lines = append(lines, "$null = '"+strings.Repeat("x", 50)+"'")
	}
	lines = append(lines, "Write-Output 'done ✓'", "$x = [Console]::In.ReadLine()", "Write-Output \"stdin=[$x]\"", "exit 7")
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "powershell", TimeoutSeconds: 60, LongScript: true, CleanEnv: true, FixedPath: true, Command: lines},
		func(stream string, chunk []byte) {
			if stream == "stdout" {
				so.Write(chunk)
			}
		})
	if res.Err != nil || res.ExitCode != 7 {
		t.Fatalf("unexpected result %+v, stdout %q", res, so.String())
	}
	if !strings.Contains(so.String(), "done ✓") || !strings.Contains(so.String(), "stdin=[]") {
		t.Fatalf("stdout %q", so.String())
	}
}

func TestPowerShellCleanEnv(t *testing.T) {
	t.Setenv("ARH_PARAM_NAME", "inherited")
	var so strings.Builder
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "powershell", TimeoutSeconds: 60, LongScript: true, CleanEnv: true, FixedPath: true,
		Env:     []string{"ARH_PHASE=apply"},
		Command: []string{"Write-Output \"name=[$env:ARH_PARAM_NAME] phase=[$env:ARH_PHASE] pwd=[$((Get-Location).Path)]\"", "Get-Command Get-NetFirewallProfile | Out-Null; Write-Output 'modules ok'"}},
		func(stream string, chunk []byte) {
			if stream == "stdout" {
				so.Write(chunk)
			}
		})
	out := so.String()
	if res.ExitCode != 0 || !strings.Contains(out, "name=[] phase=[apply]") || !strings.Contains(strings.ToLower(out), `\windows\system32]`) || !strings.Contains(out, "modules ok") {
		t.Fatalf("exit %d stdout %q", res.ExitCode, out)
	}
}

// The Job Object must end grandchildren on timeout: ping.exe here would otherwise run 60 s.
func TestPowerShellTimeoutKillsProcessTree(t *testing.T) {
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "powershell", TimeoutSeconds: 3, Command: []string{
		"& \"$env:SystemRoot\\System32\\PING.EXE\" -n 60 127.0.0.31 | Out-Null"}}, func(string, []byte) {})
	if !res.TimedOut {
		t.Fatalf("expected timeout, got %+v", res)
	}
	var so strings.Builder
	Run(context.Background(), profiles.Check{ID: "t", Shell: "powershell", TimeoutSeconds: 30, Command: []string{
		"Start-Sleep -Seconds 1",
		"@(Get-CimInstance Win32_Process -Filter \"Name = 'PING.EXE'\" | Where-Object { $_.CommandLine -like '*127.0.0.31*' }).Count"}},
		func(stream string, chunk []byte) {
			if stream == "stdout" {
				so.Write(chunk)
			}
		})
	if strings.TrimSpace(so.String()) != "0" {
		t.Fatalf("ping.exe survived the timeout: %q", so.String())
	}
}
