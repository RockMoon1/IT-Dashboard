// Package keystore keeps the device private key out of plaintext files using the platform's
// own facility: DPAPI (machine scope) on Windows, the System keychain on macOS, and a root-only
// 0600 file on Linux where a system daemon has no session keyring.
package keystore

import "errors"

// ErrNotFound is returned by Load when no secret is stored under the name.
var ErrNotFound = errors.New("keystore: secret not found")

type Store interface {
	Save(name string, secret []byte) error
	Load(name string) ([]byte, error)
	Delete(name string) error
	// Describe names the mechanism for logs and the dashboard.
	Describe() string
}

// New returns the store for this platform. dataDir is used by file-backed stores.
func New(dataDir string) Store { return newStore(dataDir) }
