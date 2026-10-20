package audit

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecordAppendsJSONLines(t *testing.T) {
	dir := t.TempDir()
	l := Open(dir)
	if err := l.Record("intent", map[string]any{"runId": "r1", "kind": "action", "action": "linux-dns-flush", "technician": "Lisandro"}); err != nil {
		t.Fatal(err)
	}
	if err := l.Record("outcome", map[string]any{"runId": "r1", "status": "done"}); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var events []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var rec map[string]any
		if err := json.Unmarshal(sc.Bytes(), &rec); err != nil {
			t.Fatal(err)
		}
		events = append(events, rec["event"].(string)+":"+rec["runId"].(string))
	}
	if strings.Join(events, ",") != "intent:r1,outcome:r1" {
		t.Fatalf("events %v", events)
	}
}

func TestRotateKeepsFiveFiles(t *testing.T) {
	dir := t.TempDir()
	l := Open(dir)
	big := strings.Repeat("x", maxSize)
	for i := 0; i < 7; i++ {
		if err := os.WriteFile(filepath.Join(dir, FileName), []byte(big), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := l.Record("intent", map[string]any{"runId": "r"}); err != nil {
			t.Fatal(err)
		}
	}
	m, _ := filepath.Glob(filepath.Join(dir, FileName+"*"))
	if len(m) != keep {
		t.Fatalf("files %v", m)
	}
}
