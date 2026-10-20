// Package profiles embeds the versioned scan profiles so the agent can only ever run checks that
// were compiled into it. The host names a profile; it never sends commands.
package profiles

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed *.json
var files embed.FS

// Schema is the only profile schema this agent accepts.
const Schema = "arh-scan-profile/1"

// DefaultTimeout applies when a check does not set timeoutSeconds.
const DefaultTimeout = 90 * time.Second

type Check struct {
	ID             string   `json:"id"`
	Title          string   `json:"title"`
	Category       string   `json:"category"`
	Shell          string   `json:"shell"`
	Command        []string `json:"command"`
	Format         string   `json:"format"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	Optional       bool     `json:"optional"`
	Access         string   `json:"access"`
	// The fields below are set by the agent for actions and custom commands, never from JSON.
	Env        []string `json:"-"` // extra environment (action parameters, phase, result file)
	CleanEnv   bool     `json:"-"` // drop inherited ARH_* variables (and PSModulePath on Windows)
	FixedPath  bool     `json:"-"` // system PATH and a fixed working folder only
	LongScript bool     `json:"-"` // Windows: script on stdin to a fixed bootstrap, not the command line
}

type Profile struct {
	Schema      string  `json:"schema"`
	Name        string  `json:"name"`
	Version     int     `json:"version"`
	OS          string  `json:"os"`
	Purpose     string  `json:"purpose"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Checks      []Check `json:"checks"`
}

// Script is the exact text handed to the interpreter.
func (c Check) Script() string { return strings.Join(c.Command, "\n") }

func (c Check) Timeout() time.Duration {
	if c.TimeoutSeconds <= 0 {
		return DefaultTimeout
	}
	return time.Duration(c.TimeoutSeconds) * time.Second
}

var (
	once    sync.Once
	loaded  []Profile
	loadErr error
)

// All returns every embedded profile, validated, sorted by name.
func All() ([]Profile, error) {
	once.Do(func() {
		entries, err := fs.ReadDir(files, ".")
		if err != nil {
			loadErr = err
			return
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			raw, err := files.ReadFile(e.Name())
			if err != nil {
				loadErr = fmt.Errorf("%s: %w", e.Name(), err)
				return
			}
			var p Profile
			if err := json.Unmarshal(raw, &p); err != nil {
				loadErr = fmt.Errorf("%s: %w", e.Name(), err)
				return
			}
			if err := Validate(p); err != nil {
				loadErr = fmt.Errorf("%s: %w", e.Name(), err)
				return
			}
			if p.Name+".json" != e.Name() {
				loadErr = fmt.Errorf("%s: file name must equal profile name", e.Name())
				return
			}
			loaded = append(loaded, p)
		}
		sort.Slice(loaded, func(i, j int) bool { return loaded[i].Name < loaded[j].Name })
	})
	return loaded, loadErr
}

// Validate enforces the version-1 rules: explicit commands, read-only access, matching shells.
func Validate(p Profile) error {
	if p.Schema != Schema {
		return fmt.Errorf("schema %q is not %q", p.Schema, Schema)
	}
	if p.Name == "" || p.Version <= 0 {
		return fmt.Errorf("profile needs a name and a positive version")
	}
	switch p.OS {
	case "windows", "macos", "linux":
	default:
		return fmt.Errorf("unknown os %q", p.OS)
	}
	if p.Purpose == "" {
		return fmt.Errorf("%s: purpose is empty", p.Name)
	}
	if len(p.Checks) == 0 {
		return fmt.Errorf("%s: no checks", p.Name)
	}
	seen := map[string]bool{}
	for _, c := range p.Checks {
		if c.ID == "" || seen[c.ID] {
			return fmt.Errorf("%s: missing or duplicate check id %q", p.Name, c.ID)
		}
		seen[c.ID] = true
		if c.Access != "read" {
			return fmt.Errorf("%s/%s: access %q is not allowed in version 1", p.Name, c.ID, c.Access)
		}
		wantShell := "sh"
		if p.OS == "windows" {
			wantShell = "powershell"
		}
		if c.Shell != wantShell {
			return fmt.Errorf("%s/%s: shell %q does not match os %s", p.Name, c.ID, c.Shell, p.OS)
		}
		if len(c.Command) == 0 || strings.TrimSpace(strings.Join(c.Command, "")) == "" {
			return fmt.Errorf("%s/%s: empty command", p.Name, c.ID)
		}
		if c.Format != "json" && c.Format != "text" {
			return fmt.Errorf("%s/%s: format %q", p.Name, c.ID, c.Format)
		}
	}
	return nil
}

// Get returns the embedded profile with exactly this name and version.
func Get(name string, version int) (Profile, error) {
	all, err := All()
	if err != nil {
		return Profile{}, err
	}
	for _, p := range all {
		if p.Name == name {
			if p.Version != version {
				return Profile{}, fmt.Errorf("profile %s is version %d on this agent, host asked for %d", name, p.Version, version)
			}
			return p, nil
		}
	}
	return Profile{}, fmt.Errorf("unknown profile %q", name)
}

// ForOS lists the profiles that can run on the given OS.
func ForOS(osName string) []Profile {
	all, _ := All()
	var out []Profile
	for _, p := range all {
		if p.OS == osName {
			out = append(out, p)
		}
	}
	return out
}
