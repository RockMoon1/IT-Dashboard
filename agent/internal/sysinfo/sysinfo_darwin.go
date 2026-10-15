package sysinfo

import (
	"os/exec"
	"regexp"
)

const osName = "macos"

var serialRe = regexp.MustCompile(`"IOPlatformSerialNumber"\s*=\s*"([^"]+)"`)

func serial() string {
	out, err := exec.Command("/usr/sbin/ioreg", "-c", "IOPlatformExpertDevice", "-d", "2").Output()
	if err != nil {
		return ""
	}
	if m := serialRe.FindSubmatch(out); m != nil {
		return string(m[1])
	}
	return ""
}
