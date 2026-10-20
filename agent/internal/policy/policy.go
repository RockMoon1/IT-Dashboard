// Package policy is the device's own say over what the dashboard may do. policy.json lives in
// the agent's data folder (SYSTEM/Administrators or root only), is re-read on every request and
// fails closed: a missing, unreadable or invalid file means read only. No message from the
// dashboard can change it; only `arh-agent policy` on the device can.
package policy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	Schema   = "arh-policy/1"
	FileName = "policy.json"
)

type Policy struct {
	Schema     string   `json:"schema"`
	Write      bool     `json:"write"`      // named actions that change a setting
	Execute    bool     `json:"execute"`    // named actions that run a task
	Custom     bool     `json:"custom"`     // commands the technician types (needs write and execute too)
	LAN        bool     `json:"lan"`        // allow changes over a LAN session, not only the cable
	Interrupts bool     `json:"interrupts"` // allow actions whose impact is "interrupts" (restart, firewall)
	Deny       []string `json:"deny"`       // action names refused whatever the switches say
	Error      string   `json:"error,omitempty"`
}

// Presets for `arh-agent install --policy`.
func Preset(name string) (Policy, error) {
	switch name {
	case "actions":
		return Policy{Schema: Schema, Write: true, Execute: true, Interrupts: true, Deny: []string{}}, nil
	case "full":
		return Policy{Schema: Schema, Write: true, Execute: true, Custom: true, Interrupts: true, Deny: []string{}}, nil
	case "read":
		return Policy{Schema: Schema, Deny: []string{}}, nil
	case "clinical":
		return Policy{Schema: Schema, Write: true, Execute: true, Deny: []string{}}, nil
	}
	return Policy{}, fmt.Errorf("unknown policy %q (actions, full, read or clinical)", name)
}

// ReadOnly is what an agent with no usable policy file allows: scans and previews.
func ReadOnly(reason string) Policy {
	return Policy{Schema: Schema, Deny: []string{}, Error: reason}
}

func Path(dataDir string) string { return filepath.Join(dataDir, FileName) }

// Load reads the policy, failing closed.
func Load(dataDir string) Policy {
	p := Path(dataDir)
	info, err := os.Lstat(p)
	if errors.Is(err, os.ErrNotExist) {
		return ReadOnly("no policy file on this device: read only (run arh-agent policy --set actions)")
	}
	if err != nil {
		return ReadOnly("policy file unreadable: " + err.Error())
	}
	if !info.Mode().IsRegular() {
		return ReadOnly("policy file is not a regular file")
	}
	if err := checkOwner(p, info); err != nil {
		return ReadOnly(err.Error())
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return ReadOnly("policy file unreadable: " + err.Error())
	}
	var pol Policy
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&pol); err != nil {
		return ReadOnly("policy file invalid: " + err.Error())
	}
	if pol.Schema != Schema {
		return ReadOnly(fmt.Sprintf("policy file schema %q is not %q", pol.Schema, Schema))
	}
	pol.Error = ""
	if pol.Deny == nil {
		pol.Deny = []string{}
	}
	return pol
}

// Save writes the policy atomically (temp file in the same folder, sync, rename).
func Save(dataDir string, pol Policy) error {
	pol.Schema = Schema
	pol.Error = ""
	if pol.Deny == nil {
		pol.Deny = []string{}
	}
	sort.Strings(pol.Deny)
	b, err := json.MarshalIndent(pol, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dataDir, ".policy-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil && !isWindows() {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, Path(dataDir))
}

// Refusal codes, shared with the dashboard.
const (
	CodeDenied = "policy-denied"
	CodeLAN    = "lan-session"
)

// AllowAction decides one named action. impact is quiet, slows or interrupts.
func (p Policy) AllowAction(name, access, impact string, cable bool) (code, why string) {
	if !cable && !p.LAN {
		return CodeLAN, "changes are allowed only over the USB cable, not over the network"
	}
	for _, d := range p.Deny {
		if strings.EqualFold(d, name) {
			return CodeDenied, "this device's policy refuses " + name
		}
	}
	switch access {
	case "write":
		if !p.Write {
			return CodeDenied, "this device's policy refuses changes to settings (write)"
		}
	case "execute":
		if !p.Execute {
			return CodeDenied, "this device's policy refuses tasks (execute)"
		}
	default:
		return CodeDenied, "unknown access " + access
	}
	if impact == "interrupts" && !p.Interrupts {
		return CodeDenied, "this device's policy refuses actions that interrupt work (role clinical)"
	}
	return "", ""
}

// AllowCustom decides a custom command: custom, write and execute must all be allowed, because
// a custom command can do anything the other two can.
func (p Policy) AllowCustom(cable bool) (code, why string) {
	if !cable && !p.LAN {
		return CodeLAN, "custom commands are allowed only over the USB cable, not over the network"
	}
	if !p.Custom || !p.Write || !p.Execute {
		return CodeDenied, "this device's policy refuses custom commands (enable on the device: arh-agent policy --allow custom)"
	}
	return "", ""
}

// Fingerprint is a stable text form, used to notice when the file changed.
func (p Policy) Fingerprint() string {
	b, _ := json.Marshal(p)
	return string(b)
}
