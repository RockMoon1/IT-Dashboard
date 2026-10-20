//go:build !windows

package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"syscall"

	"github.com/RockMoon1/IT-Dashboard/profiles"
)

func systemRoot() string { return "" }

func systemPath() string { return "/usr/sbin:/usr/bin:/sbin:/bin" }

// command hands the script to /bin/sh on file descriptor 3, with standard input empty, so a
// command in the script that reads input (read, a prompt, an installer) gets end of file instead
// of swallowing the rest of the script. The child gets its own process group, and a timeout or
// abort kills the whole group, so a long-running grandchild cannot outlive the run.
func command(ctx context.Context, check profiles.Check) (*exec.Cmd, hooks, error) {
	if check.Shell != "sh" {
		return nil, hooks{}, fmt.Errorf("shell %q is not available on this platform", check.Shell)
	}
	r, w, err := os.Pipe()
	if err != nil {
		return nil, hooks{}, err
	}
	cmd := exec.CommandContext(ctx, "/bin/sh", "/dev/fd/3")
	cmd.ExtraFiles = []*os.File{r}
	cmd.Env = childEnv(append(cmd.Environ(), "LC_ALL=C.UTF-8", "LANG=C.UTF-8"), check)
	if check.FixedPath {
		cmd.Dir = "/"
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	script := check.Script() + "\n"
	started := false
	return cmd, hooks{
		afterStart: func() {
			started = true
			r.Close() // the child holds its own copy
			go func() {
				_, _ = w.WriteString(script) // EPIPE if the script exits before reading it all
				w.Close()
			}()
		},
		done: func() {
			if !started {
				r.Close()
				w.Close()
			}
		},
	}, nil
}
