//go:build !windows

package executor

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"

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
	if res := Run(stopped, check, out); res.Started || !res.Stopped || res.ExitCode != -1 || res.Err == nil {
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

// A shell that exits while a process it started in the background still holds its output keeps
// its exit status, whatever it is, also when its timeout passes while the output is waited for.
// The output is cut 2 s after the shell ended, with truncated set at any exit status, and the
// process is left running (a technician may start a daemon on purpose).
func TestRunBackgroundChildKeepsTheExitStatus(t *testing.T) {
	for _, code := range []int{0, 4} {
		for _, timeout := range []int{10, 1} {
			pidFile := filepath.Join(t.TempDir(), "pid")
			out, so, _ := collect()
			res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: timeout, Command: []string{
				"sleep 30 &", "echo $! > '" + pidFile + "'", "echo started", "exit " + strconv.Itoa(code)}}, out)
			b, _ := os.ReadFile(pidFile)
			pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
			if err != nil {
				t.Fatalf("exit %d, timeout %d: no pid: %v", code, timeout, err)
			}
			alive := syscall.Kill(pid, 0) == nil
			_ = syscall.Kill(pid, syscall.SIGKILL)
			if !res.Started || res.ExitCode != code || res.TimedOut || res.Err != nil || !res.Truncated || so.String() != "started\n" {
				t.Fatalf("exit %d, timeout %d: %+v stdout %q", code, timeout, res, so.String())
			}
			if res.Duration < waitDelay || res.Duration > waitDelay+3*time.Second {
				t.Fatalf("exit %d, timeout %d: output waited for %v, want about %v", code, timeout, res.Duration, waitDelay)
			}
			if !alive {
				t.Fatalf("exit %d, timeout %d: the background process was killed", code, timeout)
			}
		}
	}
}

// A cancel (an abort) while the shell runs kills it and says so; one once the shell has exited
// on its own, while a process it left in the background holds its output, stops nothing.
func TestRunStoppedOnlyWhileTheShellRuns(t *testing.T) {
	for _, tc := range []struct {
		script  []string
		stopped bool
		code    int
	}{{[]string{"sleep 30"}, true, -1}, {[]string{"sleep 5 &", "exit 0"}, false, 0}} {
		ctx, stop := context.WithCancel(context.Background())
		time.AfterFunc(500*time.Millisecond, stop)
		out, _, _ := collect()
		res := Run(ctx, profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: 10, Command: tc.script}, out)
		stop()
		if res.Stopped != tc.stopped || res.ExitCode != tc.code || res.TimedOut || res.Duration > waitDelay+3*time.Second {
			t.Fatalf("%q: %+v", tc.script, res)
		}
	}
}

// A process left in the background that ends within the 2 s after the shell has its output
// collected in full, and nothing is marked truncated.
func TestRunBackgroundChildThatEndsSoonIsCollected(t *testing.T) {
	for _, code := range []int{0, 4} {
		out, so, _ := collect()
		res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: 10, Command: []string{
			"(sleep 1; echo late) &", "echo early", "exit " + strconv.Itoa(code)}}, out)
		if res.ExitCode != code || res.TimedOut || res.Err != nil || res.Truncated || so.String() != "early\nlate\n" {
			t.Fatalf("exit %d: %+v stdout %q", code, res, so.String())
		}
	}
}

// slowOutput collects stdout like collect, but its first call blocks for block, as a congested
// link to the dashboard does. Every chunk is kept to check its size and encoding.
func slowOutput(block time.Duration) (Output, func() ([][]byte, string)) {
	var mu sync.Mutex
	var chunks [][]byte
	var all strings.Builder
	first := true
	return func(stream string, chunk []byte) {
			mu.Lock()
			wait := first
			first = false
			mu.Unlock()
			if wait {
				time.Sleep(block)
			}
			mu.Lock()
			defer mu.Unlock()
			if stream == "stdout" {
				chunks = append(chunks, append([]byte(nil), chunk...))
				all.Write(chunk)
			}
		}, func() ([][]byte, string) {
			mu.Lock()
			defer mu.Unlock()
			return chunks, all.String()
		}
}

// Output the shell wrote before it exited is forwarded in full when the consumer is slow (a
// congested link): a slow consumer is not a process holding the output, so nothing is cut and
// nothing is marked truncated.
func TestRunSlowConsumerGetsAllTheOutput(t *testing.T) {
	out, got := slowOutput(waitDelay + time.Second)
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: 20, Command: []string{
		"echo start", "sleep 0.2", `head -c 12000 /dev/zero | tr '\0' a`, "exit 0"}}, out)
	_, stdout := got()
	want := "start\n" + strings.Repeat("a", 12000)
	if res.ExitCode != 0 || res.TimedOut || res.Err != nil || res.Truncated || stdout != want {
		t.Fatalf("%+v: got %d of %d bytes", res, len(stdout), len(want))
	}
}

// Output that piles up behind a slow consumer is forwarded in chunks of at most maxChunk bytes
// (each well inside one protocol line), never splitting a UTF-8 sequence.
func TestRunForwardsBoundedWholeRuneChunks(t *testing.T) {
	out, got := slowOutput(500 * time.Millisecond)
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: 20, Command: []string{
		"echo start", "sleep 0.2", "yes é | head -n 100000"}}, out)
	chunks, stdout := got()
	if res.ExitCode != 0 || res.Truncated || stdout != "start\n"+strings.Repeat("é\n", 100000) {
		t.Fatalf("%+v: got %d bytes", res, len(stdout))
	}
	for i, c := range chunks {
		if len(c) > maxChunk || !utf8.Valid(c) {
			t.Fatalf("chunk %d of %d: %d bytes, valid UTF-8 %v", i, len(chunks), len(c), utf8.Valid(c))
		}
	}
}

// A character whose bytes reach the pipe in two writes (so two reads) is forwarded whole, for
// 2-, 3- and 4-byte sequences cut after any of their bytes: no chunk handed to Output is invalid
// UTF-8, which the agent would otherwise send on as U+FFFD.
func TestRunNeverForwardsAPartOfACharacter(t *testing.T) {
	var mu sync.Mutex
	var chunks [][]byte
	out := func(stream string, chunk []byte) {
		mu.Lock()
		defer mu.Unlock()
		chunks = append(chunks, append([]byte(nil), chunk...))
	}
	var lines []string
	var want strings.Builder
	for _, r := range []string{"é", "’", "😀"} {
		for k := 1; k < len(r); k++ {
			lines = append(lines, "printf 'ab"+octal(r[:k])+"'", "sleep 0.1", "printf '"+octal(r[k:])+"\\n'", "sleep 0.1")
			want.WriteString("ab" + r + "\n")
		}
	}
	res := Run(context.Background(), profiles.Check{ID: "t", Shell: "sh", TimeoutSeconds: 20, Command: lines}, out)
	mu.Lock()
	defer mu.Unlock()
	var all strings.Builder
	for i, c := range chunks {
		if !utf8.Valid(c) {
			t.Errorf("chunk %d of %d is not valid UTF-8: %q", i, len(chunks), c)
		}
		all.Write(c)
	}
	if res.ExitCode != 0 || res.Truncated || all.String() != want.String() {
		t.Fatalf("%+v: stdout %q, want %q", res, all.String(), want.String())
	}
}

// octal spells b for printf, one \ooo escape per byte.
func octal(b string) string {
	var s strings.Builder
	for i := 0; i < len(b); i++ {
		s.WriteString("\\" + strconv.FormatInt(int64(b[i]), 8))
	}
	return s.String()
}
