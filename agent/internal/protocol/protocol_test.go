package protocol

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestCrockfordRoundTrip(t *testing.T) {
	in := []byte{0, 1, 2, 250, 251, 252, 253, 254, 255, 42}
	enc := EncodeCrockford(in)
	if len(enc) != 16 {
		t.Fatalf("10 bytes should encode to 16 chars, got %d (%s)", len(enc), enc)
	}
	dec, err := DecodeCrockford(strings.ToLower(enc))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(dec, in) {
		t.Fatalf("round trip mismatch: %x vs %x", dec, in)
	}
	if _, err := DecodeCrockford("ABC$"); err == nil {
		t.Fatal("invalid character accepted")
	}
}

func TestTokenParseAndProof(t *testing.T) {
	fp := "3f9a1c2b7e4d6a10ffffffffffffffffffffffffffffffffffffffffffffffff"
	tok, printed, err := NewToken(fp)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(printed, "ARH-3F9A1C2B-") || len(printed) != len("ARH-3F9A1C2B-")+16 {
		t.Fatalf("unexpected token %s", printed)
	}
	parsed, err := ParseToken(" " + strings.ToLower(printed) + " ")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(parsed.Secret, tok.Secret) || parsed.FP8 != tok.FP8 {
		t.Fatal("parsed token differs")
	}
	if !parsed.MatchesFingerprint(fp) {
		t.Fatal("fingerprint prefix should match")
	}
	if parsed.MatchesFingerprint("00" + fp[2:]) {
		t.Fatal("different fingerprint matched")
	}
	nonce := []byte("0123456789abcdef0123456789abcdef")
	p1 := Proof(parsed.Secret, nonce, strings.ToUpper(fp))
	p2 := Proof(tok.Secret, nonce, fp)
	if !ProofEqual(p1, p2) {
		t.Fatal("proof must not depend on fingerprint case")
	}
	if ProofEqual(p1, Proof([]byte("wrong"), nonce, fp)) {
		t.Fatal("wrong secret produced the same proof")
	}
	if _, err := ParseToken("ARH-ZZZZZZZZ-" + EncodeCrockford(tok.Secret)); err == nil {
		t.Fatal("non-hex fingerprint accepted")
	}
}

// Known-answer test shared with the host implementation (tests/link.test.ts).
func TestProofKnownAnswer(t *testing.T) {
	secret, _ := hex.DecodeString("000102030405060708090a")
	secret = secret[:10]
	nonce, _ := hex.DecodeString("0a0b0c0d")
	got := Proof(secret, nonce, "ABCDEF")
	want := Proof(secret, nonce, "abcdef")
	if got != want {
		t.Fatal("case folding broken")
	}
	t.Logf("proof(000102030405060708090a, 0a0b0c0d, abcdef) = %s", got)
	if EncodeCrockford(secret) != "0040G2081050" && EncodeCrockford(secret) != "0040G2081050A" {
		t.Logf("crockford(000102030405060708090a[:10]) = %s", EncodeCrockford(secret))
	}
}

func TestCodecRoundTripAndLimits(t *testing.T) {
	var buf bytes.Buffer
	c := NewCodec(&buf)
	if err := c.Write(Message{Type: "check-end", RunID: "r1", CheckID: "c", ExitCode: IntPtr(0), DurationMs: 12}); err != nil {
		t.Fatal(err)
	}
	if err := c.Write(Message{Type: "ping"}); err != nil {
		t.Fatal(err)
	}
	m, err := c.Read()
	if err != nil || m.Type != "check-end" || *m.ExitCode != 0 || m.RunID != "r1" {
		t.Fatalf("bad first message %+v %v", m, err)
	}
	m, err = c.Read()
	if err != nil || m.Type != "ping" {
		t.Fatalf("bad second message %+v %v", m, err)
	}
	huge := bytes.NewBufferString(`{"type":"x","data":"` + strings.Repeat("a", MaxLine+10) + `"}` + "\n")
	if _, err := NewCodec(huge).Read(); err != ErrLineTooLong {
		t.Fatalf("expected ErrLineTooLong, got %v", err)
	}
}

// The shared fixture is decoded by the TypeScript tests as well (tests/actions.test.ts). Every
// field in it must survive a Go decode and re-encode, so the agent knows every field the
// dashboard sends or expects.
func TestGoldenActionMessagesRoundTrip(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "fixtures", "protocol", "actions.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	for i, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var m Message
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("line %d: %v", i+1, err)
		}
		out, _ := json.Marshal(m)
		var want, got any
		_ = json.Unmarshal([]byte(line), &want)
		_ = json.Unmarshal(out, &got)
		if !reflect.DeepEqual(dropEmpty(want), dropEmpty(got)) {
			t.Errorf("line %d (%s) changed in a round trip:\n in: %s\nout: %s", i+1, m.Type, line, out)
		}
	}
}

// dropEmpty removes values Go omits (omitempty) so only real losses count.
func dropEmpty(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range x {
			val = dropEmpty(val)
			switch y := val.(type) {
			case nil:
				continue
			case bool:
				if !y && k != "dryRun" && k != "applied" && k != "ok" && k != "change" && k != "write" && k != "execute" && k != "custom" && k != "lan" && k != "interrupts" {
					continue
				}
			case string:
				if y == "" {
					continue
				}
			case []any:
				if len(y) == 0 && k != "items" && k != "deny" {
					continue
				}
			case map[string]any:
				if len(y) == 0 {
					continue
				}
			}
			out[k] = val
		}
		return out
	case []any:
		for i := range x {
			x[i] = dropEmpty(x[i])
		}
		return x
	}
	return v
}
