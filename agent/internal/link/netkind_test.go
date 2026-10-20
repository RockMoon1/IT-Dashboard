package link

import (
	"net"
	"testing"
)

func TestSessionLinkIsLANUnlessPeerIsLinkLocal(t *testing.T) {
	l := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 1}
	for _, r := range []string{"127.0.0.1", "10.0.0.5", "192.168.1.20", "2001:db8::5"} {
		if got := sessionLink(l, &net.TCPAddr{IP: net.ParseIP(r), Port: 2}); got != "lan" {
			t.Errorf("%s: %s", r, got)
		}
	}
	// a link-local peer seen through an address no interface holds is not provably the cable
	if got := sessionLink(&net.TCPAddr{IP: net.ParseIP("169.254.9.9")}, &net.TCPAddr{IP: net.ParseIP("169.254.1.1")}); got != "lan" {
		t.Errorf("unknown local interface: %s", got)
	}
}
