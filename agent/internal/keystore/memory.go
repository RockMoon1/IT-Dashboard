package keystore

import "sync"

// Memory is an in-process store for tests and dry runs. It never persists anything.
type Memory struct {
	mu sync.Mutex
	m  map[string][]byte
}

func NewMemory() *Memory { return &Memory{m: map[string][]byte{}} }

func (s *Memory) Save(name string, secret []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[name] = append([]byte(nil), secret...)
	return nil
}

func (s *Memory) Load(name string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.m[name]
	if !ok {
		return nil, ErrNotFound
	}
	return append([]byte(nil), v...), nil
}

func (s *Memory) Delete(name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, name)
	return nil
}

func (s *Memory) Describe() string { return "memory (tests only)" }
