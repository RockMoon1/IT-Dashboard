package policy

import (
	"fmt"
	"os"

	"github.com/RockMoon1/IT-Dashboard/agent/internal/fsowner"
)

func isWindows() bool { return true }

// checkOwner refuses a policy file a standard user could have made or could change: it must
// belong to SYSTEM, the Administrators group or one of its members. (The data folder's ACL, set
// at install, also keeps everyone else out.)
func checkOwner(path string, _ os.FileInfo) error {
	ok, owner, err := fsowner.Trusted(path)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("policy file %s belongs to %s, not to SYSTEM or an administrator", path, owner)
	}
	return nil
}
