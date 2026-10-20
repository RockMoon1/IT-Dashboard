// Package actions embeds the named write and execute actions, the same way package profiles
// embeds the read-only scans: the agent runs only actions compiled into it. The host names one,
// with its version and the SHA-256 of its file, and passes checked parameters as environment
// variables; it never sends the script.
//
// Each action has two scripts. measure only reads: it reports items, a plan, blockers and the
// values that would restore today's state. apply makes the change. A preview runs measure alone,
// so it cannot change anything whatever a script does. A real run is measure, apply, measure.
package actions

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed *.json
var files embed.FS

// Schema is the only action schema this agent accepts.
const Schema = "arh-action/1"

const (
	// MaxTimeout bounds apply (sfc /scannow is the slowest, 15 to 60 minutes).
	MaxTimeout = time.Hour
	// MeasureTimeout bounds each measure run.
	MeasureTimeout = 3 * time.Minute
	// MaxSettle bounds the wait between apply and the second measure.
	MaxSettle = 60 * time.Second
	// MaxValue is the longest item, plan, blocker or note value kept from a result file.
	MaxValue = 240
	// MaxItems bounds the items one measure may report.
	MaxItems = 64
	// MaxResultFile bounds the result file the agent reads back.
	MaxResultFile = 256 * 1024
)

type Param struct {
	Name      string   `json:"name"`
	Label     string   `json:"label"`
	Pattern   string   `json:"pattern"`
	MaxLength int      `json:"maxLength"`
	Required  bool     `json:"required"`
	Default   string   `json:"default"`
	Choices   []string `json:"choices"`
	Examples  Examples `json:"examples"`
	re        *regexp.Regexp
}

// Examples are sample values the parameter must accept and refuse; the Go and TypeScript tests
// both check them, so the two regex engines cannot disagree unnoticed.
type Examples struct {
	OK  []string `json:"ok"`
	Bad []string `json:"bad"`
}

// alwaysBad must be refused by every parameter: option injection, PowerShell wildcards, breaks.
var alwaysBad = []string{"-x", "--all", "a*", "a?", "a[b]", "a\nb", "a\rb", "a\x00b"}

type Action struct {
	Schema         string   `json:"schema"`
	Name           string   `json:"name"`
	Version        int      `json:"version"`
	OS             string   `json:"os"`
	Access         string   `json:"access"` // "write" or "execute"
	Category       string   `json:"category"`
	Title          string   `json:"title"`
	Description    string   `json:"description"`
	Impact         string   `json:"impact"` // quiet, slows, interrupts
	Reversible     bool     `json:"reversible"`
	Undo           string   `json:"undo"`       // the action that restores the measured before state
	ManualUndo     string   `json:"manualUndo"` // how to undo by hand when there is no undo action
	Abortable      bool     `json:"abortable"`  // abort may stop apply once it has started
	Concurrent     bool     `json:"concurrent"` // may run while the run slot is busy
	Fixes          []string `json:"fixes"`
	Shell          string   `json:"shell"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	SettleSeconds  int      `json:"settleSeconds"`
	Params         []Param  `json:"params"`
	Measure        []string `json:"measure"`
	Apply          []string `json:"apply"`

	sha string
}

// SHA256 is the hex digest of the action's file as embedded, which the dashboard must quote.
func (a Action) SHA256() string { return a.sha }

// Phases of one run, also the check ids the agent reports.
const (
	PhaseMeasure = "measure"
	PhaseApply   = "apply"
	PhaseAfter   = "measure-after"
)

// Prelude for PowerShell: helpers that append tab-separated lines to the agent's result file,
// and Invoke-ArhNative, the one way an action calls a native program (stderr is folded into the
// returned text so it cannot become a terminating error, and $LASTEXITCODE is left for the
// caller to check). apply runs with $ErrorActionPreference = 'Stop'.
const psPrelude = `$ArhPhase = $env:ARH_PHASE
$ErrorActionPreference = $(if ($ArhPhase -eq 'apply') { 'Stop' } else { 'Continue' })
$ArhInv = [Globalization.CultureInfo]::InvariantCulture
function Write-ArhLine([string]$Kind, [string]$A, [string]$B) {
  if (-not $env:ARH_RESULT_FILE) { return }
  $a1 = ([string]$A -replace '[\x00-\x1f\x7f]', ' ').Trim()
  $b1 = ([string]$B -replace '[\x00-\x1f\x7f]', ' ').Trim()
  [IO.File]::AppendAllText($env:ARH_RESULT_FILE, ($Kind + [char]9 + $a1 + [char]9 + $b1 + [char]10), (New-Object Text.UTF8Encoding $false))
}
function Add-ArhItem([string]$Item, [string]$Value) { Write-ArhLine 'item' $Item $Value }
function Add-ArhInfo([string]$Item, [string]$Value) { Write-ArhLine 'info' $Item $Value }
function Set-ArhPlan([bool]$Change, [string]$Text) { Write-ArhLine 'plan' $(if ($Change) { '1' } else { '0' }) $Text }
function Add-ArhBlocker([string]$Text) { Write-ArhLine 'blocker' $Text '' }
function Add-ArhWarning([string]$Text) { Write-ArhLine 'warn' $Text '' }
function Set-ArhRestore([string]$Name, [string]$Value) { Write-ArhLine 'restore' $Name $Value }
function Add-ArhNote([string]$Text) { Write-ArhLine 'note' $Text '' }
function Add-ArhChange([string]$Text) { Write-ArhLine 'change' $Text '' }
function Format-ArhTime($d) { if ($d) { ([datetime]$d).ToString('yyyy-MM-dd HH:mm', $ArhInv) } else { 'never' } }
function Invoke-ArhNative([string]$Exe) {
  $ErrorActionPreference = 'Continue'
  $path = Join-Path (Join-Path $env:SystemRoot 'System32') $Exe
  $out = & $path @args 2>&1 | ForEach-Object { "$_" }
  ($out -join [char]10).Trim()
}
`

// Prelude for sh: the same helpers. Values are cleaned of control characters before writing.
const shPrelude = `ARH_PHASE="${ARH_PHASE:-}"
arh_clean() { printf '%s' "$1" | tr '\t\n\r' '   ' | tr -d '\000-\010\013\014\016-\037\177'; }
arh_line() {
  [ -n "${ARH_RESULT_FILE:-}" ] || return 0
  printf '%s\t%s\t%s\n' "$1" "$(arh_clean "$2")" "$(arh_clean "$3")" >> "$ARH_RESULT_FILE"
}
arh_item() { arh_line item "$1" "$2"; }
arh_info() { arh_line info "$1" "$2"; }
arh_plan() { if [ "$1" = true ]; then arh_line plan 1 "$2"; else arh_line plan 0 "$2"; fi; }
arh_blocker() { arh_line blocker "$1" ""; }
arh_warn() { arh_line warn "$1" ""; }
arh_restore() { arh_line restore "$1" "$2"; }
arh_note() { arh_line note "$1" ""; }
arh_change() { arh_line change "$1" ""; }
`

// Prelude returns the helper text placed before every action script for this shell.
func Prelude(shell string) string {
	if shell == "powershell" {
		return psPrelude
	}
	return shPrelude
}

// Script is the exact text for one phase, prelude included.
func (a Action) Script(phase string) string {
	body := a.Measure
	if phase == PhaseApply {
		body = a.Apply
	}
	return Prelude(a.Shell) + strings.Join(body, "\n")
}

// Env is the environment for one phase: the declared parameters (only those, upper-cased), the
// phase and the result file. Values were checked by CheckParams.
func (a Action) Env(params map[string]string, phase, resultFile string) []string {
	env := []string{"ARH_PHASE=" + phase, "ARH_RESULT_FILE=" + resultFile}
	for _, p := range a.Params {
		v, ok := params[p.Name]
		if !ok || v == "" {
			v = p.Default
		}
		env = append(env, "ARH_PARAM_"+strings.ToUpper(p.Name)+"="+v)
	}
	return env
}

var (
	once    sync.Once
	loaded  []Action
	loadErr error
)

var namePattern = regexp.MustCompile(`^[a-z0-9-]{1,80}$`)
var paramNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,30}$`)

// banned lists constructs that would evaluate a parameter (or any text) a second time.
var banned = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bInvoke-Expression\b`),
	regexp.MustCompile(`(?i)(^|[\s;|(])iex(\s|$)`),
	regexp.MustCompile(`(?i)\[scriptblock\]`),
	regexp.MustCompile(`(?i)\bStart-Process\b`),
	regexp.MustCompile(`(?i)\bcmd(\.exe)?\s+/c\b`),
	regexp.MustCompile(`\b(sh|bash|zsh)\s+-c\b`),
	regexp.MustCompile(`\beval\b`),
	regexp.MustCompile(`\bosascript\b`),
	regexp.MustCompile(`(?i)\bAdd-Type\b`),
	regexp.MustCompile(`(?:^|[\s;(|{])&\s*["'$\w]`), // the call operator: use Invoke-ArhNative
	regexp.MustCompile(`(?i)\.(exe|cmd|bat)\b.*\s2>`),
}

var nativeCall = regexp.MustCompile(`Invoke-ArhNative\b`)

// psScopedName finds "$name:" that PowerShell would read as a drive- or scope-qualified variable
// (a parse error inside "…$mode: text…"); write ${name} instead.
var psScopedName = regexp.MustCompile(`\$([A-Za-z_][A-Za-z0-9_]*):([^:]|$)`)

var psScopes = map[string]bool{"env": true, "script": true, "global": true, "local": true, "private": true, "using": true, "variable": true}

// unquotedShParam reports $ARH_PARAM_X (or ${ARH_PARAM_X}) outside double quotes on an sh line,
// where the shell would split and glob the value.
func unquotedShParam(line string) bool {
	inDouble := false
	for i := 0; i < len(line); i++ {
		switch c := line[i]; {
		case c == '\\':
			i++
		case c == '"':
			inDouble = !inDouble
		case c == '\'' && !inDouble: // nothing expands inside single quotes
			j := strings.IndexByte(line[i+1:], '\'')
			if j < 0 {
				return false
			}
			i += j + 1
		case c == '$' && !inDouble:
			rest := line[i:]
			if strings.HasPrefix(rest, "$ARH_PARAM_") || strings.HasPrefix(rest, "${ARH_PARAM_") {
				return true
			}
		}
	}
	return false
}

// Validate enforces the action rules.
func Validate(a *Action) error {
	if a.Schema != Schema {
		return fmt.Errorf("schema %q is not %q", a.Schema, Schema)
	}
	if !namePattern.MatchString(a.Name) || a.Version <= 0 {
		return fmt.Errorf("action needs a lowercase name and a positive version")
	}
	switch a.OS {
	case "windows", "macos", "linux":
	default:
		return fmt.Errorf("%s: unknown os %q", a.Name, a.OS)
	}
	if !strings.HasPrefix(a.Name, a.OS+"-") {
		return fmt.Errorf("%s: name must start with %s-", a.Name, a.OS)
	}
	if a.Access != "write" && a.Access != "execute" {
		return fmt.Errorf("%s: access %q must be write or execute", a.Name, a.Access)
	}
	if a.Impact != "quiet" && a.Impact != "slows" && a.Impact != "interrupts" {
		return fmt.Errorf("%s: impact %q must be quiet, slows or interrupts", a.Name, a.Impact)
	}
	if a.Undo != "" && (!strings.HasPrefix(a.Undo, a.OS+"-") || a.Undo == a.Name && len(a.Params) == 0) {
		return fmt.Errorf("%s: undo %q must be another %s action (or itself with parameters)", a.Name, a.Undo, a.OS)
	}
	want := "sh"
	if a.OS == "windows" {
		want = "powershell"
	}
	if a.Shell != want {
		return fmt.Errorf("%s: shell %q does not match os %s", a.Name, a.Shell, a.OS)
	}
	if a.TimeoutSeconds <= 0 || time.Duration(a.TimeoutSeconds)*time.Second > MaxTimeout {
		return fmt.Errorf("%s: timeoutSeconds must be 1..%d", a.Name, int(MaxTimeout.Seconds()))
	}
	if a.SettleSeconds < 0 || time.Duration(a.SettleSeconds)*time.Second > MaxSettle {
		return fmt.Errorf("%s: settleSeconds must be 0..%d", a.Name, int(MaxSettle.Seconds()))
	}
	if a.Title == "" || a.Category == "" || a.Description == "" {
		return fmt.Errorf("%s: title, category and description are required", a.Name)
	}
	measure, apply := strings.Join(a.Measure, "\n"), strings.Join(a.Apply, "\n")
	if strings.TrimSpace(measure) == "" || strings.TrimSpace(apply) == "" {
		return fmt.Errorf("%s: measure and apply are both required", a.Name)
	}
	plan := "Set-ArhPlan"
	if a.Shell == "sh" {
		plan = "arh_plan"
	}
	if !strings.Contains(measure, plan) {
		return fmt.Errorf("%s: measure never reports a plan with %s", a.Name, plan)
	}
	for _, line := range append(append([]string{}, a.Measure...), a.Apply...) {
		for _, re := range banned {
			if re.MatchString(line) {
				return fmt.Errorf("%s: %q is not allowed in an action (%s)", a.Name, strings.TrimSpace(line), re)
			}
		}
		if a.Shell == "sh" && unquotedShParam(line) {
			return fmt.Errorf("%s: parameters must be quoted in sh: %q", a.Name, strings.TrimSpace(line))
		}
	}
	if a.Shell == "powershell" {
		for _, line := range append(append([]string{}, a.Measure...), a.Apply...) {
			for _, m := range psScopedName.FindAllStringSubmatch(line, -1) {
				if !psScopes[strings.ToLower(m[1])] {
					return fmt.Errorf("%s: PowerShell reads $%s: as a scoped name; write ${%s}: %q", a.Name, m[1], m[1], strings.TrimSpace(line))
				}
			}
		}
		for i, line := range a.Apply {
			if !nativeCall.MatchString(line) {
				continue
			}
			next := ""
			if i+1 < len(a.Apply) {
				next = a.Apply[i+1]
			}
			if !strings.Contains(line+next, "$LASTEXITCODE") {
				return fmt.Errorf("%s: apply line %d calls a native program without checking $LASTEXITCODE", a.Name, i+1)
			}
		}
	}
	if a.Reversible && a.Undo == "" && a.ManualUndo == "" {
		return fmt.Errorf("%s: reversible actions need undo or manualUndo", a.Name)
	}
	seen := map[string]bool{}
	for i := range a.Params {
		p := &a.Params[i]
		if !paramNamePattern.MatchString(p.Name) || seen[strings.ToUpper(p.Name)] {
			return fmt.Errorf("%s: bad or duplicate parameter name %q", a.Name, p.Name)
		}
		seen[strings.ToUpper(p.Name)] = true
		if p.Label == "" {
			return fmt.Errorf("%s/%s: label is required", a.Name, p.Name)
		}
		if p.Pattern == "" {
			return fmt.Errorf("%s/%s: pattern is required", a.Name, p.Name)
		}
		re, err := regexp.Compile(`^(?:` + p.Pattern + `)$`)
		if err != nil {
			return fmt.Errorf("%s/%s: %w", a.Name, p.Name, err)
		}
		p.re = re
		if p.MaxLength <= 0 || p.MaxLength > 256 {
			return fmt.Errorf("%s/%s: maxLength must be 1..256", a.Name, p.Name)
		}
		for _, c := range p.Choices {
			if err := p.check(c); err != nil {
				return fmt.Errorf("%s/%s: choice %q: %w", a.Name, p.Name, c, err)
			}
		}
		if p.Default != "" {
			if err := p.check(p.Default); err != nil {
				return fmt.Errorf("%s/%s: default: %w", a.Name, p.Name, err)
			}
		}
		if len(p.Examples.OK) == 0 {
			return fmt.Errorf("%s/%s: at least one example of a good value is required", a.Name, p.Name)
		}
		for _, v := range p.Examples.OK {
			if err := p.check(v); err != nil {
				return fmt.Errorf("%s/%s: example %q should be accepted: %w", a.Name, p.Name, v, err)
			}
		}
		for _, v := range append(append([]string{}, alwaysBad...), p.Examples.Bad...) {
			if p.check(v) == nil {
				return fmt.Errorf("%s/%s: %q should be refused", a.Name, p.Name, v)
			}
		}
	}
	for _, f := range a.Fixes {
		if _, err := regexp.Compile(f); err != nil {
			return fmt.Errorf("%s: fixes pattern %q: %w", a.Name, f, err)
		}
	}
	return nil
}

func (p Param) check(v string) error {
	if len(v) > p.MaxLength {
		return fmt.Errorf("longer than %d characters", p.MaxLength)
	}
	if strings.ContainsAny(v, "\x00\r\n") || strings.HasPrefix(v, "-") {
		return errors.New("contains a line break or starts with -")
	}
	if len(p.Choices) > 0 {
		ok := false
		for _, c := range p.Choices {
			ok = ok || c == v
		}
		if !ok {
			return fmt.Errorf("must be one of %s", strings.Join(p.Choices, ", "))
		}
	}
	re := p.re
	if re == nil {
		re = regexp.MustCompile(`^(?:` + p.Pattern + `)$`)
	}
	if !re.MatchString(v) {
		return fmt.Errorf("does not match %s", p.Pattern)
	}
	return nil
}

// CheckParams refuses unknown names, missing required values and values that break the
// parameter's own rules.
func (a Action) CheckParams(params map[string]string) error {
	known := map[string]Param{}
	for _, p := range a.Params {
		known[p.Name] = p
	}
	for name := range params {
		if _, ok := known[name]; !ok {
			return fmt.Errorf("action %s has no parameter %q", a.Name, name)
		}
	}
	for _, p := range a.Params {
		v := params[p.Name]
		if v == "" {
			if p.Required && p.Default == "" {
				return fmt.Errorf("parameter %s is required", p.Name)
			}
			continue
		}
		if err := p.check(v); err != nil {
			return fmt.Errorf("parameter %s %w", p.Name, err)
		}
	}
	return nil
}

// Decode parses and validates one action file and records its SHA-256.
func Decode(raw []byte) (Action, error) {
	var a Action
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&a); err != nil {
		return Action{}, err
	}
	if err := Validate(&a); err != nil {
		return Action{}, err
	}
	sum := sha256.Sum256(raw)
	a.sha = hex.EncodeToString(sum[:])
	return a, nil
}

func load() {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		loadErr = err
		return
	}
	byName := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := files.ReadFile(e.Name())
		if err != nil {
			loadErr = fmt.Errorf("%s: %w", e.Name(), err)
			return
		}
		a, err := Decode(raw)
		if err != nil {
			loadErr = fmt.Errorf("%s: %w", e.Name(), err)
			return
		}
		if a.Name+".json" != e.Name() {
			loadErr = fmt.Errorf("%s: file name must equal action name", e.Name())
			return
		}
		byName[a.Name] = true
		loaded = append(loaded, a)
	}
	for _, a := range loaded {
		if a.Undo != "" && a.Undo != a.Name && !byName[a.Undo] {
			loadErr = fmt.Errorf("%s: undo action %s is not embedded", a.Name, a.Undo)
			return
		}
	}
	sort.Slice(loaded, func(i, j int) bool { return loaded[i].Name < loaded[j].Name })
}

// All returns every embedded action, validated, sorted by name.
func All() ([]Action, error) {
	once.Do(load)
	return loaded, loadErr
}

// Get returns the embedded action with exactly this name, version and file hash.
func Get(name string, version int, sha string) (Action, error) {
	all, err := All()
	if err != nil {
		return Action{}, err
	}
	for _, a := range all {
		if a.Name != name {
			continue
		}
		if a.Version != version {
			return Action{}, fmt.Errorf("action %s is version %d on this agent, the dashboard asked for %d", name, a.Version, version)
		}
		if !strings.EqualFold(a.sha, sha) {
			return Action{}, fmt.Errorf("action %s v%d on this agent differs from the dashboard's copy (sha256 %s, asked %.12s)", name, version, a.sha[:12], sha)
		}
		return a, nil
	}
	return Action{}, fmt.Errorf("unknown action %q", name)
}

// ForOS lists the actions for one OS.
func ForOS(osName string) []Action {
	all, _ := All()
	var out []Action
	for _, a := range all {
		if a.OS == osName {
			out = append(out, a)
		}
	}
	return out
}
