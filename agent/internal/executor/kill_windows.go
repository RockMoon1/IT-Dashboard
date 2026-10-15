package executor

import "os/exec"

// On Windows the default Cancel (TerminateProcess) is used; WaitDelay in Run closes the pipes
// if a grandchild keeps them open after PowerShell is gone.
func configureKill(cmd *exec.Cmd) {}
