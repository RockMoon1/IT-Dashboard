package sysinfo

import (
	"syscall"
	"time"
)

var procGetTickCount64 = syscall.NewLazyDLL("kernel32.dll").NewProc("GetTickCount64")

func bootTime() time.Time {
	ms, _, _ := procGetTickCount64.Call()
	if ms == 0 {
		return time.Time{}
	}
	return time.Now().Add(-time.Duration(ms) * time.Millisecond).Truncate(time.Second)
}
