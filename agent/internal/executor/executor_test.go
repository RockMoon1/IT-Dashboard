//go:build !windows

package executor

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

func collect() (Output, *strings.Builder, *strings.Builder) {
	var so, se strings.Builder
	return func(stream string, chunk []byte) {
		if stream == "stdout" {
			so.Write(chunk)
		} else {
			se.Write(chunk)
		}
	}, &so, &se
}

func TestRunStreamsStdoutAndStderrAndExitCode(t *testing.T) {
	out, so, se := collect()
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", Command: []string{"echo héllo", "echo oops 1>&2", "exit 3"}, TimeoutSeconds: 10}, out)
	if res.ExitCode != 3 || res.TimedOut || res.Err != nil {
		t.Fatalf("unexpected result %+v", res)
	}
	if so.String() != "héllo\n" || se.String() != "oops\n" {
		t.Fatalf("stdout %q stderr %q", so.String(), se.String())
	}
}

func TestRunTimesOut(t *testing.T) {
	out, _, _ := collect()
	start := time.Now()
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", Command: []string{"sleep 5"}, TimeoutSeconds: 1}, out)
	if !res.TimedOut {
		t.Fatalf("expected timeout, got %+v", res)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("timeout took too long")
	}
}

func TestRunCapsOutput(t *testing.T) {
	out, so, _ := collect()
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", Command: []string{"head -c 1500000 /dev/zero | tr '\\0' 'a'"}, TimeoutSeconds: 20}, out)
	if !res.Truncated {
		t.Fatal("expected truncation")
	}
	if so.Len() > MaxOutput {
		t.Fatalf("forwarded %d bytes, cap is %d", so.Len(), MaxOutput)
	}
}

func TestRunRejectsWrongShell(t *testing.T) {
	out, _, _ := collect()
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "powershell", Command: []string{"Get-Date"}}, out)
	if res.Err == nil || res.ExitCode != -1 {
		t.Fatalf("expected error, got %+v", res)
	}
}
