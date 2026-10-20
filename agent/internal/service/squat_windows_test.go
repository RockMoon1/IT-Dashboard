package service

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/RockMoon1/IT-Dashboard/agent/internal/fsowner"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/policy"
)

// A data folder or policy file that a standard user owns is never trusted: install refuses the
// folder, and the policy reads as read only. Opt-in (ARH_LIVE_APPLY=1, elevated): it creates a
// local user for the test and deletes it again.
func TestFolderAStandardUserMadeIsNotAdopted(t *testing.T) {
	if ok, owner, err := fsowner.Trusted(os.Getenv("SystemRoot")); err != nil || !ok {
		t.Fatalf("%s: trusted=%v owner=%s err=%v", os.Getenv("SystemRoot"), ok, owner, err)
	}
	if os.Getenv("ARH_LIVE_APPLY") != "1" {
		t.Skip("set ARH_LIVE_APPLY=1 on a throwaway elevated Windows machine: this creates a local user")
	}
	mine := t.TempDir() // made by this (administrator) account
	if ok, owner, err := fsowner.Trusted(mine); err != nil || !ok {
		t.Fatalf("a folder an administrator made: trusted=%v owner=%s err=%v", ok, owner, err)
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	user := "arhsq" + hex.EncodeToString(b)[:8]
	pass := "Arh!" + hex.EncodeToString(b) + "aZ9#"
	if out, err := exec.Command("net", "user", user, pass, "/add").CombinedOutput(); err != nil {
		t.Fatalf("net user /add: %v %s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command("net", "user", user, "/delete").Run() })

	dir := filepath.Join(t.TempDir(), "ARH Agent")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	p, err := policy.Preset("full")
	if err != nil {
		t.Fatal(err)
	}
	p.LAN = true
	if err := policy.Save(dir, p); err != nil {
		t.Fatal(err)
	}
	for _, x := range []string{dir, policy.Path(dir)} {
		if out, err := exec.Command("icacls", x, "/setowner", user).CombinedOutput(); err != nil {
			t.Fatalf("icacls /setowner: %v %s", err, out)
		}
	}
	if ok, owner, err := fsowner.Trusted(dir); err != nil || ok {
		t.Fatalf("a folder %s owns: trusted=%v owner=%s err=%v", user, ok, owner, err)
	}
	if got := policy.Load(dir); got.Write || got.Custom || got.LAN || got.Error == "" {
		t.Fatalf("a policy %s owns was used: %+v", user, got)
	}
	err = Install(Layout{DataDir: dir, InstallDir: dir, ExePath: filepath.Join(dir, "arh-agent.exe")}, "ARH-TEST-TOKEN")
	if err == nil || !strings.Contains(err.Error(), "already exists and belongs to") {
		t.Fatalf("install adopted the folder: %v", err)
	}
}
