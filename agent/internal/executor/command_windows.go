package executor

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// noAutoload turns PowerShell's own module search off; tests set it to prove that every command
// the shipped scripts use is imported by path.
var noAutoload = false

const preamble = "$ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'; try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}\n"

// bootstrap reads the real script from standard input as UTF-8 and runs it. Long scripts (custom
// commands, actions) go this way: the command line is limited to 32,767 characters and
// -EncodedCommand costs about 2.7 per script character, and a temp file could be swapped by
// another user before SYSTEM runs it.
const bootstrap = preamble + "$arhIn = [Console]::OpenStandardInput(); $arhBuf = New-Object System.IO.MemoryStream; $arhIn.CopyTo($arhBuf); " +
	"$arhSrc = [System.Text.Encoding]::UTF8.GetString($arhBuf.ToArray()); Remove-Variable arhIn, arhBuf; " +
	"& ([scriptblock]::Create($arhSrc))\n"

// EncodeCommand produces the base64 UTF-16LE form PowerShell's -EncodedCommand expects.
func EncodeCommand(script string) string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 2*len(u))
	for i, v := range u {
		b[2*i] = byte(v)
		b[2*i+1] = byte(v >> 8)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func systemRoot() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return root
	}
	return `C:\Windows`
}

func systemPath() string {
	r := systemRoot()
	return strings.Join([]string{r + `\System32`, r, r + `\System32\Wbem`, r + `\System32\WindowsPowerShell\v1.0`}, ";")
}

func powerShellPath() string {
	p := filepath.Join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return "powershell.exe"
}

// command runs PowerShell 5.1 in a Job Object, so a timeout or abort ends every process the
// script started (sfc.exe, w32tm, anything a custom command launched), not only powershell.exe.
func command(ctx context.Context, check profiles.Check) (*exec.Cmd, hooks, error) {
	if check.Shell != "powershell" {
		return nil, hooks{}, fmt.Errorf("shell %q is not available on Windows", check.Shell)
	}
	args := []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-OutputFormat", "Text", "-EncodedCommand"}
	var cmd *exec.Cmd
	// the modules the script needs, loaded by full path first (see modules.go)
	imports := importLines(check.Script())
	if noAutoload {
		imports = "$PSModuleAutoLoadingPreference = 'None'\n" + imports
	}
	if check.LongScript {
		cmd = exec.CommandContext(ctx, powerShellPath(), append(args, EncodeCommand(imports+bootstrap))...)
		cmd.Stdin = strings.NewReader(check.Script() + "\n")
	} else {
		cmd = exec.CommandContext(ctx, powerShellPath(), append(args, EncodeCommand(imports+preamble+check.Script()+"\n"))...)
	}
	if check.CleanEnv || check.FixedPath || len(check.Env) > 0 {
		cmd.Env = childEnv(cmd.Environ(), check)
	}
	if check.FixedPath {
		cmd.Dir = filepath.Join(systemRoot(), "System32")
	}
	job := newJob()
	cmd.Cancel = func() error {
		job.terminate()
		return cmd.Process.Kill()
	}
	return cmd, hooks{
		afterStart: func() { job.assign(cmd.Process.Pid) },
		done:       job.close,
	}, nil
}
