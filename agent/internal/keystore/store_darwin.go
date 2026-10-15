package keystore

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// System keychain via the security(1) tool. Secrets travel over stdin in interactive mode so
// they never appear on a command line.

const (
	systemKeychain = "/Library/Keychains/System.keychain"
	account        = "arh-agent"
)

type keychainStore struct{}

func newStore(string) Store { return keychainStore{} }

func runSecurity(stdin string, args ...string) (string, error) {
	cmd := exec.Command("/usr/bin/security", args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("security %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func (keychainStore) Save(name string, secret []byte) error {
	enc := base64.StdEncoding.EncodeToString(secret)
	// -U updates an existing item in place.
	script := fmt.Sprintf("add-generic-password -a %s -s %s -w %s -U %s\n", account, name, enc, systemKeychain)
	_, err := runSecurity(script, "-i")
	return err
}

func (keychainStore) Load(name string) ([]byte, error) {
	out, err := runSecurity("", "find-generic-password", "-a", account, "-s", name, "-w", systemKeychain)
	if err != nil {
		if strings.Contains(err.Error(), "could not be found") {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(out))
}

func (keychainStore) Delete(name string) error {
	_, err := runSecurity("", "delete-generic-password", "-a", account, "-s", name, systemKeychain)
	if err != nil && strings.Contains(err.Error(), "could not be found") {
		return nil
	}
	if err != nil && errors.Is(err, exec.ErrNotFound) {
		return nil
	}
	return err
}

func (keychainStore) Describe() string { return "macOS System keychain (" + systemKeychain + ")" }
