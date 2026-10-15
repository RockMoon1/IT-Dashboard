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

func TestEncodeCommandIsUTF16LE(t *testing.T) {
	if got := EncodeCommand("A✓"); got != "QQATJw==" {
		t.Fatalf("EncodeCommand = %s", got)
	}
}
