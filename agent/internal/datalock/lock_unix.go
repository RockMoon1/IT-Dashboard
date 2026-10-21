//go:build !windows

package datalock

import (
	"errors"
	"os"
	"syscall"
)

// lock is flock: it belongs to the open file, so a second open fails even in the same process,
// and the file is close-on-exec, so a command the agent started never inherits it.
func lock(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return ErrHeld
	}
	return err
}
