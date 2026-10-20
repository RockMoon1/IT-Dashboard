package policy

import "os"

func isWindows() bool { return true }

// On Windows the data folder's ACL (SYSTEM and Administrators only, set at install) is what
// protects the file; there is no POSIX owner to check.
func checkOwner(string, os.FileInfo) error { return nil }
