//go:build !windows

package executor

import (
	"context"
	"os"
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

// Started says whether the process ran at all: a cancelled run or a refused shell never starts.
func TestRunReportsWhetherItStarted(t *testing.T) {
	out, _, _ := collect()
	check := profiles.Check{ID: "t", Shell: "sh", Command: []string{"exit 3"}, TimeoutSeconds: 10}
	if res := Run(context.Background(), check, out); !res.Started || res.ExitCode != 3 {
		t.Fatalf("normal run: %+v", res)
	}
	stopped, stop := context.WithCancel(context.Background())
	stop()
	if res := Run(stopped, check, out); res.Started || res.ExitCode != -1 || res.Err == nil {
		t.Fatalf("cancelled run: %+v", res)
	}
	check.Shell = "powershell"
	if res := Run(context.Background(), check, out); res.Started {
		t.Fatalf("refused shell: %+v", res)
	}
}

// A command that reads standard input must get end of file, not the rest of the script.
func TestRunScriptIsNotSwallowedByCommandsReadingStdin(t *testing.T) {
	out, so, _ := collect()
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", Command: []string{"read line || true", `echo "line=[$line]"`, "cat", "echo after"}, TimeoutSeconds: 10}, out)
	if res.ExitCode != 0 || so.String() != "line=[]\nafter\n" {
		t.Fatalf("exit %d stdout %q", res.ExitCode, so.String())
	}
}

// Scripts larger than a pipe buffer still arrive whole.
func TestRunLongScript(t *testing.T) {
	out, so, _ := collect()
	lines := make([]string, 0, 5001)
	for i := 0; i < 5000; i++ {
		lines = append(lines, ": "+strings.Repeat("x", 40))
	}
	lines = append(lines, "echo done")
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", Command: lines, TimeoutSeconds: 20}, out)
	if res.ExitCode != 0 || so.String() != "done\n" {
		t.Fatalf("exit %d stdout %q", res.ExitCode, so.String())
	}
}

func TestRunCleanEnvAndFixedPath(t *testing.T) {
	t.Setenv("ARH_PARAM_NAME", "inherited")
	t.Setenv("ARH_DRY_RUN", "0")
	out, so, _ := collect()
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: 10, CleanEnv: true, FixedPath: true,
		Env:     []string{"ARH_PHASE=measure"},
		Command: []string{`echo "name=[${ARH_PARAM_NAME:-}] dry=[${ARH_DRY_RUN:-}] phase=[$ARH_PHASE] path=[$PATH] pwd=[$(pwd)]"`}}, out)
	want := "name=[] dry=[] phase=[measure] path=[/usr/sbin:/usr/bin:/sbin:/bin] pwd=[/]\n"
	if res.ExitCode != 0 || so.String() != want {
		t.Fatalf("exit %d stdout %q, want %q", res.ExitCode, so.String(), want)
	}
	// without CleanEnv a scan keeps the agent's environment, as before
	out, so, _ = collect()
	Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: 10, Command: []string{`echo "$ARH_PARAM_NAME"`}}, out)
	if so.String() != "inherited\n" {
		t.Fatalf("scan env changed: %q", so.String())
	}
}

// A timeout ends every process the script started, not only the shell.
func TestRunTimeoutKillsGrandchildren(t *testing.T) {
	out, _, _ := collect()
	marker := t.TempDir() + "/alive"
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: 1, Command: []string{
		"(sleep 3; touch '" + marker + "') &", "sleep 30"}}, out)
	if !res.TimedOut {
		t.Fatalf("expected timeout, got %+v", res)
	}
	time.Sleep(3500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a grandchild survived the timeout")
	}
}
