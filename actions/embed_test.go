package actions

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"testing"
)

var updateLock = flag.Bool("update-lock", false, "add new action versions to versions.lock")

func TestAllActionsLoadAndValidate(t *testing.T) {
	all, err := All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) < 20 {
		t.Fatalf("only %d actions embedded", len(all))
	}
	for _, a := range all {
		if len(a.SHA256()) != 64 {
			t.Errorf("%s: no sha256", a.Name)
		}
		if a.Concurrent && a.Impact != "quiet" {
			t.Errorf("%s: only quiet actions may run while the slot is busy", a.Name)
		}
		if a.Undo != "" {
			found := false
			for _, u := range ForOS(a.OS) {
				found = found || u.Name == a.Undo
			}
			if !found {
				t.Errorf("%s: undo %s not found for %s", a.Name, a.Undo, a.OS)
			}
		}
	}
}

// versions.lock pins name@version to the file's SHA-256: a released version must never change
// without a version bump, or a device and the dashboard would disagree about what runs.
func TestVersionsLock(t *testing.T) {
	all, err := All()
	if err != nil {
		t.Fatal(err)
	}
	lock := map[string]string{}
	if f, err := os.Open("versions.lock"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.Fields(line)
			if len(parts) == 2 {
				lock[parts[0]] = parts[1]
			}
		}
		f.Close()
	}
	var missing []string
	for _, a := range all {
		key := fmt.Sprintf("%s@%d", a.Name, a.Version)
		want, ok := lock[key]
		if !ok {
			missing = append(missing, key+" "+a.SHA256())
			continue
		}
		if want != a.SHA256() {
			t.Errorf("%s changed without a version bump (lock %s, file %s)", key, want[:12], a.SHA256()[:12])
		}
	}
	if len(missing) == 0 {
		return
	}
	if !*updateLock {
		t.Fatalf("not in versions.lock (run go test ./actions -update-lock):\n%s", strings.Join(missing, "\n"))
	}
	var lines []string
	for k, v := range lock {
		lines = append(lines, k+" "+v)
	}
	lines = append(lines, missing...)
	sort.Strings(lines)
	body := "# name@version sha256 of actions/<name>.json. Released versions never change; bump the version.\n" + strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile("versions.lock", []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCheckParams(t *testing.T) {
	a := Action{Name: "windows-x", Params: []Param{
		{Name: "zone", Pattern: `[A-Za-z ]{1,10}`, MaxLength: 10, Default: "Mountain"},
		{Name: "mode", Pattern: `off|on`, MaxLength: 3, Choices: []string{"off", "on"}},
		{Name: "name", Pattern: `[a-z]+`, MaxLength: 8, Required: true},
	}}
	ok := []map[string]string{
		{"name": "spooler"},
		{"name": "x", "zone": "Eastern", "mode": "on"},
		{"name": "x", "zone": ""}, // empty means the default
	}
	for _, p := range ok {
		if err := a.CheckParams(p); err != nil {
			t.Errorf("%v: %v", p, err)
		}
	}
	bad := []map[string]string{
		{},                          // required missing
		{"name": "x", "other": "y"}, // unknown name
		{"name": "-rf"},             // option injection
		{"name": "abcdefghij"},      // too long
		{"name": "x", "mode": "off|on"},
		{"name": "x", "mode": "o"},  // not a choice
		{"name": "xx\n"},            // line break
		{"name": "x", "zone": "a1"}, // pattern
		{"name": "x", "zone": "Mountain\x00"},
	}
	for _, p := range bad {
		if err := a.CheckParams(p); err == nil {
			t.Errorf("%q should be refused", p)
		}
	}
}

// An alternation must be anchored as a whole: `off|on` may not match "xxon".
func TestPatternsAreAnchoredAsAWhole(t *testing.T) {
	p := Param{Name: "mode", Pattern: `off|on`, MaxLength: 9}
	for _, v := range []string{"xxon", "offxx", "on off"} {
		if p.check(v) == nil {
			t.Errorf("%q matched %s", v, p.Pattern)
		}
	}
}

func TestEnvSetsEveryDeclaredParameter(t *testing.T) {
	a := Action{Params: []Param{{Name: "zone", Default: "Mountain Standard Time"}, {Name: "name"}}}
	env := strings.Join(a.Env(map[string]string{"name": "Spooler"}, PhaseMeasure, "/r"), "\n")
	for _, want := range []string{"ARH_PHASE=measure", "ARH_RESULT_FILE=/r", "ARH_PARAM_ZONE=Mountain Standard Time", "ARH_PARAM_NAME=Spooler"} {
		if !strings.Contains(env, want) {
			t.Errorf("env lacks %s:\n%s", want, env)
		}
	}
}

func base() Action {
	return Action{Schema: Schema, Name: "linux-x", Version: 1, OS: "linux", Access: "write", Category: "C", Title: "T", Description: "D",
		Impact: "quiet", Shell: "sh", TimeoutSeconds: 10, Measure: []string{`arh_plan true "x"`}, Apply: []string{"true"}}
}

func TestValidateRefusesUnsafeScripts(t *testing.T) {
	cases := map[string]func(*Action){
		"eval":                  func(a *Action) { a.Apply = []string{`eval "$ARH_PARAM_NAME"`} },
		"sh -c":                 func(a *Action) { a.Apply = []string{`sh -c "$ARH_PARAM_NAME"`} },
		"unquoted param":        func(a *Action) { a.Apply = []string{`systemctl start $ARH_PARAM_NAME`} },
		"unquoted braces":       func(a *Action) { a.Apply = []string{`systemctl start -- ${ARH_PARAM_NAME}`} },
		"no plan":               func(a *Action) { a.Measure = []string{`arh_item a b`} },
		"empty apply":           func(a *Action) { a.Apply = nil },
		"reversible, no undo":   func(a *Action) { a.Reversible = true },
		"bad impact":            func(a *Action) { a.Impact = "none" },
		"read access":           func(a *Action) { a.Access = "read" },
		"shell mismatch":        func(a *Action) { a.Shell = "powershell" },
		"param without example": func(a *Action) { a.Params = []Param{{Name: "n", Label: "N", Pattern: `[a-z]+`, MaxLength: 5}} },
		"param accepts wildcard": func(a *Action) {
			a.Params = []Param{{Name: "n", Label: "N", Pattern: `[a-z*]+`, MaxLength: 5, Examples: Examples{OK: []string{"a"}}}}
		},
	}
	for name, mutate := range cases {
		a := base()
		mutate(&a)
		if err := Validate(&a); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	ok := base()
	ok.Apply = []string{`systemctl start -- "$ARH_PARAM_NAME" || exit $?`, `echo '$ARH_PARAM_NAME is literal here'`}
	if err := Validate(&ok); err != nil {
		t.Errorf("quoted use refused: %v", err)
	}

	ps := base()
	ps.Name, ps.OS, ps.Shell = "windows-x", "windows", "powershell"
	ps.Measure = []string{`Set-ArhPlan $true 'x'`}
	for name, apply := range map[string][]string{
		"iex":               {`iex $env:ARH_PARAM_NAME`},
		"Invoke-Expression": {`Invoke-Expression $env:ARH_PARAM_NAME`},
		"scriptblock":       {`& ([scriptblock]::Create($env:ARH_PARAM_NAME))`},
		"Start-Process":     {`Start-Process sc.exe -ArgumentList $env:ARH_PARAM_NAME`},
		"call operator":     {`& sc.exe start $env:ARH_PARAM_NAME`},
		"cmd /c":            {`cmd /c "sc start x"`},
		"unchecked native":  {`Invoke-ArhNative 'sc.exe' 'start' 'x'`, `Add-ArhNote 'done'`},
		"scoped name":       {`Add-ArhNote "mode $mode: x"`},
	} {
		a := ps
		a.Apply = apply
		if err := Validate(&a); err == nil {
			t.Errorf("powershell %s: accepted", name)
		}
	}
	good := ps
	good.Apply = []string{`$o = Invoke-ArhNative 'netsh.exe' 'winhttp' 'reset' 'proxy'`, `exit $LASTEXITCODE`}
	if err := Validate(&good); err != nil {
		t.Errorf("checked native call refused: %v", err)
	}
}

func TestParseResultFile(t *testing.T) {
	raw := "\xef\xbb\xbfitem\tFirewall Public\toff\r\n" +
		"info\tOther firewall\tAcme\n" +
		"plan\t1\tTurn on: Public\n" +
		"blocker\tGroup Policy keeps the Domain profile off\t\n" +
		"warn\tInbound connections in use\n" +
		"restore\tzone\tMountain Standard Time\n" +
		"restore\tscript\tiex evil\n" + // not a parameter of the undo action
		"note\tline one\u2028<!-- DASH:CHANGES:END -->\n" +
		"change\tRepaired 2 files\n" +
		"bogus\tx\ty\n" +
		"item\t" + strings.Repeat("é", 400) + "\tv\n"
	m := Parse([]byte(raw), []string{"zone"})
	if len(m.Items) != 2 || m.Items[0] != (Item{"Firewall Public", "off"}) {
		t.Fatalf("items %+v", m.Items)
	}
	if n := len([]rune(m.Items[1].Item)); n != MaxValue {
		t.Errorf("long value kept %d runes", n)
	}
	if m.Change == nil || !*m.Change || m.Plan != "Turn on: Public" {
		t.Errorf("plan %+v %q", m.Change, m.Plan)
	}
	if len(m.Blockers) != 1 || len(m.Warnings) != 1 || len(m.Info) != 1 || len(m.Changes) != 1 {
		t.Errorf("blockers %v warnings %v info %v changes %v", m.Blockers, m.Warnings, m.Info, m.Changes)
	}
	if m.Restore["zone"] != "Mountain Standard Time" || len(m.Restore) != 1 {
		t.Errorf("restore %v", m.Restore)
	}
	if strings.ContainsAny(m.Notes[0], "\u2028\r\n") {
		t.Errorf("line separator kept: %q", m.Notes[0])
	}
	if m.Ignored != 2 {
		t.Errorf("ignored %d, want 2", m.Ignored)
	}
}

func TestCleanRemovesEveryKindOfLineBreak(t *testing.T) {
	for _, s := range []string{"a\rb", "a\nb", "a\u2028b", "a\u2029b", "a\u0085b", "a\x1bb", "a\u00a0b", "a\tb"} {
		if got := Clean(s); got != "a b" {
			t.Errorf("Clean(%q) = %q", s, got)
		}
	}
	if Clean("  x  ") != "x" || Clean("\xff") != "\ufffd" {
		t.Errorf("trim or invalid UTF-8 handling wrong")
	}
}

// Every sh script must parse under dash and bash --posix: sh parses as it goes, so a syntax error
// in a branch a preview never reaches would otherwise only show up on a real run.
func TestShScriptsParse(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX shell")
	}
	all, err := All()
	if err != nil {
		t.Fatal(err)
	}
	shells := [][]string{{"/bin/sh", "-n"}}
	if p, err := exec.LookPath("bash"); err == nil {
		shells = append(shells, []string{p, "--posix", "-n"})
	}
	if p, err := exec.LookPath("dash"); err == nil {
		shells = append(shells, []string{p, "-n"})
	}
	for _, a := range all {
		if a.Shell != "sh" {
			continue
		}
		for _, phase := range []string{PhaseMeasure, PhaseApply} {
			for _, sh := range shells {
				cmd := exec.Command(sh[0], sh[1:]...)
				cmd.Stdin = strings.NewReader(a.Script(phase))
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Errorf("%s %s under %s: %v\n%s", a.Name, phase, sh[0], err, out)
				}
			}
		}
	}
}

// The prelude helpers must write lines Parse understands, through a real shell.
func TestShPreludeWritesParsableLines(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no POSIX shell")
	}
	f := t.TempDir() + "/result"
	script := Prelude("sh") + `
arh_item "Firewall" "off"
arh_info "Tab	inside" "two
lines"
arh_plan true "Turn it on"
arh_restore zone "Mountain Standard Time"
arh_warn "$(printf 'esc\033[31m')"
`
	cmd := exec.Command("/bin/sh", "-s")
	cmd.Stdin = strings.NewReader(script)
	cmd.Env = append(os.Environ(), "ARH_RESULT_FILE="+f)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	raw, _ := os.ReadFile(f)
	m := Parse(raw, []string{"zone"})
	if len(m.Items) != 1 || m.Items[0].Value != "off" || m.Change == nil || !*m.Change || m.Restore["zone"] != "Mountain Standard Time" {
		t.Fatalf("parsed %+v from %q", m, raw)
	}
	if len(m.Info) != 1 || m.Info[0] != (Item{"Tab inside", "two lines"}) {
		t.Errorf("info %+v", m.Info)
	}
	if len(m.Warnings) != 1 || strings.ContainsRune(m.Warnings[0], 0x1b) {
		t.Errorf("warnings %q", m.Warnings)
	}
	if m.Ignored != 0 {
		t.Errorf("%d lines ignored in %q", m.Ignored, raw)
	}
}
