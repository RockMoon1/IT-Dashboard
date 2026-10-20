// Package audit is the device's own record of every action and custom command: an intent line
// written before the process starts (so a restart or a killed agent still leaves one), and an
// outcome line after. Records go to actions.log in the data folder, rotated at 5 files of 5 MiB,
// and to the operating system's log (Windows Application log, syslog elsewhere). Output is never
// recorded, only what was asked, by whom, why, and the measured result.
package audit

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	FileName = "actions.log"
	maxSize  = 5 << 20
	keep     = 5
)

type Log struct {
	dir string
	mu  sync.Mutex
	os  osLog
}

func Open(dataDir string) *Log { return &Log{dir: dataDir, os: openOSLog()} }

// Record appends one JSON line with the time added. event is "intent" or "outcome".
func (l *Log) Record(event string, fields map[string]any) error {
	if l == nil {
		return nil
	}
	rec := map[string]any{"time": time.Now().UTC().Format(time.RFC3339Nano), "event": event}
	for k, v := range fields {
		rec[k] = v
	}
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rotate()
	f, err := os.OpenFile(filepath.Join(l.dir, FileName), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(append(b, '\n'))
	serr := f.Sync()
	cerr := f.Close()
	l.os.write(event, summary(rec))
	if werr != nil {
		return werr
	}
	if serr != nil {
		return serr
	}
	return cerr
}

func (l *Log) rotate() {
	p := filepath.Join(l.dir, FileName)
	info, err := os.Stat(p)
	if err != nil || info.Size() < maxSize {
		return
	}
	_ = os.Remove(fmt.Sprintf("%s.%d", p, keep-1))
	for i := keep - 2; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", p, i), fmt.Sprintf("%s.%d", p, i+1))
	}
	_ = os.Rename(p, p+".1")
}

// summary is the short line for the OS log: who, what, which run, the outcome.
func summary(rec map[string]any) string {
	pick := func(k string) string {
		if v, ok := rec[k]; ok && v != nil {
			return fmt.Sprint(v)
		}
		return ""
	}
	s := fmt.Sprintf("ARH Agent %s run %s: %s %s", pick("event"), pick("runId"), pick("kind"), pick("action"))
	for _, k := range []string{"mode", "technician", "reason", "status", "exitCode", "scriptSha256", "error"} {
		if v := pick(k); v != "" {
			s += fmt.Sprintf("; %s=%s", k, v)
		}
	}
	if len(s) > 2000 {
		s = s[:2000]
	}
	return s
}
