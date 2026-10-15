// Package sysinfo reports the identifiers the dashboard matches devices on.
package sysinfo

import (
	"os"
	"strings"
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
