package executor

import (
	"runtime"
	"strings"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// childEnv builds the environment for one run from the agent's own. Actions and custom commands
// never see an inherited ARH_* variable, so a value can only come from the request; actions also
// get the system PATH only, so a folder an ordinary user can write to is never searched.
func childEnv(base []string, check profiles.Check) []string {
	out := make([]string, 0, len(base)+len(check.Env)+2)
	for _, kv := range base {
		name, _, _ := strings.Cut(kv, "=")
		upper := strings.ToUpper(name)
		if check.CleanEnv && (strings.HasPrefix(upper, "ARH_") || (runtime.GOOS == "windows" && upper == "PSMODULEPATH")) {
			continue
		}
		if check.FixedPath && upper == "PATH" {
			continue
		}
		out = append(out, kv)
	}
	if check.CleanEnv && runtime.GOOS == "windows" {
		out = append(out, `PSModulePath=`+systemRoot()+`\System32\WindowsPowerShell\v1.0\Modules`)
	}
	if check.FixedPath {
		out = append(out, "PATH="+systemPath())
	}
	return append(out, check.Env...)
}
