package actions

import (
	"bytes"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Item is one measured value, e.g. {"Firewall Public", "off"}.
type Item struct {
	Item  string `json:"item"`
	Value string `json:"value"`
}

// Measurement is what one measure (or apply) run wrote to its result file, cleaned and bounded.
type Measurement struct {
	Items    []Item            `json:"items"`            // compared before and after
	Info     []Item            `json:"info,omitempty"`   // context, not compared
	Change   *bool             `json:"change,omitempty"` // the plan: apply would change something
	Plan     string            `json:"plan,omitempty"`
	Blockers []string          `json:"blockers,omitempty"`
	Warnings []string          `json:"warnings,omitempty"`
	Restore  map[string]string `json:"restore,omitempty"`
	Notes    []string          `json:"notes,omitempty"`
	Changes  []string          `json:"changes,omitempty"` // evidence apply left (sfc repair lines)
	Ignored  int               `json:"ignored,omitempty"` // lines that were not understood
	ExitCode int               `json:"exitCode"`
	TimedOut bool              `json:"timedOut,omitempty"`
}

// Result is the agent's account of one action or custom command, sent in run-end and kept in
// the outbox until the dashboard acknowledges it. Times are the device's clock, UTC.
type Result struct {
	RunID   string            `json:"runId"`
	Kind    string            `json:"kind"` // "action" or "exec"
	Action  string            `json:"action,omitempty"`
	Version int               `json:"version,omitempty"`
	SHA256  string            `json:"sha256,omitempty"` // action file, or custom script
	Access  string            `json:"access,omitempty"`
	Params  map[string]string `json:"params,omitempty"`
	DryRun  bool              `json:"dryRun"`

	Before    *Measurement `json:"before,omitempty"`
	Applied   bool         `json:"applied"` // the apply step (or the custom script) started
	Apply     *Measurement `json:"apply,omitempty"`
	After     *Measurement `json:"after,omitempty"`
	Skipped   string       `json:"skipped,omitempty"` // why apply did not run
	Aborted   bool         `json:"aborted,omitempty"`
	Error     string       `json:"error,omitempty"`
	ExitCode  *int         `json:"exitCode,omitempty"` // custom commands
	Lines     int          `json:"lines,omitempty"`    // custom commands
	StartedAt string       `json:"startedAt"`
	AppliedAt string       `json:"appliedAt,omitempty"`
	EndedAt   string       `json:"endedAt,omitempty"`
}

// Clean makes a device-supplied value safe to carry: line and paragraph separators and every
// control character become spaces, runs of spaces collapse, and the length is capped in runes.
func Clean(s string) string {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "\ufffd")
	}
	var b strings.Builder
	space := false
	n := 0
	for _, r := range s {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' || r == '\u0085' || unicode.Is(unicode.Zs, r) || r == '\ufeff' {
			r = ' '
		}
		if r == ' ' {
			if space || b.Len() == 0 {
				continue
			}
			space = true
		} else {
			space = false
		}
		if n == MaxValue {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimRight(b.String(), " ")
}

// Parse reads a result file. restoreNames lists the parameter names a restore line may set
// (the undo action's parameters); anything else is counted as ignored.
func Parse(raw []byte, restoreNames []string) Measurement {
	var m Measurement
	if len(raw) > MaxResultFile {
		raw = raw[:MaxResultFile]
		m.Ignored++
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	allowed := map[string]bool{}
	for _, n := range restoreNames {
		allowed[n] = true
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSuffix(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.SplitN(line, "\t", 3)
		for len(f) < 3 {
			f = append(f, "")
		}
		kind, a, b := f[0], Clean(f[1]), Clean(f[2])
		switch {
		case kind == "item" && a != "" && len(m.Items) < MaxItems:
			m.Items = append(m.Items, Item{Item: a, Value: b})
		case kind == "info" && a != "" && len(m.Info) < MaxItems:
			m.Info = append(m.Info, Item{Item: a, Value: b})
		case kind == "warn" && a != "" && len(m.Warnings) < 16:
			m.Warnings = append(m.Warnings, a)
		case kind == "change" && a != "" && len(m.Changes) < 32:
			m.Changes = append(m.Changes, a)
		case kind == "plan" && (a == "1" || a == "0"):
			change := a == "1"
			m.Change, m.Plan = &change, b
		case kind == "blocker" && a != "" && len(m.Blockers) < 16:
			m.Blockers = append(m.Blockers, a)
		case kind == "restore" && allowed[a] && len(m.Restore) < 16:
			if m.Restore == nil {
				m.Restore = map[string]string{}
			}
			m.Restore[a] = b
		case kind == "note" && a != "" && len(m.Notes) < 32:
			m.Notes = append(m.Notes, a)
		default:
			m.Ignored++
		}
	}
	return m
}

// RestoreNames is the set of parameters a measure of this action may capture for its undo.
func (a Action) RestoreNames() []string {
	if a.Undo == "" {
		return nil
	}
	if a.Undo == a.Name {
		var names []string
		for _, p := range a.Params {
			names = append(names, p.Name)
		}
		return names
	}
	for _, u := range ForOS(a.OS) {
		if u.Name == a.Undo {
			var names []string
			for _, p := range u.Params {
				names = append(names, p.Name)
			}
			return names
		}
	}
	return nil
}
