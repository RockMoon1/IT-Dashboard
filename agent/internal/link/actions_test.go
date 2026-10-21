//go:build !windows

package link

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/RockMoon1/IT-Dashboard/actions"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/identity"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/keystore"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/policy"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/protocol"
)

// testAction sets a value in a file named by the "file" parameter's folder: measure reads it,
// apply writes it, so a real run can be checked from outside.
func testAction(t *testing.T, abortable bool, applySleep string) actions.Action {
	t.Helper()
	def := map[string]any{
		"schema": actions.Schema, "name": "linux-test-set", "version": 1, "os": "linux", "access": "write", "category": "Test",
		"title": "Set the test value", "description": "test", "impact": "quiet", "reversible": true, "undo": "linux-test-set",
		"manualUndo": "", "abortable": abortable, "concurrent": false, "fixes": []string{}, "shell": "sh", "timeoutSeconds": 20, "settleSeconds": 0,
		"params": []map[string]any{{"name": "value", "label": "Value", "pattern": "[a-z]{1,10}", "maxLength": 10, "required": true, "default": "", "choices": []string{},
			"examples": map[string]any{"ok": []string{"on"}, "bad": []string{"ON"}}}},
		"measure": []string{
			`cur=$(cat "$TEST_ACTION_DIR/value" 2>/dev/null)`,
			`arh_item "Test value" "${cur:-unset}"`,
			`arh_restore value "${cur:-unset}"`,
			`if [ -e "$TEST_ACTION_DIR/blocked" ]; then arh_blocker "blocked by the test"; fi`,
			`if [ "$cur" = "$ARH_PARAM_VALUE" ]; then arh_plan false "already $cur"; else arh_plan true "set to $ARH_PARAM_VALUE"; fi`,
		},
		"apply": []string{
			applySleep,
			`printf '%s' "$ARH_PARAM_VALUE" > "$TEST_ACTION_DIR/value"`,
			`arh_note "written"`,
		},
	}
	raw, _ := json.Marshal(def)
	a, err := actions.Decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// harness is a fake dashboard: it accepts sessions from one enrolled agent and lets each test
// talk to it through the codec.
type harness struct {
	t      *testing.T
	agent  *Agent
	ln     net.Listener
	port   int
	fp     string
	dir    string
	ctx    context.Context
	cancel context.CancelFunc
}

func newHarness(t *testing.T, cable bool) *harness {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TEST_ACTION_DIR", dir) // inherited by the scripts (CleanEnv drops only ARH_* names)
	hc, err := identity.GenerateHostCert("test-dashboard")
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := tls.X509KeyPair([]byte(hc.CertPEM), []byte(hc.KeyPEM))
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequestClientCert, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	id, _ := identity.LoadOrCreate(keystore.NewMemory(), dir, "unit-test-device")
	a := New(Config{DataDir: dir, Identity: id, Version: "test", Hostname: "unit-test-device", OS: "linux", Logger: log.New(os.Stderr, "agent: ", 0), trustAnyLink: cable})
	if err := a.saveHost(HostRecord{Fingerprint: hc.Fingerprint}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	a.rootCtx = ctx
	h := &harness{t: t, agent: a, ln: ln, port: ln.Addr().(*net.TCPAddr).Port, fp: hc.Fingerprint, dir: dir, ctx: ctx, cancel: cancel}
	t.Cleanup(func() { cancel(); ln.Close() })
	return h
}

// connect starts one agent session and returns the dashboard's side after hello and welcome.
func (h *harness) connect() (*protocol.Codec, protocol.Message, func()) {
	h.t.Helper()
	sessCtx, stop := context.WithCancel(h.ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = h.agent.session(sessCtx, net.ParseIP("127.0.0.1"), "", h.port, h.fp[:16])
	}()
	conn, err := h.ln.Accept()
	if err != nil {
		h.t.Fatal(err)
	}
	codec := protocol.NewCodec(conn)
	hello, err := codec.Read()
	if err != nil || hello.Type != "hello" {
		h.t.Fatalf("hello: %+v %v", hello, err)
	}
	_ = codec.Write(protocol.Message{Type: "welcome", DeviceID: "d1"})
	return codec, hello, func() {
		conn.Close()
		stop()
		<-done
	}
}

// until reads messages until one of type want (skipping pings), returning everything seen.
func until(t *testing.T, c *protocol.Codec, want string) (protocol.Message, []protocol.Message) {
	t.Helper()
	var seen []protocol.Message
	for {
		m, err := c.Read()
		if err != nil {
			t.Fatalf("waiting for %s: %v (seen %d)", want, err, len(seen))
		}
		if m.Type == "ping" || m.Type == "policy" {
			continue
		}
		seen = append(seen, m)
		if m.Type == want {
			return m, seen
		}
	}
}

func (h *harness) setPolicy(name string) {
	h.t.Helper()
	p, err := policy.Preset(name)
	if err != nil {
		h.t.Fatal(err)
	}
	if err := policy.Save(h.dir, p); err != nil {
		h.t.Fatal(err)
	}
}

func actionMsg(a actions.Action, runID, mode, value string) protocol.Message {
	return protocol.Message{Type: "action", RunID: runID, Action: a.Name, Version: a.Version, SHA256: a.SHA256(), Mode: mode,
		Params: map[string]string{"value": value}, Technician: "Lisandro", Reason: "test"}
}

func TestHelloReportsProtocolPolicyAndActions(t *testing.T) {
	h := newHarness(t, true)
	act := testAction(t, false, ":")
	h.agent.catalog = func(string) []actions.Action { return []actions.Action{act} }
	_, hello, closeFn := h.connect()
	defer closeFn()
	if hello.Protocol != protocol.Version || hello.Link != "cable" || hello.Policy == nil || hello.Policy.Write || hello.Policy.Error == "" {
		t.Fatalf("hello %+v policy %+v", hello, hello.Policy)
	}
	if len(hello.Actions) != 1 || hello.Actions[0].SHA256 != act.SHA256() {
		t.Fatalf("actions %+v", hello.Actions)
	}
}

func TestPreviewApplyAndRefusals(t *testing.T) {
	h := newHarness(t, true)
	act := testAction(t, false, ":")
	h.agent.catalog = func(string) []actions.Action { return []actions.Action{act} }
	c, _, closeFn := h.connect()
	defer closeFn()

	// no policy file: read only, but a preview still runs (it only measures)
	_ = c.Write(actionMsg(act, "p1", "apply", "on"))
	end, _ := until(t, c, "run-end")
	if end.ErrorCode != protocol.CodePolicyDenied {
		t.Fatalf("apply without policy: %+v", end)
	}
	_ = c.Write(actionMsg(act, "p2", "preview", "on"))
	end, seen := until(t, c, "run-end")
	r := end.Result
	if r == nil || !r.DryRun || r.Applied || r.Before == nil || r.Before.Change == nil || !*r.Before.Change || r.Before.Items[0].Value != "unset" {
		t.Fatalf("preview result %+v", r)
	}
	if seen[0].Type != "run-start" || seen[0].Mode != "preview" || seen[0].Params["value"] != "on" {
		t.Fatalf("run-start %+v", seen[0])
	}
	if _, err := os.Stat(filepath.Join(h.dir, "value")); err == nil {
		t.Fatal("a preview changed the device")
	}

	h.setPolicy("actions")
	for _, bad := range []protocol.Message{
		{Type: "action", RunID: "b1", Action: act.Name, Version: 1, SHA256: act.SHA256(), Params: map[string]string{"value": "on"}},                // no mode
		{Type: "action", RunID: "b2", Action: act.Name, Version: 1, SHA256: act.SHA256(), Mode: "dry", Params: map[string]string{"value": "on"}},   // bad mode
		{Type: "action", RunID: "b3", Action: act.Name, Version: 2, SHA256: act.SHA256(), Mode: "apply", Params: map[string]string{"value": "on"}}, // version
		{Type: "action", RunID: "b4", Action: act.Name, Version: 1, SHA256: strings.Repeat("0", 64), Mode: "apply", Params: map[string]string{"value": "on"}},
		{Type: "action", RunID: "b5", Action: act.Name, Version: 1, SHA256: act.SHA256(), Mode: "apply", Params: map[string]string{"value": "-x"}}, // bad param
		{Type: "action", RunID: "b6", Action: act.Name, Version: 1, SHA256: act.SHA256(), Mode: "apply", Params: map[string]string{"value": "on", "x": "y"}},
		{Type: "action", RunID: "b7", Action: "linux-rm-rf", Version: 1, SHA256: act.SHA256(), Mode: "apply"},
	} {
		_ = c.Write(bad)
		end, _ := until(t, c, "run-end")
		if end.ErrorCode == "" || end.OK == nil || *end.OK {
			t.Errorf("%s accepted: %+v", bad.RunID, end)
		}
	}

	_ = c.Write(actionMsg(act, "a1", "apply", "on"))
	end, seen = until(t, c, "run-end")
	r = end.Result
	if r == nil || !r.Applied || r.DryRun || r.Before.Items[0].Value != "unset" || r.After == nil || r.After.Items[0].Value != "on" || *r.After.Change {
		t.Fatalf("apply result %+v before %+v after %+v", r, r.Before, r.After)
	}
	if r.Before.Restore["value"] != "unset" || len(r.Apply.Notes) != 1 {
		t.Fatalf("restore %v notes %v", r.Before.Restore, r.Apply.Notes)
	}
	var phases []string
	for _, m := range seen {
		if m.Type == "check-start" {
			phases = append(phases, m.CheckID)
		}
	}
	if strings.Join(phases, ",") != "measure,apply,measure-after" {
		t.Fatalf("phases %v", phases)
	}

	// already set: apply is skipped and says why
	_ = c.Write(actionMsg(act, "a2", "apply", "on"))
	end, _ = until(t, c, "run-end")
	if end.Result.Applied || !strings.HasPrefix(end.Result.Skipped, "nothing to change") {
		t.Fatalf("second apply %+v", end.Result)
	}
	// a blocker stops apply
	_ = os.WriteFile(filepath.Join(h.dir, "blocked"), nil, 0o600)
	_ = c.Write(actionMsg(act, "a3", "apply", "off"))
	end, _ = until(t, c, "run-end")
	if end.Result.Applied || !strings.HasPrefix(end.Result.Skipped, "blocked") {
		t.Fatalf("blocked apply %+v", end.Result)
	}
	if b, _ := os.ReadFile(filepath.Join(h.dir, "value")); string(b) != "on" {
		t.Fatalf("blocked apply changed the value to %q", b)
	}
	// a run id is never run twice
	_ = c.Write(actionMsg(act, "a1", "apply", "off"))
	end, seen = until(t, c, "run-end")
	if end.ErrorCode != protocol.CodeDuplicateRun || seen[0].Type != "result" || seen[0].Result.RunID != "a1" {
		t.Fatalf("duplicate: %+v (first %s)", end, seen[0].Type)
	}
}

func TestChangesNeedTheCable(t *testing.T) {
	h := newHarness(t, false) // loopback is not link-local: a LAN session
	act := testAction(t, false, ":")
	h.agent.catalog = func(string) []actions.Action { return []actions.Action{act} }
	h.setPolicy("full")
	c, hello, closeFn := h.connect()
	defer closeFn()
	if hello.Link != "lan" {
		t.Fatalf("link %q", hello.Link)
	}
	_ = c.Write(actionMsg(act, "l1", "apply", "on"))
	if end, _ := until(t, c, "run-end"); end.ErrorCode != protocol.CodeLANSession {
		t.Fatalf("apply over LAN: %+v", end)
	}
	_ = c.Write(protocol.Message{Type: "exec", RunID: "l2", Shell: "sh", Script: "echo hi"})
	if end, _ := until(t, c, "run-end"); end.ErrorCode != protocol.CodeLANSession {
		t.Fatalf("exec over LAN: %+v", end)
	}
	_ = c.Write(actionMsg(act, "l3", "preview", "on"))
	if end, _ := until(t, c, "run-end"); end.ErrorCode != "" || end.Result == nil {
		t.Fatalf("preview over LAN refused: %+v", end)
	}
}

func TestCustomCommandNeedsFullPolicy(t *testing.T) {
	h := newHarness(t, true)
	h.setPolicy("actions")
	c, _, closeFn := h.connect()
	defer closeFn()
	_ = c.Write(protocol.Message{Type: "exec", RunID: "e1", Shell: "sh", Script: "echo hi"})
	if end, _ := until(t, c, "run-end"); end.ErrorCode != protocol.CodePolicyDenied {
		t.Fatalf("exec under actions policy: %+v", end)
	}
	h.setPolicy("full")
	_ = c.Write(protocol.Message{Type: "exec", RunID: "e2", Shell: "sh", Script: "echo \"param=[${ARH_PARAM_X:-}]\"\nread x || true\necho after\nexit 4", Technician: "Lisandro", Reason: "test"})
	end, seen := until(t, c, "run-end")
	var out string
	for _, m := range seen {
		if m.Type == "check-output" {
			out += m.Data
		}
	}
	// it started, so it was applied whatever its exit code
	if end.Result == nil || end.Result.Kind != "exec" || *end.Result.ExitCode != 4 || end.Result.Lines != 4 || len(end.Result.SHA256) != 64 ||
		!end.Result.Applied || end.Result.AppliedAt == "" || end.Result.Skipped != "" {
		t.Fatalf("exec result %+v", end.Result)
	}
	if out != "param=[]\nafter\n" {
		t.Fatalf("output %q", out)
	}
	_ = c.Write(protocol.Message{Type: "exec", RunID: "e3", Shell: "powershell", Script: "Get-Date"})
	if end, _ := until(t, c, "run-end"); end.ErrorCode != protocol.CodeBadParam {
		t.Fatalf("wrong shell: %+v", end)
	}
	// the device keeps a record with the script, never the output
	log, _ := os.ReadFile(filepath.Join(h.dir, "actions.log"))
	if !strings.Contains(string(log), `"script":"echo`) || strings.Contains(string(log), "param=[]") {
		t.Fatalf("audit log %s", log)
	}
}

// Pulling the cable during apply does not stop the change; the result is sent on the next
// session and stays in the outbox until the dashboard acknowledges it.
func TestStartedChangeSurvivesDisconnect(t *testing.T) {
	h := newHarness(t, true)
	act := testAction(t, false, "sleep 1")
	h.agent.catalog = func(string) []actions.Action { return []actions.Action{act} }
	h.setPolicy("actions")
	c, _, closeFn := h.connect()
	_ = c.Write(actionMsg(act, "d1", "apply", "on"))
	for {
		m, err := c.Read()
		if err != nil {
			t.Fatal(err)
		}
		if m.Type == "check-start" && m.CheckID == actions.PhaseApply {
			break
		}
	}
	// abort is refused once a non-abortable change has started
	_ = c.Write(protocol.Message{Type: "abort", RunID: "d1"})
	if m, _ := until(t, c, "abort-refused"); m.ErrorCode != protocol.CodeNotAbortable {
		t.Fatalf("abort: %+v", m)
	}
	closeFn() // cable pulled
	deadline := time.Now().Add(10 * time.Second)
	for {
		if b, _ := os.ReadFile(filepath.Join(h.dir, "value")); string(b) == "on" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the change did not finish after the disconnect")
		}
		time.Sleep(100 * time.Millisecond)
	}
	for len(h.agent.journal.outbox()) == 0 && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	c2, hello, closeFn2 := h.connect()
	defer closeFn2()
	_ = hello
	m, _ := until(t, c2, "result")
	if m.RunID != "d1" || m.Result == nil || !m.Result.Applied || m.Result.After == nil || m.Result.After.Items[0].Value != "on" {
		t.Fatalf("replayed result %+v", m.Result)
	}
	_ = c2.Write(protocol.Message{Type: "ack", RunID: "d1"})
	for i := 0; i < 50 && len(h.agent.journal.outbox()) > 0; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if n := len(h.agent.journal.outbox()); n != 0 {
		t.Fatalf("outbox still holds %d after ack", n)
	}
}

// A preview still measuring is stopped by a disconnect (nothing has changed yet).
func TestAbortDuringMeasure(t *testing.T) {
	h := newHarness(t, true)
	act := testAction(t, false, ":")
	act.Measure = append([]string{"sleep 5"}, act.Measure...)
	h.agent.catalog = func(string) []actions.Action { return []actions.Action{act} }
	h.setPolicy("actions")
	c, _, closeFn := h.connect()
	defer closeFn()
	_ = c.Write(actionMsg(act, "m1", "apply", "on"))
	until(t, c, "check-start")
	_ = c.Write(protocol.Message{Type: "abort", RunID: "other"}) // another run's abort is ignored
	_ = c.Write(protocol.Message{Type: "abort", RunID: "m1"})
	end, _ := until(t, c, "run-end")
	if end.Result == nil || !end.Result.Aborted || end.Result.Applied {
		t.Fatalf("abort during measure: %+v", end.Result)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "value")); err == nil {
		t.Fatal("aborted run changed the device")
	}
}
