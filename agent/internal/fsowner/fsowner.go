// Package fsowner says whether a file or folder belongs to an account the agent can trust:
// one that a standard user on the computer could not be. The agent runs as SYSTEM or root and
// keeps its key, its pinned dashboard and its policy in its data folder, so a folder or file a
// standard user owns (and so can change the permissions of) must never be trusted.
package fsowner

// Trusted reports whether path is owned by a trusted account, naming the owner either way.
func Trusted(path string) (bool, string, error) { return trusted(path) }
