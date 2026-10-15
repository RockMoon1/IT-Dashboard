package profiles

import "testing"

func TestAllProfilesLoadAndAreReadOnly(t *testing.T) {
	all, err := All()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 18 {
		t.Fatalf("expected 18 profiles, got %d", len(all))
	}
	purposes := map[string]int{}
	for _, p := range all {
		purposes[p.Purpose]++
		for _, c := range p.Checks {
			if c.Access != "read" {
				t.Errorf("%s/%s is not read-only", p.Name, c.ID)
			}
			if c.Timeout() <= 0 {
				t.Errorf("%s/%s has no timeout", p.Name, c.ID)
			}
		}
	}
	for purpose, n := range purposes {
		if n != 3 {
			t.Errorf("purpose %s has %d profiles, want 3", purpose, n)
		}
	}
}

func TestGetRejectsWrongVersionAndUnknownName(t *testing.T) {
	if _, err := Get("windows-system-diagnostics", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := Get("windows-system-diagnostics", 2); err == nil {
		t.Fatal("wrong version accepted")
	}
	if _, err := Get("windows-format-disk", 1); err == nil {
		t.Fatal("unknown profile accepted")
	}
}

func TestValidateRejectsWriteAccessAndShellMismatch(t *testing.T) {
	base := Profile{Schema: Schema, Name: "x", Version: 1, OS: "linux", Purpose: "p", Checks: []Check{{ID: "a", Shell: "sh", Command: []string{"uptime"}, Format: "text", Access: "read"}}}
	if err := Validate(base); err != nil {
		t.Fatal(err)
	}
	bad := base
	bad.Checks = []Check{{ID: "a", Shell: "sh", Command: []string{"rm -rf /"}, Format: "text", Access: "write"}}
	if err := Validate(bad); err == nil {
		t.Fatal("write access accepted")
	}
	bad.Checks = []Check{{ID: "a", Shell: "powershell", Command: []string{"Get-Date"}, Format: "text", Access: "read"}}
	if err := Validate(bad); err == nil {
		t.Fatal("powershell on linux accepted")
	}
}
