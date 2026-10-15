package sysinfo

import (
	"os"
	"strings"
)

const osName = "linux"

func serial() string {
	for _, p := range []string{"/sys/class/dmi/id/product_serial", "/sys/class/dmi/id/board_serial"} {
		b, err := os.ReadFile(p)
		if err == nil {
			s := strings.TrimSpace(string(b))
			if s != "" && !strings.EqualFold(s, "To be filled by O.E.M.") && !strings.EqualFold(s, "Default string") {
				return s
			}
		}
	}
	if b, err := os.ReadFile("/etc/machine-id"); err == nil {
		return "machine-id:" + strings.TrimSpace(string(b))
	}
	return ""
}
