package keystore

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// DPAPI with CRYPTPROTECT_LOCAL_MACHINE: the blob can only be decrypted on this machine. The
// file is additionally restricted to SYSTEM and Administrators by the installer (icacls).

var (
	crypt32                = syscall.NewLazyDLL("crypt32.dll")
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procCryptProtectData   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFree          = kernel32.NewProc("LocalFree")
)

const (
	cryptProtectUIForbidden  = 0x1
	cryptProtectLocalMachine = 0x4
)

// entropy binds the blob to this application; it is not a secret.
var entropy = []byte("ARH-IT-Dashboard-agent-v1")

type dataBlob struct {
	cbData uint32
	pbData *byte
}

func blobOf(b []byte) dataBlob {
	if len(b) == 0 {
		return dataBlob{}
	}
	return dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
}

func (b dataBlob) bytes() []byte {
	if b.pbData == nil || b.cbData == 0 {
		return nil
	}
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	return out
}

func protect(data []byte) ([]byte, error) {
	in := blobOf(data)
	ent := blobOf(entropy)
	var out dataBlob
	r, _, err := procCryptProtectData.Call(
		uintptr(unsafe.Pointer(&in)), 0, uintptr(unsafe.Pointer(&ent)), 0, 0,
		cryptProtectUIForbidden|cryptProtectLocalMachine, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}

func unprotect(data []byte) ([]byte, error) {
	in := blobOf(data)
	ent := blobOf(entropy)
	var out dataBlob
	r, _, err := procCryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&in)), 0, uintptr(unsafe.Pointer(&ent)), 0, 0,
		cryptProtectUIForbidden, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return nil, err
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return out.bytes(), nil
}

type dpapiStore struct{ dir string }

func newStore(dataDir string) Store { return &dpapiStore{dir: dataDir} }

func (s *dpapiStore) path(name string) string { return filepath.Join(s.dir, name+".dpapi") }

func (s *dpapiStore) Save(name string, secret []byte) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	blob, err := protect(secret)
	if err != nil {
		return err
	}
	return os.WriteFile(s.path(name), blob, 0o600)
}

func (s *dpapiStore) Load(name string) ([]byte, error) {
	blob, err := os.ReadFile(s.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return unprotect(blob)
}

func (s *dpapiStore) Delete(name string) error {
	err := os.Remove(s.path(name))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *dpapiStore) Describe() string { return "Windows DPAPI (machine scope) blob in " + s.dir }
