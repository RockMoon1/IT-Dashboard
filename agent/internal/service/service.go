// Package service installs the agent as a system service and manages the pending enrollment
// token. Each platform uses its native mechanism: scheduled task (Windows), LaunchDaemon (macOS),
// systemd unit (Linux). No service-control library is needed, which keeps the binary dependency-free.
package service

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/RockMoon1/IT-Dashboard/agent/internal/fsowner"
)

const (
	Name        = "arh-agent"
	DisplayName = "ARH Agent"
	BeaconPort  = 47911
	tokenFile   = "enroll.token"
)

type Layout struct {
	InstallDir string
	ExePath    string
	DataDir    string
	LogPath    string
}

func DefaultLayout() Layout { return defaultLayout() }

// Install copies the running binary into place, stores the enrollment token, registers and
// starts the service, and opens the beacon port in the host firewall.
func Install(l Layout, token string) error {
	if strings.TrimSpace(token) == "" {
		return errors.New("an enrollment token is required (--token ARH-…)")
	}
	// The data folder holds the device key, the pinned dashboard and the policy. One that someone
	// else created beforehand (C:\ProgramData lets any user create folders) is never adopted.
	if _, err := os.Lstat(l.DataDir); err == nil {
		ok, owner, err := fsowner.Trusted(l.DataDir)
		if err != nil {
			return fmt.Errorf("checking who owns %s: %w", l.DataDir, err)
		}
		if !ok {
			return fmt.Errorf("the data folder %s already exists and belongs to %s, not to SYSTEM or an administrator; another user may have made it to take over the agent. Delete it as an administrator and install again", l.DataDir, owner)
		}
	}
	if err := os.MkdirAll(l.DataDir, 0o700); err != nil {
		return fmt.Errorf("creating data dir %s: %w", l.DataDir, err)
	}
	_ = stop(l) // a previous instance may hold the executable open
	if err := copySelf(l); err != nil {
		return err
	}
	if err := WritePendingToken(l.DataDir, token); err != nil {
		return err
	}
	// A new token means a new enrollment: forget any earlier host pin.
	_ = os.Remove(filepath.Join(l.DataDir, "host.json"))
	if err := restrictDataDir(l); err != nil {
		return err
	}
	if err := firewallAllow(l); err != nil {
		return fmt.Errorf("firewall rule: %w", err)
	}
	if err := register(l); err != nil {
		return fmt.Errorf("registering service: %w", err)
	}
	return nil
}

func Uninstall(l Layout) error {
	var errs []string
	if err := unregister(l); err != nil {
		errs = append(errs, err.Error())
	}
	if err := firewallRemove(l); err != nil {
		errs = append(errs, err.Error())
	}
	if err := os.RemoveAll(l.DataDir); err != nil {
		errs = append(errs, err.Error())
	}
	if err := os.Remove(l.ExePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func WritePendingToken(dataDir, token string) error {
	return os.WriteFile(filepath.Join(dataDir, tokenFile), []byte(strings.TrimSpace(token)+"\n"), 0o600)
}

func ReadPendingToken(dataDir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(dataDir, tokenFile))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func ClearPendingToken(dataDir string) error {
	err := os.Remove(filepath.Join(dataDir, tokenFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func copySelf(l Layout) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	if sameFile(self, l.ExePath) {
		return nil
	}
	if err := os.MkdirAll(l.InstallDir, 0o755); err != nil {
		return err
	}
	in, err := os.Open(self)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := l.ExePath + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, l.ExePath)
}

func sameFile(a, b string) bool {
	fa, err1 := os.Stat(a)
	fb, err2 := os.Stat(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return os.SameFile(fa, fb)
}
