package datalock

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

var procLockFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("LockFileEx")

const (
	lockfileFailImmediately               = 0x1
	lockfileExclusiveLock                 = 0x2
	errorLockViolation      syscall.Errno = 33
)

// lock is LockFileEx on the file's first byte: it belongs to the handle, so a second open fails
// even in the same process, while other programs (an antivirus scan) can still open the file.
func lock(f *os.File) error {
	var ol syscall.Overlapped
	r, _, err := procLockFileEx.Call(f.Fd(), lockfileExclusiveLock|lockfileFailImmediately, 0, 1, 0, uintptr(unsafe.Pointer(&ol)))
	if r != 0 {
		return nil
	}
	if errors.Is(err, errorLockViolation) {
		return ErrHeld
	}
	return err
}
