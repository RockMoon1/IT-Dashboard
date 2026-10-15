package protocol

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// Token is the one-time enrollment token: ARH-<fp8>-<secret16>.
// fp8 is the first 8 hex characters of the host certificate's SHA-256 fingerprint;
// secret16 is 80 random bits in Crockford base32.
type Token struct {
	FP8    string
	Secret []byte
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// EncodeCrockford encodes bytes without padding.
func EncodeCrockford(b []byte) string {
	var out strings.Builder
	var acc uint32
	bits := 0
	for _, c := range b {
		acc = acc<<8 | uint32(c)
		bits += 8
		for bits >= 5 {
			bits -= 5
			out.WriteByte(crockford[(acc>>uint(bits))&31])
		}
	}
	if bits > 0 {
		out.WriteByte(crockford[(acc<<uint(5-bits))&31])
	}
	return out.String()
}

// DecodeCrockford is case-insensitive and maps I/L to 1 and O to 0 like the spec suggests.
func DecodeCrockford(s string) ([]byte, error) {
	s = strings.ToUpper(strings.ReplaceAll(s, "-", ""))
	var out []byte
	var acc uint32
	bits := 0
	for _, r := range s {
		switch r {
		case 'I', 'L':
			r = '1'
		case 'O':
			r = '0'
		}
		idx := strings.IndexRune(crockford, r)
		if idx < 0 {
			return nil, fmt.Errorf("invalid base32 character %q", r)
		}
		acc = acc<<5 | uint32(idx)
		bits += 5
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(acc>>uint(bits)))
		}
	}
	return out, nil
}

// NewToken creates a token bound to a host fingerprint (full hex).
func NewToken(hostFingerprint string) (Token, string, error) {
	if len(hostFingerprint) < 8 {
		return Token{}, "", errors.New("host fingerprint too short")
	}
	secret := make([]byte, 10)
	if _, err := rand.Read(secret); err != nil {
		return Token{}, "", err
	}
	t := Token{FP8: strings.ToUpper(hostFingerprint[:8]), Secret: secret}
	return t, t.String(), nil
}

func (t Token) String() string {
	return "ARH-" + strings.ToUpper(t.FP8) + "-" + EncodeCrockford(t.Secret)
}

// ParseToken accepts the printed form, tolerating lower case and surrounding spaces.
func ParseToken(s string) (Token, error) {
	s = strings.ToUpper(strings.TrimSpace(s))
	parts := strings.Split(s, "-")
	if len(parts) != 3 || parts[0] != "ARH" {
		return Token{}, errors.New("token must look like ARH-XXXXXXXX-XXXXXXXXXXXXXXXX")
	}
	if len(parts[1]) != 8 {
		return Token{}, errors.New("token fingerprint part must be 8 hex characters")
	}
	if _, err := hex.DecodeString(strings.ToLower(parts[1])); err != nil {
		return Token{}, errors.New("token fingerprint part is not hex")
	}
	secret, err := DecodeCrockford(parts[2])
	if err != nil {
		return Token{}, err
	}
	if len(secret) != 10 {
		return Token{}, fmt.Errorf("token secret decodes to %d bytes, want 10", len(secret))
	}
	return Token{FP8: parts[1], Secret: secret}, nil
}

// MatchesFingerprint reports whether a full fingerprint (hex) starts with the token's fp8.
func (t Token) MatchesFingerprint(fingerprintHex string) bool {
	return strings.HasPrefix(strings.ToUpper(fingerprintHex), strings.ToUpper(t.FP8))
}

// Proof is HMAC-SHA256(secret, nonce || hostFingerprintHex) as lower-case hex. The host computes
// it to prove it knows the token secret; the agent verifies before pinning the host.
func Proof(secret []byte, nonce []byte, hostFingerprintHex string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(nonce)
	mac.Write([]byte(strings.ToLower(hostFingerprintHex)))
	return hex.EncodeToString(mac.Sum(nil))
}

func ProofEqual(a, b string) bool {
	return hmac.Equal([]byte(strings.ToLower(a)), []byte(strings.ToLower(b)))
}
