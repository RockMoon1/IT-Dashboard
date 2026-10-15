//go:build !windows

package link

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/agent/internal/identity"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/keystore"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/protocol"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/service"
)

// A minimal in-process "dashboard": TLS server with the host certificate, enrollment proof,
// then a run request. Exercises the agent end to end without a network or PowerShell.
func TestEnrollThenRunProfile(t *testing.T) {
	dir := t.TempDir()
	hc, err := identity.GenerateHostCert("test-dashboard")
	if err != nil {
		t.Fatal(err)
	}
	serverCert, err := tls.X509KeyPair([]byte(hc.CertPEM), []byte(hc.KeyPEM))
	if err != nil {
		t.Fatal(err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientAuth: tls.RequestClientCert, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	tok, printed, err := protocol.NewToken(hc.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.WritePendingToken(dir, printed); err != nil {
		t.Fatal(err)
	}
	store := keystore.NewMemory()
	id, err := identity.LoadOrCreate(store, dir, "unit-test-device")
	if err != nil {
		t.Fatal(err)
	}
	agent := New(Config{DataDir: dir, Identity: id, Version: "test", Hostname: "unit-test-device", Serial: "SER123", OS: "linux", Logger: log.New(os.Stderr, "agent: ", 0)})

	results := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			results <- "accept: " + err.Error()
			return
		}
		defer conn.Close()
		tconn := conn.(*tls.Conn)
		if err := tconn.Handshake(); err != nil {
			results <- "handshake: " + err.Error()
			return
		}
		peer := tconn.ConnectionState().PeerCertificates
		if len(peer) == 0 || identity.Fingerprint(peer[0].Raw) != id.Fingerprint {
			results <- "client certificate not presented or wrong"
			return
		}
		codec := protocol.NewCodec(conn)
		m, err := codec.Read()
		if err != nil || m.Type != "enroll" || m.Token != printed || m.Serial != "SER123" {
			results <- "bad enroll message"
			return
		}
		nonce, _ := base64.StdEncoding.DecodeString(m.Nonce)
		_ = codec.Write(protocol.Message{Type: "enroll-proof", Proof: protocol.Proof(tok.Secret, nonce, hc.Fingerprint), HostFingerprint: hc.Fingerprint})
		m, err = codec.Read()
		if err != nil || m.Type != "enroll-confirm" {
			results <- "no enroll-confirm"
			return
		}
		_ = codec.Write(protocol.Message{Type: "enrolled", DeviceID: id.Fingerprint, DisplayName: "unit-test-device"})
		_ = codec.Write(protocol.Message{Type: "run", RunID: "r1", Profile: "linux-system-diagnostics", Version: 1})
		var types []string
		checks := 0
		for {
			m, err := codec.Read()
			if err != nil {
				results <- "read: " + err.Error()
				return
			}
			if m.Type == "ping" {
				continue
			}
			types = append(types, m.Type)
			if m.Type == "check-end" {
				checks++
			}
			if m.Type == "run-end" {
				if m.OK == nil {
					results <- "run-end without ok"
					return
				}
				results <- strings.Join(types, ",") + " checks=" + string(rune('0'+checks))
				_ = codec.Write(protocol.Message{Type: "bye"})
				return
			}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Drive the session directly instead of waiting for a UDP beacon.
	if err := agent.session(ctx, net.ParseIP("127.0.0.1"), "", port, hc.Fingerprint[:16]); err != nil {
		t.Fatalf("session: %v", err)
	}
	select {
	case r := <-results:
		if !strings.HasPrefix(r, "run-start,check-start") || !strings.Contains(r, "run-end") {
			t.Fatalf("unexpected server-side result: %s", r)
		}
		t.Log(r)
	case <-time.After(5 * time.Second):
		t.Fatal("server never reported")
	}
	rec, err := agent.loadHost()
	if err != nil || rec.Fingerprint != hc.Fingerprint {
		t.Fatalf("host not pinned: %+v %v", rec, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "enroll.token")); !os.IsNotExist(err) {
		t.Fatal("token should be consumed after enrollment")
	}
}

func TestBeaconParsingAndModeErrors(t *testing.T) {
	var b Beacon
	if err := json.Unmarshal([]byte(`{"arh":1,"port":47912,"fp":"abcd","hostId":"h"}`), &b); err != nil || b.Port != 47912 {
		t.Fatal("beacon did not parse")
	}
	dir := t.TempDir()
	store := keystore.NewMemory()
	id, _ := identity.LoadOrCreate(store, dir, "x")
	a := New(Config{DataDir: dir, Identity: id, OS: "linux"})
	if _, err := a.decideMode(""); err == nil {
		t.Fatal("expected error with neither host record nor token")
	}
	_ = a.saveHost(HostRecord{Fingerprint: strings.Repeat("ab", 32)})
	if _, err := a.decideMode("abab"); err != nil {
		t.Fatalf("matching beacon prefix rejected: %v", err)
	}
	if _, err := a.decideMode("ffff"); err == nil {
		t.Fatal("beacon from a different dashboard accepted")
	}
}
