//go:build !windows

package executor

import (
	"os/exec"
	"syscall"
)

// configureKill puts the child in its own process group and kills the whole group on timeout,
// so a long-running grandchild (sleep, system_profiler, …) cannot keep the pipes open.
func configureKill(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
