// Package executor runs one allowlisted check and streams its output with a size cap and timeout.
package executor

import (
	"context"
	"errors"
	"os/exec"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// MaxOutput caps the bytes forwarded per check (stdout and stderr together).
const MaxOutput = 1 << 20

// waitDelay bounds how long Wait waits for the child's pipes after the process is gone.
const waitDelay = 2 * time.Second

// hooks are the platform's steps around one process: afterStart runs once it has started (put
// it in a Job Object, feed it the script), done after it has ended or failed to start.
type hooks struct {
	afterStart func()
	done       func()
}

type Result struct {
	Started   bool // the process started; false means nothing ran (refused, or ctx was done first)
	ExitCode  int
	TimedOut  bool
	Truncated bool
	Duration  time.Duration
	Err       error
}

// Output receives chunks as they arrive. Chunks never split a UTF-8 sequence. It may be called
// from two goroutines (stdout and stderr) concurrently.
type Output func(stream string, chunk []byte)

type streamWriter struct {
	name      string
	out       Output
	total     *int64
	truncated *atomic.Bool
	pending   []byte
}

func (w *streamWriter) Write(p []byte) (int, error) {
	w.pending = append(w.pending, p...)
	cut := len(w.pending)
	for cut > 0 && cut > len(w.pending)-4 && !utf8.FullRune(w.pending[cut-1:]) {
		cut--
	}
	w.emit(w.pending[:cut])
	w.pending = append([]byte(nil), w.pending[cut:]...)
	return len(p), nil
}

func (w *streamWriter) emit(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	if atomic.AddInt64(w.total, int64(len(chunk))) <= MaxOutput {
		w.out(w.name, chunk)
	} else {
		w.truncated.Store(true)
	}
}

func (w *streamWriter) flush() {
	w.emit(w.pending)
	w.pending = nil
}

// Run executes the check and blocks until it finishes, times out or ctx is cancelled.
func Run(ctx context.Context, check profiles.Check, out Output) Result {
	started := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, check.Timeout())
	defer cancel()

	cmd, h, err := command(runCtx, check)
	if err != nil {
		return Result{ExitCode: -1, Duration: time.Since(started), Err: err}
	}
	var total int64
	var truncated atomic.Bool
	stdout := &streamWriter{name: "stdout", out: out, total: &total, truncated: &truncated}
	stderr := &streamWriter{name: "stderr", out: out, total: &total, truncated: &truncated}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.WaitDelay = waitDelay

	runErr := cmd.Start()
	res := Result{Started: runErr == nil}
	if res.Started {
		h.afterStart()
		runErr = cmd.Wait()
	}
	h.done()
	stdout.flush()
	stderr.flush()

	res.Duration, res.Truncated = time.Since(started), truncated.Load()
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		res.TimedOut = true
	}
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			res.ExitCode = exitErr.ExitCode()
		} else {
			res.ExitCode = -1
			res.Err = runErr
		}
	}
	if (res.TimedOut || errors.Is(ctx.Err(), context.Canceled)) && res.ExitCode == 0 {
		res.ExitCode = -1
	}
	return res
}
