package datalock

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"testing"
	"time"
)

// The helper process takes the lock, says so and waits to be killed.
func TestMain(m *testing.M) {
	if dir := os.Getenv("ARH_DATALOCK_HOLD"); dir != "" {
		if _, err := Acquire(dir); err != nil {
			os.Stdout.WriteString("error: " + err.Error() + "\n")
			os.Exit(1)
		}
		os.Stdout.WriteString("locked\n")
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// A second open fails while the first holds the lock, also in the same process, and the folder
// can be locked again once it is released.
func TestOneHolderAtATime(t *testing.T) {
	dir := t.TempDir()
	release, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := Acquire(dir); !errors.Is(err, ErrHeld) {
		if again != nil {
			again()
		}
		t.Fatalf("a second lock on a held folder: %v", err)
	}
	release()
	release2, err := Acquire(dir)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	release2()
}

// Another process holding the lock keeps this one out, and its death lets it go.
func TestLockEndsWithTheProcess(t *testing.T) {
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "ARH_DATALOCK_HOLD="+dir)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	if line, _ := bufio.NewReader(out).ReadString('\n'); line != "locked\n" {
		t.Fatalf("helper: %q", line)
	}
	if release, err := Acquire(dir); !errors.Is(err, ErrHeld) {
		if release != nil {
			release()
		}
		t.Fatalf("lock held by another process: %v", err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	deadline := time.Now().Add(5 * time.Second) // Windows frees a dead process's locks soon, not at once
	for {
		release, err := Acquire(dir)
		if err == nil {
			release()
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("lock after the holder was killed: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
