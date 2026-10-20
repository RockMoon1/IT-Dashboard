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

func TestOnlyLinkLocal(t *testing.T) {
	nets := func(cidrs ...string) []net.Addr {
		var out []net.Addr
		for _, c := range cidrs {
			ip, n, err := net.ParseCIDR(c)
			if err != nil {
				t.Fatal(err)
			}
			n.IP = ip
			out = append(out, n)
		}
		return out
	}
	for _, c := range []struct {
		addrs []string
		want  bool
	}{
		{[]string{"169.254.5.5/16"}, true},
		{[]string{"169.254.5.5/16", "fe80::1/64"}, true},
		{[]string{"fe80::1/64"}, true},
		{[]string{"169.254.5.5/16", "10.1.0.5/24"}, false}, // Wi-Fi that also self-assigned
		{[]string{"10.0.0.5/24", "fe80::1/64"}, false},
		{[]string{"fd00::5/64", "fe80::1/64"}, false}, // a unique local address is a network
		{nil, false},
	} {
		if got := onlyLinkLocal(nets(c.addrs...)); got != c.want {
			t.Errorf("%v: %v, want %v", c.addrs, got, c.want)
		}
	}
}
