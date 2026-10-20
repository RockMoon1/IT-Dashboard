package executor

import (
	"context"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/RockMoon1/IT-Dashboard/actions"
	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// approved verbs, so words like "Real-Time" or DISM's "/Cleanup-Image" in a script are not taken
// for commands
var verbs = regexp.MustCompile(`^(?i)(Add|Clear|Confirm|ConvertFrom|ConvertTo|Disable|Enable|Export|ForEach|Format|Get|Group|Import|Invoke|Join|Measure|New|Out|Read|Register|Remove|Rename|Resolve|Restart|Resume|Select|Set|Sort|Split|Start|Stop|Suspend|Test|Unregister|Update|Wait|Where|Write)-`)
var defined = regexp.MustCompile(`function\s+([A-Za-z]+-[A-Za-z0-9]+)`)

// With PowerShell's own module search turned off, every command the shipped profiles and actions
// use must still be found: proof that each is imported by path, so no launch ever searches.
// Opt-in (ARH_LIVE_ACTIONS=1 or ARH_LIVE_APPLY=1); it only asks Get-Command.
func TestShippedCommandsLoadWithoutLookup(t *testing.T) {
	if os.Getenv("ARH_LIVE_ACTIONS") != "1" && os.Getenv("ARH_LIVE_APPLY") != "1" {
		t.Skip("set ARH_LIVE_ACTIONS=1 on Windows")
	}
	noAutoload = true
	defer func() { noAutoload = false }()
	scripts := map[string]string{}
	for _, p := range profiles.ForOS("windows") {
		for _, c := range p.Checks {
			if c.Shell == "powershell" {
				scripts[p.Name+"/"+c.ID] = c.Script()
			}
		}
	}
	for _, a := range actions.ForOS("windows") {
		scripts[a.Name+"/measure"] = a.Script(actions.PhaseMeasure)
		scripts[a.Name+"/apply"] = a.Script(actions.PhaseApply)
	}
	names := make([]string, 0, len(scripts))
	for n := range scripts {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, name := range names {
		script := scripts[name]
		own := map[string]bool{}
		for _, m := range defined.FindAllStringSubmatch(script, -1) {
			own[strings.ToLower(m[1])] = true
		}
		seen := map[string]bool{}
		var want []string
		for _, w := range commandWord.FindAllString(script, -1) {
			k := strings.ToLower(w)
			if verbs.MatchString(w) && !own[k] && !seen[k] {
				seen[k] = true
				want = append(want, "'"+w+"'")
			}
		}
		if len(want) == 0 {
			continue
		}
		probe := "foreach ($n in @(" + strings.Join(want, ",") + ")) { if (-not (Get-Command -Name $n -ErrorAction SilentlyContinue)) { 'MISSING ' + $n } }"
		var out strings.Builder
		r := Run(context.Background(), profiles.Check{ID: "probe", Shell: "powershell", Command: []string{probe}, TimeoutSeconds: 120,
			CleanEnv: true, FixedPath: true, LongScript: true}, func(_ string, b []byte) { out.Write(b) })
		if r.ExitCode != 0 || strings.Contains(out.String(), "MISSING") {
			t.Errorf("%s: exit %d\n%s", name, r.ExitCode, strings.TrimSpace(out.String()))
		}
	}
}
