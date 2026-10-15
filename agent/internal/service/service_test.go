package service

import (
	"path/filepath"
	"testing"
)

func TestPendingTokenRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if _, err := ReadPendingToken(dir); err == nil {
		t.Fatal("expected error when no token stored")
	}
	if err := WritePendingToken(dir, "  ARH-ABCDEF01-0123456789ABCDEF \n"); err != nil {
		t.Fatal(err)
	}
	tok, err := ReadPendingToken(dir)
	if err != nil || tok != "ARH-ABCDEF01-0123456789ABCDEF" {
		t.Fatalf("got %q %v", tok, err)
	}
	if err := ClearPendingToken(dir); err != nil {
		t.Fatal(err)
	}
	if err := ClearPendingToken(dir); err != nil {
		t.Fatal("clearing twice must be fine")
	}
	l := DefaultLayout()
	if l.ExePath == "" || filepath.Base(l.ExePath) == "" || l.DataDir == "" {
		t.Fatalf("incomplete layout %+v", l)
	}
}
