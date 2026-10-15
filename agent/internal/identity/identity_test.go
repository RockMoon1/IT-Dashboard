//go:build linux

package identity

import (
	"crypto/x509"
	"encoding/pem"
	"testing"

	"github.com/RockMoon1/IT-Dashboard/agent/internal/keystore"
)

func TestLoadOrCreateIsStable(t *testing.T) {
	dir := t.TempDir()
	store := keystore.New(dir)
	a, err := LoadOrCreate(store, dir, "host-a")
	if err != nil {
		t.Fatal(err)
	}
	b, err := LoadOrCreate(store, dir, "host-a")
	if err != nil {
		t.Fatal(err)
	}
	if a.Fingerprint != b.Fingerprint || len(a.Fingerprint) != 64 {
		t.Fatalf("fingerprint changed or malformed: %s vs %s", a.Fingerprint, b.Fingerprint)
	}
	block, _ := pem.Decode(a.CertPEM)
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Subject.CommonName != "host-a" || len(cert.ExtKeyUsage) != 1 || cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Fatalf("unexpected cert %+v", cert.Subject)
	}
}

func TestGenerateHostCert(t *testing.T) {
	hc, err := GenerateHostCert("ARH IT Dashboard")
	if err != nil {
		t.Fatal(err)
	}
	if len(hc.Fingerprint) != 64 || len(hc.KeyPEM) > 2000 {
		t.Fatalf("fingerprint %d chars, key %d bytes (must fit a Credential Manager blob)", len(hc.Fingerprint), len(hc.KeyPEM))
	}
	block, _ := pem.Decode([]byte(hc.KeyPEM))
	if _, err := x509.ParsePKCS8PrivateKey(block.Bytes); err != nil {
		t.Fatal(err)
	}
}
