package service

import (
	"os"
	"strconv"
	"strings"
)

const unitPath = "/etc/systemd/system/arh-agent.service"

func defaultLayout() Layout {
	return Layout{InstallDir: "/usr/local/sbin", ExePath: "/usr/local/sbin/arh-agent", DataDir: "/var/lib/arh-agent", LogPath: "/var/lib/arh-agent/agent.log"}
}

// unit is the systemd service. KillMode=mixed sends SIGTERM to the agent alone (by default every
// process in the unit gets it, so a running change or custom command would stop with the agent
// instead of getting its drain); what is still running when the agent exits is killed then.
func unit(l Layout) string {
	return `[Unit]
Description=ARH Agent (read-only diagnostics for the ARH IT Dashboard)
After=network.target

[Service]
ExecStart=` + l.ExePath + ` run
Restart=always
RestartSec=5
ProtectHome=read-only
KillMode=mixed
TimeoutStopSec=` + strconv.Itoa(StopSeconds) + `

[Install]
WantedBy=multi-user.target
`
}

func register(l Layout) error {
	if err := os.WriteFile(unitPath, []byte(unit(l)), 0o644); err != nil {
		return err
	}
	if _, err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	if _, err := run("systemctl", "enable", "arh-agent"); err != nil {
		return err
	}
	_, err := run("systemctl", "restart", "arh-agent")
	return err
}

func stop(l Layout) error {
	_, _ = run("systemctl", "stop", "arh-agent")
	return nil
}

func unregister(l Layout) error {
	_, _ = run("systemctl", "disable", "--now", "arh-agent")
	err := os.Remove(unitPath)
	_, _ = run("systemctl", "daemon-reload")
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func firewallAllow(l Layout) error {
	if out, err := run("ufw", "status"); err == nil && strings.Contains(out, "active") {
		_, _ = run("ufw", "allow", "47911/udp")
	}
	return nil
}

func firewallRemove(l Layout) error {
	_, _ = run("ufw", "delete", "allow", "47911/udp")
	return nil
}

func restrictDataDir(l Layout) error { return os.Chmod(l.DataDir, 0o700) }
