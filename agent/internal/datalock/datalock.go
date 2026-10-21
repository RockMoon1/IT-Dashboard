// Package datalock keeps one agent process per data folder. The agent holds an exclusive lock on
// a file there for as long as it runs; the operating system drops the lock when the process
// ends, however it ends, so a crash or a kill never leaves the folder locked.
package datalock

import (
	"errors"
	"os"
	"path/filepath"
)

// FileName is the lock file in the data folder.
const FileName = "agent.lock"

// ErrHeld means another process holds the folder's lock.
var ErrHeld = errors.New("another process holds the data folder's lock")

// Acquire takes the folder's lock, or returns ErrHeld at once. release lets it go.
func Acquire(dir string) (release func(), err error) {
	f, err := os.OpenFile(filepath.Join(dir, FileName), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lock(f); err != nil {
		f.Close()
		return nil, err
	}
	return func() { f.Close() }, nil
}
