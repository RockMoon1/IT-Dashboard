//go:build !windows

package fsowner

import (
	"fmt"
	"os"
	"syscall"
)

// trusted: owned by root or by the agent's own user.
func trusted(path string) (bool, string, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return false, "", err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return false, "", fmt.Errorf("cannot read the owner of %s", path)
	}
	owner := fmt.Sprintf("uid %d", st.Uid)
	return st.Uid == 0 || int(st.Uid) == os.Geteuid(), owner, nil
}
