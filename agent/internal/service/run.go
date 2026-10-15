package service

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
)

// run executes a system tool and returns a readable error including its output.
func run(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	text := strings.TrimSpace(out.String())
	if err != nil {
		return text, fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, text)
	}
	return text, nil
}
