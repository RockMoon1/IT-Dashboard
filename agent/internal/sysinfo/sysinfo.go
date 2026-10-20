// Package sysinfo reports the identifiers the dashboard matches devices on.
package sysinfo

import (
	"os"
	"strings"
	"time"
)

func Hostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown-host"
	}
	return strings.TrimSpace(h)
}

// Serial returns the hardware serial number when the platform exposes one, else "".
func Serial() string { return strings.TrimSpace(serial()) }

func OSName() string { return osName }

// BootTime is when the system last started, UTC RFC 3339, or "" when unknown. The dashboard
// compares it with a scheduled restart to record whether the restart happened.
func BootTime() string {
	t := bootTime()
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
