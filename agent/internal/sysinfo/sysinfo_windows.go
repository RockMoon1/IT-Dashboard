package sysinfo

import (
	"os/exec"
	"strings"
)

const osName = "windows"

func serial() string {
	out, err := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
		"(Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue).SerialNumber").Output()
	if err != nil {
		return ""
	}
	s := strings.TrimSpace(string(out))
	if strings.EqualFold(s, "To be filled by O.E.M.") || strings.EqualFold(s, "Default string") {
		return ""
	}
	return s
}
