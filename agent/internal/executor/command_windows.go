package executor

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"unicode/utf16"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

const preamble = "$ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'; try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}\n"

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

func powerShellPath() string {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	p := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return "powershell.exe"
}

func command(ctx context.Context, check profiles.Check) (*exec.Cmd, error) {
	if check.Shell != "powershell" {
		return nil, fmt.Errorf("shell %q is not available on Windows", check.Shell)
	}
	cmd := exec.CommandContext(ctx, powerShellPath(),
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-OutputFormat", "Text", "-EncodedCommand", EncodeCommand(preamble+check.Script()+"\n"))
	return cmd, nil
}
