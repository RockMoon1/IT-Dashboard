package sysinfo

import (
	"encoding/binary"
	"syscall"
	"time"
)

// kern.boottime is a struct timeval; its first 8 bytes are the seconds (64-bit little endian on
// both Intel and Apple silicon Macs).
func bootTime() time.Time {
	s, err := syscall.Sysctl("kern.boottime")
	if err != nil || len(s) < 8 {
		return time.Time{}
	}
	return time.Unix(int64(binary.LittleEndian.Uint64([]byte(s[:8]))), 0)
}
