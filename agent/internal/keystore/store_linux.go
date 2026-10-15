package keystore

import (
	"errors"
	"os"
	"path/filepath"
)

// A system daemon has no session bus for the Secret Service, so the key lives in a 0600 file
// owned by root inside a 0700 directory. This is the same posture as /etc/ssh host keys.

type fileStore struct{ dir string }

func newStore(dataDir string) Store { return &fileStore{dir: dataDir} }

func (s *fileStore) path(name string) string { return filepath.Join(s.dir, name+".key") }

func (s *fileStore) Save(name string, secret []byte) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	tmp := s.path(name) + ".tmp"
	if err := os.WriteFile(tmp, secret, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path(name))
}

func (s *fileStore) Load(name string) ([]byte, error) {
	b, err := os.ReadFile(s.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return b, err
}

func (s *fileStore) Delete(name string) error {
	err := os.Remove(s.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *fileStore) Describe() string { return "root-only file (0600) in " + s.dir }
