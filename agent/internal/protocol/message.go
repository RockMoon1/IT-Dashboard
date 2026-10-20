// Package protocol defines the newline-delimited JSON messages exchanged over the TLS link and
// the enrollment token format. See docs/PROTOCOL.md.
package protocol

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"sync"

	"github.com/RockMoon1/IT-Dashboard/actions"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/policy"
)

// MaxLine bounds one JSON message on the wire.
const MaxLine = 256 * 1024

// Message is the union of every field any message type can carry. Unused fields are omitted.
type Message struct {
	Type string `json:"type"`

	Hostname     string       `json:"hostname,omitempty"`
	Serial       string       `json:"serial,omitempty"`
	OS           string       `json:"os,omitempty"`
	AgentVersion string       `json:"agentVersion,omitempty"`
	Profiles     []ProfileRef `json:"profiles,omitempty"`

	Token           string `json:"token,omitempty"`
	Nonce           string `json:"nonce,omitempty"`
	Proof           string `json:"proof,omitempty"`
	HostFingerprint string `json:"hostFingerprint,omitempty"`
	DeviceID        string `json:"deviceId,omitempty"`
	DisplayName     string `json:"displayName,omitempty"`
	HostTime        string `json:"hostTime,omitempty"`
	Reason          string `json:"reason,omitempty"`

	RunID      string `json:"runId,omitempty"`
	Profile    string `json:"profile,omitempty"`
	Version    int    `json:"version,omitempty"`
	Checks     int    `json:"checks,omitempty"`
	CheckID    string `json:"checkId,omitempty"`
	Title      string `json:"title,omitempty"`
	Category   string `json:"category,omitempty"`
	Stream     string `json:"stream,omitempty"`
	Data       string `json:"data,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	Truncated  bool   `json:"truncated,omitempty"`
	OK         *bool  `json:"ok,omitempty"`
	Error      string `json:"error,omitempty"`

	// Protocol 2: named actions and custom commands (docs/PHASE3-DESIGN.md).
	Protocol            int               `json:"protocol,omitempty"`
	Link                string            `json:"link,omitempty"` // "cable" or "lan", as the agent sees the session
	BootTime            string            `json:"bootTime,omitempty"`
	Actions             []ActionRef       `json:"actions,omitempty"`
	Policy              *policy.Policy    `json:"policy,omitempty"`
	Running             string            `json:"running,omitempty"`
	PendingRestartUntil string            `json:"pendingRestartUntil,omitempty"`
	Action              string            `json:"action,omitempty"`
	SHA256              string            `json:"sha256,omitempty"`
	Params              map[string]string `json:"params,omitempty"`
	Mode                string            `json:"mode,omitempty"` // "preview" or "apply"; required
	Technician          string            `json:"technician,omitempty"`
	Shell               string            `json:"shell,omitempty"`
	Script              string            `json:"script,omitempty"`
	TimeoutSeconds      int               `json:"timeoutSeconds,omitempty"`
	Result              *actions.Result   `json:"result,omitempty"`
	ErrorCode           string            `json:"errorCode,omitempty"`
}

// Version is the protocol this agent speaks. Agents and dashboards at 1 stay read only.
const Version = 2

type ProfileRef struct {
	Name    string `json:"name"`
	Version int    `json:"version"`
}

type ActionRef struct {
	Name    string `json:"name"`
	Version int    `json:"version"`
	SHA256  string `json:"sha256"`
}

// Error codes on run-end and abort-refused.
const (
	CodeBusy           = "busy"
	CodePolicyDenied   = policy.CodeDenied
	CodeLANSession     = policy.CodeLAN
	CodeUnknownAction  = "unknown-action"
	CodeVersion        = "version-mismatch"
	CodeBadParam       = "bad-param"
	CodeBadMode        = "bad-mode"
	CodeDuplicateRun   = "duplicate-run"
	CodeRestartPending = "restart-pending"
	CodeNotAbortable   = "not-abortable"
	CodeInternal       = "internal"
)

// Codec reads and writes one Message per line. Writes are serialised so several goroutines can
// stream output concurrently.
type Codec struct {
	r  *bufio.Reader
	w  io.Writer
	mu sync.Mutex
}

func NewCodec(rw io.ReadWriter) *Codec {
	return &Codec{r: bufio.NewReaderSize(rw, 64*1024), w: rw}
}

var ErrLineTooLong = errors.New("protocol: line exceeds MaxLine")

func (c *Codec) Read() (Message, error) {
	var line []byte
	for {
		part, isPrefix, err := c.r.ReadLine()
		if err != nil {
			return Message{}, err
		}
		line = append(line, part...)
		if len(line) > MaxLine {
			return Message{}, ErrLineTooLong
		}
		if !isPrefix {
			break
		}
	}
	var m Message
	if err := json.Unmarshal(line, &m); err != nil {
		return Message{}, err
	}
	return m, nil
}

func (c *Codec) Write(m Message) error {
	buf, err := json.Marshal(m)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err = c.w.Write(append(buf, '\n'))
	return err
}

func IntPtr(v int) *int    { return &v }
func BoolPtr(v bool) *bool { return &v }
