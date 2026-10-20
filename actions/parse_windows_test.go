package actions

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Every PowerShell script (prelude included) must parse with zero errors in Windows PowerShell
// 5.1, the version the agent runs.
func TestPowerShellScriptsParse(t *testing.T) {
	all, err := All()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	var files []string
	for _, a := range all {
		if a.Shell != "powershell" {
			continue
		}
		for _, phase := range []string{PhaseMeasure, PhaseApply} {
			p := filepath.Join(dir, a.Name+"."+phase+".ps1")
			if err := os.WriteFile(p, []byte(a.Script(phase)), 0o600); err != nil {
				t.Fatal(err)
			}
			files = append(files, p)
		}
	}
	script := `$bad = 0
foreach ($f in $args) {
  $errs = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs)
  foreach ($e in $errs) { $bad++; Write-Output ("{0}:{1}: {2}" -f (Split-Path $f -Leaf), $e.Extent.StartLineNumber, $e.Message) }
}
exit $bad`
	runner := filepath.Join(dir, "parse.ps1")
	if err := os.WriteFile(runner, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	ps := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := exec.Command(ps, append([]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner}, files...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("parse errors:\n%s", strings.TrimSpace(string(out)))
	}
	if len(files) < 20 {
		t.Fatalf("only %d scripts parsed", len(files))
	}
}
