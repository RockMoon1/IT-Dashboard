package policy

import (
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestMissingOrInvalidPolicyIsReadOnly(t *testing.T) {
	dir := t.TempDir()
	p := Load(dir)
	if p.Write || p.Execute || p.Custom || p.Error == "" {
		t.Fatalf("missing file: %+v", p)
	}
	for _, body := range []string{"", "{", `{"write":true}`, `{"schema":"arh-policy/1","write":true,"root":true}`, `{"schema":"arh-policy/9","write":true}`} {
		if err := os.WriteFile(Path(dir), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if p := Load(dir); p.Write || p.Error == "" {
			t.Errorf("%q: %+v", body, p)
		}
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want, _ := Preset("actions")
	want.Deny = []string{"windows-restart"}
	if err := Save(dir, want); err != nil {
		t.Fatal(err)
	}
	got := Load(dir)
	if got.Error != "" || !got.Write || !got.Execute || got.Custom || got.Deny[0] != "windows-restart" {
		t.Fatalf("got %+v", got)
	}
}

func TestWorldWritablePolicyIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("ACL-based on Windows")
	}
	dir := t.TempDir()
	full, _ := Preset("full")
	if err := Save(dir, full); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(Path(dir), 0o666); err != nil {
		t.Fatal(err)
	}
	if p := Load(dir); p.Custom || !strings.Contains(p.Error, "writable") {
		t.Fatalf("got %+v", p)
	}
}

func TestDecisions(t *testing.T) {
	actions, _ := Preset("actions")
	clinical, _ := Preset("clinical")
	full, _ := Preset("full")
	readOnly, _ := Preset("read")
	cases := []struct {
		p                    Policy
		name, access, impact string
		cable                bool
		want                 string
	}{
		{actions, "windows-dns-flush", "execute", "quiet", true, ""},
		{actions, "windows-dns-flush", "execute", "quiet", false, CodeLAN},
		{actions, "windows-restart", "execute", "interrupts", true, ""},
		{clinical, "windows-restart", "execute", "interrupts", true, CodeDenied},
		{clinical, "windows-firewall-on", "write", "interrupts", true, CodeDenied},
		{clinical, "windows-timezone-set", "write", "quiet", true, ""},
		{readOnly, "windows-timezone-set", "write", "quiet", true, CodeDenied},
		{Policy{Write: true, Execute: true, Interrupts: true, Deny: []string{"Windows-Restart"}}, "windows-restart", "execute", "interrupts", true, CodeDenied},
		{Policy{Write: true, Execute: true, LAN: true}, "windows-dns-flush", "execute", "quiet", false, ""},
	}
	for _, c := range cases {
		if code, _ := c.p.AllowAction(c.name, c.access, c.impact, c.cable); code != c.want {
			t.Errorf("%+v %s cable=%v: got %q want %q", c.p, c.name, c.cable, code, c.want)
		}
	}
	if code, _ := actions.AllowCustom(true); code != CodeDenied {
		t.Error("custom allowed by the actions preset")
	}
	if code, _ := full.AllowCustom(true); code != "" {
		t.Error("custom refused by the full preset")
	}
	if code, _ := full.AllowCustom(false); code != CodeLAN {
		t.Error("custom allowed over LAN")
	}
	if code, _ := (Policy{Custom: true, Execute: true}).AllowCustom(true); code != CodeDenied {
		t.Error("custom allowed without write")
	}
}
