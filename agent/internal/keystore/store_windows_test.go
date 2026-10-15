package keystore

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDPAPIRoundTripAndNoPlaintextOnDisk(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	if _, err := s.Load("k"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	secret := []byte("-----BEGIN PRIVATE KEY----- not really")
	if err := s.Save("k", secret); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "k.dpapi"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, secret) {
		t.Fatal("secret stored in plaintext")
	}
	got, err := s.Load("k")
	if err != nil || !bytes.Equal(got, secret) {
		t.Fatalf("load: %q %v", got, err)
	}
	if err := s.Delete("k"); err != nil {
		t.Fatal(err)
	}
}
