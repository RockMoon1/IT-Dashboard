//go:build !windows

package policy

import (
	"fmt"
	"os"
	"syscall"
)

func isWindows() bool { return false }

// checkOwner refuses a policy file that someone other than the agent's own user could have
// written: owned by another user, or writable by group or others.
func checkOwner(path string, info os.FileInfo) error {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("cannot read the policy file's owner")
	}
	if int(st.Uid) != os.Geteuid() {
		return fmt.Errorf("policy file %s is owned by uid %d, not by the agent (uid %d)", path, st.Uid, os.Geteuid())
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("policy file %s is writable by group or others (%s)", path, info.Mode().Perm())
	}
	return nil
}
