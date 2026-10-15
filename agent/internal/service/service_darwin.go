package service

import (
	"os"
	"path/filepath"
)

const label = "com.arh.agent"
const plistPath = "/Library/LaunchDaemons/" + label + ".plist"

func defaultLayout() Layout {
	base := "/Library/Application Support/ARH Agent"
	return Layout{InstallDir: base, ExePath: filepath.Join(base, "arh-agent"), DataDir: filepath.Join(base, "data"), LogPath: "/Library/Logs/ARH Agent/agent.log"}
}

func plist(l Layout) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>` + label + `</string>
  <key>ProgramArguments</key>
  <array><string>` + l.ExePath + `</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>` + l.LogPath + `</string>
  <key>StandardErrorPath</key><string>` + l.LogPath + `</string>
</dict>
</plist>
`
}

func register(l Layout) error {
	_ = os.MkdirAll(filepath.Dir(l.LogPath), 0o755)
	if err := os.WriteFile(plistPath, []byte(plist(l)), 0o644); err != nil {
		return err
	}
	_, _ = run("/bin/launchctl", "bootout", "system/"+label)
	if _, err := run("/bin/launchctl", "bootstrap", "system", plistPath); err != nil {
		return err
	}
	_, _ = run("/bin/launchctl", "kickstart", "-k", "system/"+label)
	return nil
}

func stop(l Layout) error {
	_, _ = run("/bin/launchctl", "bootout", "system/"+label)
	return nil
}

func unregister(l Layout) error {
	_ = stop(l)
	err := os.Remove(plistPath)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// The application firewall only matters when it is enabled; errors are not fatal.
func firewallAllow(l Layout) error {
	fw := "/usr/libexec/ApplicationFirewall/socketfilterfw"
	_, _ = run(fw, "--add", l.ExePath)
	_, _ = run(fw, "--unblockapp", l.ExePath)
	return nil
}

func firewallRemove(l Layout) error {
	_, _ = run("/usr/libexec/ApplicationFirewall/socketfilterfw", "--remove", l.ExePath)
	return nil
}

func restrictDataDir(l Layout) error { return os.Chmod(l.DataDir, 0o700) }
