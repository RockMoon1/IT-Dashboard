// Package executor runs one allowlisted check and streams its output with a size cap and timeout.
package executor

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// MaxOutput caps the bytes forwarded per check (stdout and stderr together).
const MaxOutput = 1 << 20

// waitDelay bounds how long the output is still read once the shell has ended, while a process
// it started in the background holds it. After a timeout or abort it is also how long Wait waits
// for the stopped shell to end before it kills it.
const waitDelay = 2 * time.Second

// maxChunk bounds one forwarded chunk, so that even fully escaped it fits in one protocol line.
const maxChunk = 32 << 10

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
	Stopped   bool // ctx was cancelled before the shell ended, so it was killed (or never started)
	Truncated bool
	Duration  time.Duration
	Err       error
}

// Output receives chunks as they arrive. Chunks never split a UTF-8 sequence, whatever its
// length and wherever a read of the pipe ended in it; bytes that are not UTF-8 are passed on as
// they are. It may be called from two goroutines (stdout and stderr) concurrently.
type Output func(stream string, chunk []byte)

// stream is one of the child's outputs. It is read as fast as the child writes it and forwarded
// from a goroutine of its own, so a slow Output (a congested link) never holds the reading back:
// the pipe is read to its end as soon as the last process holding it closes it, and a cut drops
// only what a process still running writes after it.
type stream struct {
	name      string
	r, w      *os.File // w is the child's end, closed here once the child has its own copy
	out       Output
	total     *int64
	truncated *atomic.Bool
	read      chan struct{} // closed when the reading has stopped
	sent      chan struct{} // closed when everything read has been forwarded

	mu      sync.Mutex
	more    *sync.Cond
	queued  []byte // read, within the cap, not forwarded yet; whole UTF-8 sequences only
	partial []byte // the start of a UTF-8 sequence that the next read completes
	ended   bool   // the reading has stopped, so nothing more is queued
}

func newStream(name string, out Output, total *int64, truncated *atomic.Bool) (*stream, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	s := &stream{name: name, r: r, w: w, out: out, total: total, truncated: truncated, read: make(chan struct{}), sent: make(chan struct{})}
	s.more = sync.NewCond(&s.mu)
	return s, nil
}

func (s *stream) start() {
	go s.readAll()
	go s.forward()
}

// readAll reads until every process holding the pipe has closed it, or until cut closes it.
func (s *stream) readAll() {
	defer close(s.read)
	defer s.r.Close()
	buf := make([]byte, maxChunk)
	for {
		n, err := s.r.Read(buf)
		s.add(buf[:n], err != nil)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				s.truncated.Store(true)
			}
			return
		}
	}
}

// cut stops a reading that has not reached the end: what is written to the pipe from now on is
// not collected.
func (s *stream) cut() {
	select {
	case <-s.read:
		return
	default:
	}
	s.truncated.Store(true)
	s.r.Close()
	<-s.read
}

// readOrCut waits until every stream has been read to its end, but for d at most: then it cuts
// what is left.
func readOrCut(streams []*stream, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	for _, s := range streams {
		select {
		case <-s.read:
		case <-timer.C:
			for _, s := range streams {
				s.cut()
			}
		}
	}
}

// add queues what was read, holding back an incomplete UTF-8 sequence at the end until the next
// read (or until the last one).
func (s *stream) add(p []byte, last bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.partial = append(s.partial, p...)
	cut := len(s.partial)
	if !last {
		cut -= incompleteTail(s.partial)
	}
	if cut > 0 {
		if atomic.AddInt64(s.total, int64(cut)) <= MaxOutput {
			s.queued = append(s.queued, s.partial[:cut]...)
		} else {
			s.truncated.Store(true)
		}
		s.partial = append(s.partial[:0], s.partial[cut:]...)
	}
	s.ended = last
	s.more.Signal()
}

// incompleteTail gives how many bytes at the end of b (0 to UTFMax-1) start a UTF-8 sequence
// that more bytes can still complete: from its lead byte, the last one that is not a
// continuation byte, to the end. A trailing continuation byte is not checked alone, since it
// would pass for a whole (invalid) rune.
func incompleteTail(b []byte) int {
	for i := len(b) - 1; i >= 0 && i > len(b)-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			if utf8.FullRune(b[i:]) {
				return 0
			}
			return len(b) - i
		}
	}
	return 0 // no lead byte close enough to the end: whole, or not UTF-8
}

// forward hands what was queued to Output, at most maxChunk bytes at a time, until the reading
// has stopped and nothing is left.
func (s *stream) forward() {
	defer close(s.sent)
	for {
		s.mu.Lock()
		for len(s.queued) == 0 && !s.ended {
			s.more.Wait()
		}
		if len(s.queued) == 0 {
			s.mu.Unlock()
			return
		}
		n := runeCut(s.queued, maxChunk)
		chunk := s.queued[:n:n]
		if s.queued = s.queued[n:]; len(s.queued) == 0 {
			s.queued = nil
		}
		s.mu.Unlock()
		s.out(s.name, chunk)
	}
}

// runeCut gives a length of at most n at which b can be cut without splitting a UTF-8 sequence.
func runeCut(b []byte, n int) int {
	if len(b) <= n {
		return len(b)
	}
	for i := n; i > n-utf8.UTFMax; i-- {
		if utf8.RuneStart(b[i]) {
			return i
		}
	}
	return n // not UTF-8 there, so any cut will do
}

// Run executes the check and blocks until it finishes, times out or ctx is cancelled, and its
// output has been forwarded.
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
	stdout, err := newStream("stdout", out, &total, &truncated)
	var stderr *stream
	if err == nil {
		if stderr, err = newStream("stderr", out, &total, &truncated); err != nil {
			stdout.r.Close()
			stdout.w.Close()
		}
	}
	if err != nil {
		h.done()
		return Result{ExitCode: -1, Duration: time.Since(started), Err: err}
	}
	streams := []*stream{stdout, stderr}
	// The child gets the pipes themselves (os.File), so Wait returns when the shell has ended
	// and the reading below decides how long its output is waited for.
	cmd.Stdout = stdout.w
	cmd.Stderr = stderr.w
	cmd.WaitDelay = waitDelay

	runErr := cmd.Start()
	for _, s := range streams {
		s.w.Close() // the child has its own copy, if it started
	}
	res := Result{Started: runErr == nil}
	if res.Started {
		for _, s := range streams {
			s.start()
		}
		h.afterStart()
		runErr = cmd.Wait()
		// Wait gives ErrWaitDelay only for a shell that exited 0 on its own while the script was
		// still being fed to it on standard input (Windows); its output is read below, not by Wait.
		if errors.Is(runErr, exec.ErrWaitDelay) {
			runErr = nil
		}
	}
	// whether a timeout or abort stopped the shell (or kept it from starting); one that comes
	// while its output is still read below does not change how it ended
	runDone, ctxDone := runCtx.Err(), ctx.Err()
	if res.Started {
		// A process the shell started in the background (`nohup … &`) may still hold its output.
		// The shell's exit status stands, whatever it is; that output is read for waitDelay more
		// and then cut, marked truncated. The process itself is left running.
		readOrCut(streams, waitDelay)
	} else {
		for _, s := range streams {
			s.r.Close()
		}
	}
	h.done()
	if res.Started {
		for _, s := range streams {
			<-s.sent
		}
	}

	res.Duration, res.Truncated = time.Since(started), truncated.Load()
	if errors.Is(runDone, context.DeadlineExceeded) {
		res.TimedOut = true
	}
	res.Stopped = errors.Is(ctxDone, context.Canceled)
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			res.ExitCode = exitErr.ExitCode()
		} else {
			res.ExitCode = -1
			res.Err = runErr
		}
	}
	if (res.TimedOut || res.Stopped) && res.ExitCode == 0 {
		res.ExitCode = -1
	}
	return res
}
