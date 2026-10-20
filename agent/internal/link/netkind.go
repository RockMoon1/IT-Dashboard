package link

import (
	"net"
)

// sessionLink says whether a session runs over the USB cable or the clinic network. A cable
// session is one whose peer address is link-local and whose local end is not on the interface
// that carries the default route; anything else is "lan", where only scans and previews run.
func sessionLink(local, remote net.Addr) string {
	r, ok1 := remote.(*net.TCPAddr)
	l, ok2 := local.(*net.TCPAddr)
	if !ok1 || !ok2 || !r.IP.IsLinkLocalUnicast() {
		return "lan"
	}
	iface := interfaceOf(l)
	if iface == "" {
		return "lan"
	}
	for _, name := range defaultRouteInterfaces() {
		if name == iface {
			return "lan"
		}
	}
	return "cable"
}

// interfaceOf names the interface that holds the local address (the zone for IPv6 link-local).
func interfaceOf(a *net.TCPAddr) string {
	if a.Zone != "" {
		if ifi, err := net.InterfaceByName(a.Zone); err == nil {
			return ifi.Name
		}
		if ifi, err := net.InterfaceByIndex(atoiZone(a.Zone)); err == nil {
			return ifi.Name
		}
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, ifi := range ifaces {
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, x := range addrs {
			if ipn, ok := x.(*net.IPNet); ok && ipn.IP.Equal(a.IP) {
				return ifi.Name
			}
		}
	}
	return ""
}

func atoiZone(z string) int {
	n := 0
	for _, c := range z {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// defaultRouteInterfaces finds the interfaces the system would use to reach the internet, by
// asking the kernel to pick a source address for a UDP "connection" (no packet is sent).
func defaultRouteInterfaces() []string {
	var names []string
	for _, target := range []string{"192.0.2.1:9", "[2001:db8::1]:9"} { // documentation addresses
		c, err := net.Dial("udp", target)
		if err != nil {
			continue
		}
		la, _ := c.LocalAddr().(*net.UDPAddr)
		c.Close()
		if la == nil {
			continue
		}
		if name := interfaceOf(&net.TCPAddr{IP: la.IP, Zone: la.Zone}); name != "" {
			names = append(names, name)
		}
	}
	return names
}
