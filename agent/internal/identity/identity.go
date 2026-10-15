// Package identity creates and loads the device's TLS identity: an ECDSA P-256 key kept in the
// platform keystore and a self-signed certificate whose SHA-256 fingerprint is the device id.
package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"github.com/RockMoon1/IT-Dashboard/agent/internal/keystore"
)

const (
	KeyName      = "device-key"
	certFileName = "device.crt"
	validity     = 20 * 365 * 24 * time.Hour
)

type Identity struct {
	TLS         tls.Certificate
	Fingerprint string
	CertPEM     []byte
}

// Fingerprint is lower-case hex SHA-256 of the certificate DER.
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

func selfSigned(key *ecdsa.PrivateKey, cn string, server bool) ([]byte, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 126))
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: cn, Organization: []string{"ARH IT"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(validity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	if server {
		tmpl.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}
		tmpl.DNSNames = []string{"arh-dashboard.local"}
	}
	return x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
}

// LoadOrCreate returns the device identity, generating key and certificate on first use.
func LoadOrCreate(store keystore.Store, dataDir, commonName string) (*Identity, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	var key *ecdsa.PrivateKey
	raw, err := store.Load(KeyName)
	switch {
	case err == nil:
		k, perr := x509.ParsePKCS8PrivateKey(raw)
		if perr != nil {
			return nil, fmt.Errorf("stored device key is unreadable: %w", perr)
		}
		ec, ok := k.(*ecdsa.PrivateKey)
		if !ok {
			return nil, errors.New("stored device key is not ECDSA")
		}
		key = ec
	case errors.Is(err, keystore.ErrNotFound):
		key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return nil, err
		}
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return nil, err
		}
		if err := store.Save(KeyName, der); err != nil {
			return nil, fmt.Errorf("saving device key: %w", err)
		}
	default:
		return nil, err
	}

	certPath := filepath.Join(dataDir, certFileName)
	var certDER []byte
	if pemBytes, err := os.ReadFile(certPath); err == nil {
		if block, _ := pem.Decode(pemBytes); block != nil {
			if c, err := x509.ParseCertificate(block.Bytes); err == nil {
				if pub, ok := c.PublicKey.(*ecdsa.PublicKey); ok && pub.Equal(&key.PublicKey) && time.Now().Before(c.NotAfter) {
					certDER = block.Bytes
				}
			}
		}
	}
	if certDER == nil {
		certDER, err = selfSigned(key, commonName, false)
		if err != nil {
			return nil, err
		}
		pemBytes := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
		if err := os.WriteFile(certPath, pemBytes, 0o644); err != nil {
			return nil, err
		}
	}
	return &Identity{
		TLS:         tls.Certificate{Certificate: [][]byte{certDER}, PrivateKey: key},
		Fingerprint: Fingerprint(certDER),
		CertPEM:     pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}),
	}, nil
}

// HostCert is what `arh-agent host-cert` prints for the dashboard: a server certificate and a
// PKCS#8 key as PEM. The dashboard stores the key in Windows Credential Manager.
type HostCert struct {
	CertPEM     string `json:"certPem"`
	KeyPEM      string `json:"keyPem"`
	Fingerprint string `json:"fingerprint"`
	NotAfter    string `json:"notAfter"`
}

func GenerateHostCert(commonName string) (HostCert, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return HostCert{}, err
	}
	der, err := selfSigned(key, commonName, true)
	if err != nil {
		return HostCert{}, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return HostCert{}, err
	}
	cert, _ := x509.ParseCertificate(der)
	return HostCert{
		CertPEM:     string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		KeyPEM:      string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})),
		Fingerprint: Fingerprint(der),
		NotAfter:    cert.NotAfter.UTC().Format(time.RFC3339),
	}, nil
}
