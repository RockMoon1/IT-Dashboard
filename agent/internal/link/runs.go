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

// runJournal remembers the last run ids (so a repeated request never runs twice) and keeps every
// action result until the dashboard acknowledges it (so a result survives a pulled cable).
type runJournal struct {
	path string
	mu   sync.Mutex
	data struct {
		IDs    []string         `json:"ids"`
		Outbox []actions.Result `json:"outbox"`
	}
}

func openJournal(dataDir string) *runJournal {
	j := &runJournal{path: filepath.Join(dataDir, runsFile)}
	if b, err := os.ReadFile(j.path); err == nil {
		_ = json.Unmarshal(b, &j.data)
	}
	return j
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

// put stores (or replaces) a result in the outbox.
func (j *runJournal) put(r actions.Result) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := j.data.Outbox[:0]
	for _, x := range j.data.Outbox {
		if x.RunID != r.RunID {
			out = append(out, x)
		}
	}
	out = append(out, r)
	if len(out) > keepOutbox {
		out = out[len(out)-keepOutbox:]
	}
	j.data.Outbox = out
	return j.saveLocked()
}

func (j *runJournal) ack(id string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := j.data.Outbox[:0]
	for _, x := range j.data.Outbox {
		if x.RunID != id {
			out = append(out, x)
		}
	}
	j.data.Outbox = out
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
