//go:build !windows

package executor

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

func command(ctx context.Context, check profiles.Check) (*exec.Cmd, error) {
	if check.Shell != "sh" {
		return nil, fmt.Errorf("shell %q is not available on this platform", check.Shell)
	}
	cmd := exec.CommandContext(ctx, "/bin/sh", "-s")
	cmd.Stdin = strings.NewReader(check.Script() + "\n")
	cmd.Env = append(cmd.Environ(), "LC_ALL=C.UTF-8", "LANG=C.UTF-8")
	return cmd, nil
}
