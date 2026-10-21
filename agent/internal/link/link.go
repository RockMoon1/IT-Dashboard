// Package link is the agent side of the dashboard connection: it listens for host beacons,
// opens one outbound mutually-authenticated TLS session, performs enrollment on first contact,
// executes scan profiles the host names and, under the device's policy and only over the cable,
// named actions and custom commands (actions.go).
package link

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/RockMoon1/IT-Dashboard/actions"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/audit"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/executor"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/identity"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/policy"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/protocol"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/service"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/sysinfo"
	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// BeaconGroup6 is the link-local IPv6 multicast group the dashboard also beacons to. A target on
// a direct cable often has only an IPv6 link-local address (Linux does not self-assign
// 169.254.x.x by default), so IPv4 broadcast alone would miss it.
const BeaconGroup6 = "ff02::4152:4831"

const (
	BeaconPort     = 47911
	hostRecordFile = "host.json"
	dialTimeout    = 10 * time.Second
	readTimeout    = 60 * time.Second
	pingEvery      = 20 * time.Second
	drainWait      = 15 * time.Second // systemd and launchd wait service.StopSeconds after SIGTERM
	drainEnd       = 5 * time.Second  // then for a custom command that was ended to report
	retryPause     = 3 * time.Second
)

type Beacon struct {
	ARH    int    `json:"arh"`
	Port   int    `json:"port"`
	FP     string `json:"fp"`
	HostID string `json:"hostId"`
}

// HostRecord is the pinned dashboard identity, written once at enrollment.
type HostRecord struct {
	Fingerprint string `json:"fingerprint"`
	HostID      string `json:"hostId"`
	EnrolledAt  string `json:"enrolledAt"`
}

type Config struct {
	DataDir  string
	Identity *identity.Identity
	Version  string
	Hostname string
	Serial   string
	OS       string
	Logger   *log.Logger

	trustAnyLink bool // tests only: treat a loopback session as the cable
}

type Agent struct {
	cfg       Config
	mu        sync.Mutex
	connected bool
	lastEnd   time.Time

	// The single run slot, shared by scans, actions and custom commands.
	runMu        sync.Mutex
	runCancel    context.CancelFunc
	runID        string
	runKind      string // "scan", "action" or "exec"
	runPhase     string // for actions: measure, apply, measure-after
	runAbortable bool
	restartAt    time.Time      // a restart the dashboard scheduled
	flight       sync.WaitGroup // actions and custom commands still running

	sessMu sync.Mutex
	codec  *protocol.Codec // the session connected now, if any

	rootMu  sync.Mutex
	rootCtx context.Context

	journal *runJournal
	audit   *audit.Log
	catalog func(osName string) []actions.Action // actions.ForOS; tests supply their own
}

// New reports the runs a previous agent left running as interrupted, so the caller must hold the
// data folder's lock (datalock.Acquire) first: another agent's live run is not interrupted.
func New(cfg Config) *Agent {
	if cfg.Logger == nil {
		cfg.Logger = log.New(os.Stderr, "", log.LstdFlags)
	}
	a := &Agent{cfg: cfg, journal: openJournal(cfg.DataDir), audit: audit.Open(cfg.DataDir), catalog: actions.ForOS}
	for _, r := range a.journal.recover(time.Now().UTC().Format(time.RFC3339)) {
		cfg.Logger.Printf("run %s: interrupted when the agent last stopped; reported as such", r.RunID)
		_ = a.audit.Record("outcome", map[string]any{"runId": r.RunID, "kind": r.Kind, "action": r.Action, "applied": r.Applied,
			"aborted": true, "interrupted": true})
	}
	return a
}

// root is the agent's lifetime context: actions and custom commands hang off it, not off the
// session, so pulling the cable does not stop a change half way.
func (a *Agent) root() context.Context {
	a.rootMu.Lock()
	defer a.rootMu.Unlock()
	if a.rootCtx == nil {
		return context.Background()
	}
	return a.rootCtx
}

func (a *Agent) hostRecordPath() string { return filepath.Join(a.cfg.DataDir, hostRecordFile) }

func (a *Agent) loadHost() (*HostRecord, error) {
	b, err := os.ReadFile(a.hostRecordPath())
	if err != nil {
		return nil, err
	}
	var h HostRecord
	if err := json.Unmarshal(b, &h); err != nil {
		return nil, err
	}
	if len(h.Fingerprint) != 64 {
		return nil, errors.New("host record has no fingerprint")
	}
	return &h, nil
}

func (a *Agent) saveHost(h HostRecord) error {
	b, _ := json.MarshalIndent(h, "", "  ")
	return os.WriteFile(a.hostRecordPath(), b, 0o600)
}

// datagram is one beacon received on any listener.
type datagram struct {
	data []byte
	src  *net.UDPAddr
}

// Run blocks, listening for beacons until ctx is cancelled. IPv4 broadcasts arrive on one
// wildcard socket; IPv6 multicast arrives on one socket per interface, rescanned every 10 s so a
// USB adapter that appears after the agent started is picked up.
func (a *Agent) Run(ctx context.Context) error {
	a.rootMu.Lock()
	a.rootCtx = ctx
	a.rootMu.Unlock()
	in := make(chan datagram, 16)
	v4, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: BeaconPort})
	if err != nil {
		return fmt.Errorf("listening for beacons on udp/%d: %w", BeaconPort, err)
	}
	defer v4.Close()
	go readBeacons(ctx, v4, in)
	go a.watchIPv6(ctx, in)
	a.cfg.Logger.Printf("agent %s listening for dashboard beacons on udp/%d and [%s]:%d (device %s)", a.cfg.Version, BeaconPort, BeaconGroup6, BeaconPort, a.cfg.Identity.Fingerprint[:16])
	for {
		select {
		case <-ctx.Done():
			a.drain(drainWait)
			return nil
		case d := <-in:
			a.handleBeacon(ctx, d)
		}
	}
}

// drain gives running actions and custom commands a short time to finish when the agent is
// stopped: a started change is not cancelled, and its result should reach the outbox. A custom
// command still running after that is ended, so it does not outlive the agent, and reports as
// aborted. What is still running then is reported as interrupted by the next agent start.
func (a *Agent) drain(limit time.Duration) {
	done := make(chan struct{})
	go func() {
		a.flight.Wait()
		close(done)
	}()
	select {
	case <-done:
		return
	case <-time.After(limit):
	}
	a.runMu.Lock()
	ended, id := a.runKind == "exec" && a.runCancel != nil, a.runID
	if ended {
		a.runCancel()
	}
	a.runMu.Unlock()
	if ended {
		a.cfg.Logger.Printf("run %s: custom command still running %s after the agent was stopped; ended it", id, limit)
		select {
		case <-done:
			return
		case <-time.After(drainEnd):
		}
	}
	a.cfg.Logger.Printf("stopping with a run still in progress; the next start reports it as interrupted")
}

func readBeacons(ctx context.Context, conn *net.UDPConn, out chan<- datagram) {
	buf := make([]byte, 2048)
	for {
		if ctx.Err() != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, src, err := conn.ReadFromUDP(buf)
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			return
		}
		select {
		case out <- datagram{data: append([]byte(nil), buf[:n]...), src: src}:
		default: // drop when busy; beacons repeat every 2 s
		}
	}
}

func (a *Agent) watchIPv6(ctx context.Context, out chan<- datagram) {
	group := &net.UDPAddr{IP: net.ParseIP(BeaconGroup6), Port: BeaconPort}
	active := map[string]*net.UDPConn{}
	defer func() {
		for _, c := range active {
			c.Close()
		}
	}()
	scan := func() {
		ifaces, err := net.Interfaces()
		if err != nil {
			return
		}
		seen := map[string]bool{}
		for i := range ifaces {
			ifi := ifaces[i]
			if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagLoopback != 0 || ifi.Flags&net.FlagMulticast == 0 || !hasLinkLocal6(&ifi) {
				continue
			}
			seen[ifi.Name] = true
			if _, ok := active[ifi.Name]; ok {
				continue
			}
			conn, err := net.ListenMulticastUDP("udp6", &ifi, group)
			if err != nil {
				continue
			}
			active[ifi.Name] = conn
			a.cfg.Logger.Printf("listening for IPv6 beacons on %s", ifi.Name)
			go readBeacons(ctx, conn, out)
		}
		for name, c := range active {
			if !seen[name] {
				c.Close()
				delete(active, name)
			}
		}
	}
	scan()
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			scan()
		}
	}
}

func hasLinkLocal6(ifi *net.Interface) bool {
	addrs, err := ifi.Addrs()
	if err != nil {
		return false
	}
	for _, addr := range addrs {
		if ipn, ok := addr.(*net.IPNet); ok && ipn.IP.To4() == nil && ipn.IP.IsLinkLocalUnicast() {
			return true
		}
	}
	return false
}

func (a *Agent) handleBeacon(ctx context.Context, d datagram) {
	var b Beacon
	if json.Unmarshal(d.data, &b) != nil || b.ARH != 1 || b.Port <= 0 || b.Port > 65535 {
		return
	}
	a.mu.Lock()
	busy := a.connected || time.Since(a.lastEnd) < retryPause
	if !busy {
		a.connected = true
	}
	a.mu.Unlock()
	if busy {
		return
	}
	go func(ip net.IP, zone string, port int, fp string) {
		defer func() {
			a.mu.Lock()
			a.connected = false
			a.lastEnd = time.Now()
			a.mu.Unlock()
		}()
		if err := a.session(ctx, ip, zone, port, fp); err != nil && ctx.Err() == nil {
			a.cfg.Logger.Printf("session with %s: %v", ip, err)
		}
	}(d.src.IP, d.src.Zone, b.Port, b.FP)
}

type mode struct {
	host  *HostRecord
	token *protocol.Token
}

func (a *Agent) decideMode(beaconFP string) (mode, error) {
	if h, err := a.loadHost(); err == nil {
		if beaconFP != "" && !strings.HasPrefix(strings.ToLower(h.Fingerprint), strings.ToLower(beaconFP)) {
			return mode{}, fmt.Errorf("beacon from a different dashboard (fp %s) than the one this device is enrolled with; re-enroll with a new token to switch", beaconFP)
		}
		return mode{host: h}, nil
	}
	raw, err := service.ReadPendingToken(a.cfg.DataDir)
	if err != nil {
		return mode{}, errors.New("not enrolled and no enrollment token present; run: arh-agent install --token ARH-…")
	}
	tok, err := protocol.ParseToken(raw)
	if err != nil {
		return mode{}, fmt.Errorf("stored enrollment token is invalid: %w", err)
	}
	return mode{token: &tok}, nil
}

func (a *Agent) session(ctx context.Context, ip net.IP, zone string, port int, beaconFP string) error {
	m, err := a.decideMode(beaconFP)
	if err != nil {
		return err
	}
	var seenFP string
	tlsCfg := &tls.Config{
		Certificates:       []tls.Certificate{a.cfg.Identity.TLS},
		InsecureSkipVerify: true, // replaced by fingerprint pinning below
		MinVersion:         tls.VersionTLS13,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("dashboard presented no certificate")
			}
			seenFP = identity.Fingerprint(cs.PeerCertificates[0].Raw)
			if m.host != nil {
				if !strings.EqualFold(seenFP, m.host.Fingerprint) {
					return fmt.Errorf("dashboard certificate fingerprint %s does not match the pinned %s", seenFP[:16], m.host.Fingerprint[:16])
				}
				return nil
			}
			if !m.token.MatchesFingerprint(seenFP) {
				return fmt.Errorf("dashboard certificate %s does not match the token prefix %s", seenFP[:8], m.token.FP8)
			}
			return nil
		},
	}
	host := ip.String()
	if zone != "" {
		host += "%" + zone // IPv6 link-local needs the interface it arrived on
	}
	addr := net.JoinHostPort(host, fmt.Sprint(port))
	dialer := &net.Dialer{Timeout: dialTimeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, tlsCfg)
	if err != nil {
		return fmt.Errorf("tls dial %s: %w", addr, err)
	}
	defer conn.Close()
	codec := protocol.NewCodec(conn)
	link := sessionLink(conn.LocalAddr(), conn.RemoteAddr())
	if a.cfg.trustAnyLink {
		link = "cable"
	}

	if m.token != nil {
		if err := a.enroll(conn, codec, *m.token, seenFP, link); err != nil {
			return fmt.Errorf("enrollment: %w", err)
		}
		a.cfg.Logger.Printf("enrolled with dashboard %s at %s", seenFP[:16], addr)
	} else {
		if err := codec.Write(a.hello(link)); err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
		resp, err := codec.Read()
		if err != nil {
			return err
		}
		switch resp.Type {
		case "welcome":
			a.cfg.Logger.Printf("connected to dashboard %s at %s as device %s", seenFP[:16], addr, resp.DeviceID)
		case "reject":
			return fmt.Errorf("dashboard rejected this device: %s", resp.Reason)
		default:
			return fmt.Errorf("unexpected reply %q", resp.Type)
		}
	}
	a.attach(codec)
	defer a.detach(codec)
	// results the dashboard has not acknowledged yet (a cable pulled during an action)
	for _, r := range a.journal.outbox() {
		r := r
		_ = codec.Write(protocol.Message{Type: "result", RunID: r.RunID, Result: &r})
	}
	return a.loop(ctx, conn, codec, link)
}

func (a *Agent) hello(link string) protocol.Message {
	var refs []protocol.ProfileRef
	for _, p := range profiles.ForOS(a.cfg.OS) {
		refs = append(refs, protocol.ProfileRef{Name: p.Name, Version: p.Version})
	}
	var acts []protocol.ActionRef
	for _, x := range a.catalog(a.cfg.OS) {
		acts = append(acts, protocol.ActionRef{Name: x.Name, Version: x.Version, SHA256: x.SHA256()})
	}
	pol := policy.Load(a.cfg.DataDir)
	msg := protocol.Message{Type: "hello", Hostname: a.cfg.Hostname, Serial: a.cfg.Serial, OS: a.cfg.OS, AgentVersion: a.cfg.Version, Profiles: refs,
		Protocol: protocol.Version, Link: link, BootTime: sysinfo.BootTime(), Actions: acts, Policy: &pol}
	a.runMu.Lock()
	msg.Running = a.runID
	a.runMu.Unlock()
	if at, pending := a.restartPending(); pending {
		msg.PendingRestartUntil = at.UTC().Format(time.RFC3339)
	}
	return msg
}

func (a *Agent) enroll(conn *tls.Conn, codec *protocol.Codec, tok protocol.Token, hostFP, link string) error {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	msg := a.hello(link)
	msg.Type = "enroll"
	msg.Token = tok.String()
	msg.Nonce = base64.StdEncoding.EncodeToString(nonce)
	if err := codec.Write(msg); err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
	resp, err := codec.Read()
	if err != nil {
		return err
	}
	if resp.Type == "reject" {
		return fmt.Errorf("dashboard rejected the token: %s", resp.Reason)
	}
	if resp.Type != "enroll-proof" {
		return fmt.Errorf("unexpected reply %q", resp.Type)
	}
	if !strings.EqualFold(resp.HostFingerprint, hostFP) {
		return errors.New("dashboard claimed a fingerprint different from its TLS certificate")
	}
	if !protocol.ProofEqual(resp.Proof, protocol.Proof(tok.Secret, nonce, hostFP)) {
		return errors.New("dashboard could not prove it knows the token secret (wrong token or someone else on the link)")
	}
	if err := a.saveHost(HostRecord{Fingerprint: strings.ToLower(hostFP), HostID: resp.HostTime, EnrolledAt: time.Now().UTC().Format(time.RFC3339)}); err != nil {
		return err
	}
	if err := codec.Write(protocol.Message{Type: "enroll-confirm"}); err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
	done, err := codec.Read()
	if err != nil {
		return err
	}
	if done.Type != "enrolled" {
		_ = os.Remove(a.hostRecordPath())
		return fmt.Errorf("enrollment not confirmed: %s %s", done.Type, done.Reason)
	}
	return service.ClearPendingToken(a.cfg.DataDir)
}

func (a *Agent) loop(ctx context.Context, conn *tls.Conn, codec *protocol.Codec, link string) error {
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(pingEvery)
		defer t.Stop()
		lastPolicy := policy.Load(a.cfg.DataDir).Fingerprint()
		lastState := a.stateMessage().PendingRestartUntil
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				conn.Close()
				return
			case <-t.C:
				if err := codec.Write(protocol.Message{Type: "ping"}); err != nil {
					return
				}
				// a policy changed on the device while connected is reported at once
				if pol := policy.Load(a.cfg.DataDir); pol.Fingerprint() != lastPolicy {
					lastPolicy = pol.Fingerprint()
					_ = codec.Write(protocol.Message{Type: "policy", Policy: &pol})
				}
				// and so is the end of a pending restart's grace period
				if st := a.stateMessage(); st.PendingRestartUntil != lastState {
					lastState = st.PendingRestartUntil
					_ = codec.Write(st)
				}
			}
		}
	}()
	defer a.sessionEnded()
	for {
		_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
		m, err := codec.Read()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		switch m.Type {
		case "ping":
			_ = codec.Write(protocol.Message{Type: "pong"})
		case "pong", "welcome":
		case "run":
			a.startRun(ctx, codec, m)
		case "action":
			a.startAction(codec, link, m)
		case "exec":
			a.startExec(codec, link, m)
		case "ack":
			_ = a.journal.ack(m.RunID)
		case "abort":
			a.abort(codec, m.RunID)
		case "bye":
			return nil
		}
	}
}

func (a *Agent) startRun(ctx context.Context, codec *protocol.Codec, m protocol.Message) {
	a.runMu.Lock()
	if a.runCancel != nil {
		a.runMu.Unlock()
		_ = codec.Write(protocol.Message{Type: "run-end", RunID: m.RunID, OK: protocol.BoolPtr(false), ErrorCode: protocol.CodeBusy, Error: "busy: another run is in progress"})
		return
	}
	p, err := profiles.Get(m.Profile, m.Version)
	if err == nil && p.OS != a.cfg.OS {
		err = fmt.Errorf("profile %s targets %s, this device is %s", p.Name, p.OS, a.cfg.OS)
	}
	if err != nil {
		a.runMu.Unlock()
		_ = codec.Write(protocol.Message{Type: "run-end", RunID: m.RunID, OK: protocol.BoolPtr(false), Error: err.Error()})
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	a.runCancel = cancel
	a.runID = m.RunID
	a.runKind = "scan"
	a.runMu.Unlock()

	go func() {
		defer func() {
			cancel()
			a.runMu.Lock()
			a.runCancel = nil
			a.runID = ""
			a.runKind = ""
			a.runMu.Unlock()
		}()
		a.execute(runCtx, codec, m.RunID, p)
	}()
}

func (a *Agent) execute(ctx context.Context, codec *protocol.Codec, runID string, p profiles.Profile) {
	started := time.Now()
	_ = codec.Write(protocol.Message{Type: "run-start", RunID: runID, Profile: p.Name, Version: p.Version, Checks: len(p.Checks)})
	a.cfg.Logger.Printf("run %s: %s v%d (%d checks)", runID, p.Name, p.Version, len(p.Checks))
	ok := true
	var runErr string
	for _, c := range p.Checks {
		if ctx.Err() != nil {
			ok = false
			runErr = "aborted"
			break
		}
		if c.Access != "read" { // belt and braces: Validate already refused this
			ok = false
			runErr = "check " + c.ID + " is not read-only"
			break
		}
		_ = codec.Write(protocol.Message{Type: "check-start", RunID: runID, CheckID: c.ID, Title: c.Title, Category: c.Category})
		res := executor.Run(ctx, c, func(stream string, chunk []byte) {
			_ = codec.Write(protocol.Message{Type: "check-output", RunID: runID, CheckID: c.ID, Stream: stream, Data: string(chunk)})
		})
		if res.Err != nil {
			_ = codec.Write(protocol.Message{Type: "check-output", RunID: runID, CheckID: c.ID, Stream: "stderr", Data: res.Err.Error() + "\n"})
		}
		_ = codec.Write(protocol.Message{Type: "check-end", RunID: runID, CheckID: c.ID, ExitCode: protocol.IntPtr(res.ExitCode), DurationMs: res.Duration.Milliseconds(), TimedOut: res.TimedOut, Truncated: res.Truncated})
		if (res.ExitCode != 0 || res.TimedOut) && !c.Optional {
			ok = false
			if runErr == "" {
				runErr = "check " + c.ID + " failed"
			}
		}
		if res.Stopped { // a stop once the check had ended stops only the checks after it
			ok = false
			runErr = "aborted"
			break
		}
	}
	_ = codec.Write(protocol.Message{Type: "run-end", RunID: runID, OK: protocol.BoolPtr(ok), DurationMs: time.Since(started).Milliseconds(), Error: runErr})
	a.cfg.Logger.Printf("run %s finished ok=%v in %s", runID, ok, time.Since(started).Round(time.Millisecond))
}
