package link

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/RockMoon1/IT-Dashboard/actions"
)

const (
	runsFile   = "runs.json"
	keepRunIDs = 500
	keepOutbox = 50
)

// interruptedNote is the error on a run the agent was stopped in the middle of.
const interruptedNote = "the agent stopped before this run finished (the computer shut down or restarted, or the agent was stopped); nothing after that point was measured"

// runJournal remembers the last run ids (so a repeated request never runs twice), what is running
// now, and every result until the dashboard acknowledges it (so a result survives a pulled
// cable, and a run cut short by a shutdown still reports what is known).
type runJournal struct {
	path string
	mu   sync.Mutex
	data struct {
		IDs     []string         `json:"ids"`
		Running []actions.Result `json:"running,omitempty"`
		Outbox  []actions.Result `json:"outbox"`
	}
}

func openJournal(dataDir string) *runJournal {
	j := &runJournal{path: filepath.Join(dataDir, runsFile)}
	if b, err := os.ReadFile(j.path); err == nil {
		_ = json.Unmarshal(b, &j.data)
	}
	return j
}

// recover turns every run a previous agent process left running into an interrupted result in
// the outbox. Only a new process calls it: nothing of the old one is still running then.
func (j *runJournal) recover(endedAt string) []actions.Result {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.data.Running) == 0 {
		return nil
	}
	var done []actions.Result
	for _, r := range j.data.Running {
		r.Aborted, r.EndedAt, r.Error = true, endedAt, interruptedNote
		if !r.Applied && r.Skipped == "" {
			r.Skipped = "the agent stopped before any change"
		}
		done = append(done, r)
	}
	j.data.Running = nil
	j.data.Outbox = append(j.data.Outbox, done...)
	if len(j.data.Outbox) > keepOutbox {
		j.data.Outbox = j.data.Outbox[len(j.data.Outbox)-keepOutbox:]
	}
	_ = j.saveLocked()
	return done
}

// running records (or updates) what is known of a run that has not finished.
func (j *runJournal) running(r actions.Result) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.data.Running = append(without(j.data.Running, r.RunID), r)
	return j.saveLocked()
}

func without(list []actions.Result, id string) []actions.Result {
	out := list[:0:0]
	for _, x := range list {
		if x.RunID != id {
			out = append(out, x)
		}
	}
	return out
}

// claim records a run id before the run starts. It reports false for an id already used.
func (j *runJournal) claim(id string) (bool, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, x := range j.data.IDs {
		if x == id {
			return false, nil
		}
	}
	j.data.IDs = append(j.data.IDs, id)
	if len(j.data.IDs) > keepRunIDs {
		j.data.IDs = j.data.IDs[len(j.data.IDs)-keepRunIDs:]
	}
	return true, j.saveLocked()
}

// put stores (or replaces) a finished run's result in the outbox.
func (j *runJournal) put(r actions.Result) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.data.Running = without(j.data.Running, r.RunID)
	out := append(without(j.data.Outbox, r.RunID), r)
	if len(out) > keepOutbox {
		out = out[len(out)-keepOutbox:]
	}
	j.data.Outbox = out
	return j.saveLocked()
}

func (j *runJournal) ack(id string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.data.Outbox = without(j.data.Outbox, id)
	return j.saveLocked()
}

func (j *runJournal) outbox() []actions.Result {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]actions.Result(nil), j.data.Outbox...)
}

func (j *runJournal) find(id string) (actions.Result, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, x := range j.data.Outbox {
		if x.RunID == id {
			return x, true
		}
	}
	return actions.Result{}, false
}

func (j *runJournal) saveLocked() error {
	b, err := json.Marshal(j.data)
	if err != nil {
		return err
	}
	tmp := j.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, j.path)
}
