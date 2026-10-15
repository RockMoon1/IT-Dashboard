//go:build linux

package keystore

import (
	"bytes"
	"errors"
	"testing"
)

func TestFileStoreRoundTrip(t *testing.T) {
	s := New(t.TempDir())
	if _, err := s.Load("k"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
	if err := s.Save("k", []byte("secret")); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load("k")
	if err != nil || !bytes.Equal(got, []byte("secret")) {
		t.Fatalf("load: %q %v", got, err)
	}
	if err := s.Delete("k"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("k"); err != nil {
		t.Fatal("second delete should be a no-op")
	}
}
