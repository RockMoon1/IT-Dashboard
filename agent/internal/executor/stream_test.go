package executor

import (
	"sync"
	"sync/atomic"
	"testing"
	"unicode/utf8"
)

func testStream() *stream {
	var total int64
	var truncated atomic.Bool
	s := &stream{name: "stdout", total: &total, truncated: &truncated}
	s.more = sync.NewCond(&s.mu)
	return s
}

// A read that ends inside a UTF-8 sequence of any length (2, 3 or 4 bytes, cut after any of its
// bytes) has that sequence held back until the next read completes it; nothing queued for
// Output is then ever an incomplete sequence.
func TestAddHoldsBackEveryIncompleteSequence(t *testing.T) {
	for _, r := range []string{"é", "’", "✓", "™", "中", "😀"} {
		for k := 1; k < len(r); k++ {
			s := testStream()
			s.add([]byte("ab"+r[:k]), false)
			if string(s.queued) != "ab" || string(s.partial) != r[:k] {
				t.Fatalf("%q cut after byte %d: queued %q, held back %q", r, k, s.queued, s.partial)
			}
			s.add([]byte(r[k:]+"z"), false)
			if string(s.queued) != "ab"+r+"z" || len(s.partial) != 0 || !utf8.Valid(s.queued) {
				t.Fatalf("%q completed after byte %d: queued %q, held back %q", r, k, s.queued, s.partial)
			}
		}
	}
}

// Only a sequence the next read can still complete is held back: bytes that are not UTF-8 are
// forwarded as they come, and the last read forwards everything.
func TestAddForwardsWhatNoReadCanComplete(t *testing.T) {
	for _, p := range []string{"ab\x9c", "ab\x9c\x9c\x9c\x9c", "ab\xe2\x41", "ab\xf0\x9f\x98\x80", "ab\xed\xa0", "ab\xff", "ab\xc3\xa9"} {
		s := testStream()
		s.add([]byte(p), false)
		if string(s.queued) != p || len(s.partial) != 0 {
			t.Fatalf("%q: queued %q, held back %q", p, s.queued, s.partial)
		}
	}
	s := testStream()
	s.add([]byte("ab\xf0\x9f\x98"), false)
	s.add(nil, true)
	if string(s.queued) != "ab\xf0\x9f\x98" || len(s.partial) != 0 || !s.ended {
		t.Fatalf("last read: queued %q, held back %q, ended %v", s.queued, s.partial, s.ended)
	}
}
