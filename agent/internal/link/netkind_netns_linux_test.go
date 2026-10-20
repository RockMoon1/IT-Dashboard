//go:build linux

package link

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

/*
  The cable rule, end to end: each case builds its adapters in a throwaway network namespace,
  puts a peer with a link-local address in a second one, makes a real TCP connection to it and
  asks sessionLink what kind of session that is. Opt-in and root only (ARH_LIVE_NETNS=1): CI runs
  it on the Linux runner. The adapters are veth pairs, so no extra kernel module is needed.
*/

func TestCableRuleInNetworkNamespaces(t *testing.T) {
	if os.Getenv("ARH_LIVE_NETNS") != "1" {
		t.Skip("set ARH_LIVE_NETNS=1 and run as root to build network namespaces")
	}
	for _, c := range []struct{ name, want string }{
		{"cable", "cable"},              // USB adapter with only 169.254, LAN on another adapter
		{"cable-only", "cable"},         // the PC's own Ethernet port, wired straight to the laptop
		{"lan", "lan"},                  // the peer is on the LAN adapter that carries the default route
		{"wifi", "lan"},                 // a second adapter (Wi-Fi) that is not the default route
		{"wifi-selfassigned", "lan"},    // the same, with a 169.254 address on the Wi-Fi as well
		{"vpn", "lan"},                  // a full-tunnel VPN carries the default route
		{"no-gateway", "lan"},           // a LAN with a static address and no gateway
		{"cable6", "cable"},             // the cable over IPv6 link-local
		{"wifi6", "lan"},                // Wi-Fi over IPv6 link-local
		{"dhcp-failed-on-lan", "cable"}, // known limit: a LAN adapter that only self-assigned
	} {
		t.Run(c.name, func(t *testing.T) {
			cmd := exec.Command("unshare", "-n", os.Args[0], "-test.run", "^TestCableRuleCase$", "-test.v")
			cmd.Env = append(os.Environ(), "ARH_NETNS_CASE="+c.name)
			out, err := cmd.CombinedOutput()
			text := string(out)
			if strings.Contains(text, "SKIP-NO-IPV6") {
				t.Skip("no IPv6 in this kernel")
			}
			got := ""
			for _, l := range strings.Split(text, "\n") {
				if i := strings.Index(l, "sessionLink="); i >= 0 {
					got = strings.TrimSpace(l[i+len("sessionLink="):])
					t.Log(strings.TrimSpace(l))
				}
			}
			if err != nil || got == "" {
				t.Fatalf("case did not run: %v\n%s", err, text)
			}
			if got != c.want {
				t.Fatalf("%s classified as %s, want %s", c.name, got, c.want)
			}
		})
	}
}

// TestCableRuleCase runs inside the agent's namespace for one case.
func TestCableRuleCase(t *testing.T) {
	name := os.Getenv("ARH_NETNS_CASE")
	if name == "" {
		t.Skip("helper for TestCableRuleInNetworkNamespaces")
	}
	v6 := strings.HasSuffix(name, "6")
	if v6 {
		if _, err := os.Stat("/proc/net/if_inet6"); err != nil {
			fmt.Println("SKIP-NO-IPV6")
			return
		}
	}
	peer := exec.Command("unshare", "-n", os.Args[0], "-test.run", "^TestCableRulePeer$")
	peer.Env = append(os.Environ(), "ARH_NETNS_PEER=1", "ARH_NETNS_CASE=")
	stdout, _ := peer.StdoutPipe()
	peer.Stderr = os.Stderr
	if err := peer.Start(); err != nil {
		t.Fatal(err)
	}
	defer peer.Process.Kill()
	lines := bufio.NewScanner(stdout)
	waitFor := func(s string) {
		t.Helper()
		for lines.Scan() {
			if strings.TrimSpace(lines.Text()) == s {
				return
			}
		}
		t.Fatalf("the peer never said %q", s)
	}
	waitFor("ready")

	// side is the adapter the peer is reached on; spare makes an adapter with no peer.
	side := map[string]string{"cable": "usb0", "cable6": "usb0", "cable-only": "eth0", "wifi": "wlan0",
		"wifi-selfassigned": "wlan0", "wifi6": "wlan0"}[name]
	if side == "" {
		side = "eth0"
	}
	nlVeth(t, side, "peer0")
	nlMove(t, "peer0", peer.Process.Pid)
	link := nlUp(t, side)
	spare := func(n string) int {
		nlVeth(t, n, n+"p")
		nlUp(t, n+"p")
		return nlUp(t, n)
	}
	switch name {
	case "cable", "cable6":
		nlAddr(t, link, "169.254.5.5/16")
		eth := spare("eth0")
		nlAddr(t, eth, "10.0.0.5/24")
		nlRoute(t, eth, "0.0.0.0/0", "10.0.0.1", 100)
	case "cable-only", "dhcp-failed-on-lan":
		nlAddr(t, link, "169.254.5.5/16")
	case "lan":
		nlAddr(t, link, "10.0.0.5/24")
		nlRoute(t, link, "0.0.0.0/0", "10.0.0.1", 100)
		nlRoute(t, link, "169.254.0.0/16", "", 1000)
	case "wifi", "wifi-selfassigned", "wifi6":
		eth := spare("eth0")
		nlAddr(t, eth, "10.0.0.5/24")
		nlRoute(t, eth, "0.0.0.0/0", "10.0.0.1", 100)
		nlAddr(t, link, "10.1.0.5/24")
		nlRoute(t, link, "0.0.0.0/0", "10.1.0.1", 600)
		if name == "wifi-selfassigned" {
			nlAddr(t, link, "169.254.5.5/16")
		} else {
			nlRoute(t, link, "169.254.0.0/16", "", 1000)
		}
	case "vpn":
		nlAddr(t, link, "10.0.0.5/24")
		nlRoute(t, link, "0.0.0.0/0", "10.0.0.1", 100)
		nlRoute(t, link, "169.254.0.0/16", "", 1000)
		tun := spare("tun0")
		nlAddr(t, tun, "10.8.0.2/24")
		nlRoute(t, tun, "0.0.0.0/1", "10.8.0.1", 0)
		nlRoute(t, tun, "128.0.0.0/1", "10.8.0.1", 0)
	case "no-gateway":
		nlAddr(t, link, "10.0.0.5/24")
		nlRoute(t, link, "169.254.0.0/16", "", 1000)
	default:
		t.Fatalf("unknown case %q", name)
	}
	target := "169.254.7.7:47912"
	if v6 {
		nlAddr(t, link, "fe80::5/64")
		target = "[fe80::7%" + side + "]:47912"
	}
	waitFor("listening")
	var c net.Conn
	var err error
	for i := 0; i < 50; i++ {
		if c, err = net.DialTimeout("tcp", target, time.Second); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("dial %s: %v", target, err)
	}
	defer c.Close()
	fmt.Printf("case %s: local %s remote %s default-route %v sessionLink=%s\n", name, c.LocalAddr(), c.RemoteAddr(),
		defaultRouteInterfaces(), sessionLink(c.LocalAddr(), c.RemoteAddr()))
}

// TestCableRulePeer is the other computer: it takes link-local addresses and accepts connections.
func TestCableRulePeer(t *testing.T) {
	if os.Getenv("ARH_NETNS_PEER") == "" {
		t.Skip("helper for TestCableRuleInNetworkNamespaces")
	}
	fmt.Println("ready")
	var idx int
	for i := 0; i < 200 && idx == 0; i++ {
		if x, err := net.InterfaceByName("peer0"); err == nil {
			idx = x.Index
		} else {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if idx == 0 {
		t.Fatal("peer0 never arrived")
	}
	nlUp(t, "peer0")
	nlAddr(t, idx, "169.254.7.7/16")
	if _, err := os.Stat("/proc/net/if_inet6"); err == nil {
		nlAddr(t, idx, "fe80::7/64")
	}
	nlRoute(t, idx, "0.0.0.0/0", "", 100) // answer whatever address the agent's side uses
	ln, err := net.Listen("tcp", ":47912")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("listening")
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func(c net.Conn) { time.Sleep(5 * time.Second); c.Close() }(c)
	}
}

/* ---------- a little rtnetlink, enough for veth pairs, addresses and routes ---------- */

func nlAttr(typ uint16, data []byte) []byte {
	b := make([]byte, (4+len(data)+3)&^3)
	binary.LittleEndian.PutUint16(b[0:], uint16(4+len(data)))
	binary.LittleEndian.PutUint16(b[2:], typ)
	copy(b[4:], data)
	return b
}

func nlU32(v uint32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return b
}

func nlIfinfo(index int, flags, change uint32) []byte {
	b := make([]byte, 16)
	binary.LittleEndian.PutUint32(b[4:], uint32(index))
	binary.LittleEndian.PutUint32(b[8:], flags)
	binary.LittleEndian.PutUint32(b[12:], change)
	return b
}

func nlDo(t *testing.T, typ, flags uint16, payload []byte) {
	t.Helper()
	fd, err := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW, syscall.NETLINK_ROUTE)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.Close(fd)
	if err := syscall.Bind(fd, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); err != nil {
		t.Fatal(err)
	}
	msg := make([]byte, 16+len(payload))
	binary.LittleEndian.PutUint32(msg[0:], uint32(len(msg)))
	binary.LittleEndian.PutUint16(msg[4:], typ)
	binary.LittleEndian.PutUint16(msg[6:], flags|syscall.NLM_F_REQUEST|syscall.NLM_F_ACK)
	binary.LittleEndian.PutUint32(msg[8:], 1)
	copy(msg[16:], payload)
	if err := syscall.Sendto(fd, msg, 0, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8192)
	n, _, err := syscall.Recvfrom(fd, buf, 0)
	if err != nil {
		t.Fatal(err)
	}
	msgs, err := syscall.ParseNetlinkMessage(buf[:n])
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range msgs {
		if m.Header.Type == syscall.NLMSG_ERROR {
			if code := int32(binary.LittleEndian.Uint32(m.Data[0:4])); code != 0 {
				t.Fatalf("netlink message %d: %v", typ, syscall.Errno(-code))
			}
		}
	}
}

func nlVeth(t *testing.T, name, peer string) {
	t.Helper()
	const iflaLinkinfo, iflaInfoKind, iflaInfoData, vethInfoPeer = 18, 1, 2, 1
	peerInfo := append(nlIfinfo(0, 0, 0), nlAttr(syscall.IFLA_IFNAME, append([]byte(peer), 0))...)
	info := append(nlAttr(iflaInfoKind, []byte("veth")), nlAttr(iflaInfoData, nlAttr(vethInfoPeer, peerInfo))...)
	p := append(nlIfinfo(0, 0, 0), nlAttr(syscall.IFLA_IFNAME, append([]byte(name), 0))...)
	nlDo(t, syscall.RTM_NEWLINK, syscall.NLM_F_CREATE|syscall.NLM_F_EXCL, append(p, nlAttr(iflaLinkinfo, info)...))
}

func nlIndex(t *testing.T, name string) int {
	t.Helper()
	x, err := net.InterfaceByName(name)
	if err != nil {
		t.Fatal(err)
	}
	return x.Index
}

func nlUp(t *testing.T, name string) int {
	t.Helper()
	i := nlIndex(t, name)
	nlDo(t, syscall.RTM_NEWLINK, 0, nlIfinfo(i, syscall.IFF_UP, syscall.IFF_UP))
	return i
}

func nlMove(t *testing.T, name string, pid int) {
	t.Helper()
	const iflaNetNsPid = 19
	nlDo(t, syscall.RTM_NEWLINK, 0, append(nlIfinfo(nlIndex(t, name), 0, 0), nlAttr(iflaNetNsPid, nlU32(uint32(pid)))...))
}

func nlAddr(t *testing.T, index int, cidr string) {
	t.Helper()
	const ifaFlags, ifaFNodad = 8, 0x02
	ip, n, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatal(err)
	}
	ones, _ := n.Mask.Size()
	family, raw := byte(syscall.AF_INET6), ip.To16()
	if ip.To4() != nil {
		family, raw = syscall.AF_INET, ip.To4()
	}
	h := []byte{family, byte(ones), 0, 0, 0, 0, 0, 0}
	binary.LittleEndian.PutUint32(h[4:], uint32(index))
	p := append(h, nlAttr(syscall.IFA_LOCAL, raw)...)
	p = append(p, nlAttr(syscall.IFA_ADDRESS, raw)...)
	p = append(p, nlAttr(ifaFlags, nlU32(ifaFNodad))...)
	nlDo(t, syscall.RTM_NEWADDR, syscall.NLM_F_CREATE|syscall.NLM_F_EXCL, p)
}

func nlRoute(t *testing.T, index int, dst, gw string, metric uint32) {
	t.Helper()
	_, d, err := net.ParseCIDR(dst)
	if err != nil {
		t.Fatal(err)
	}
	ones, _ := d.Mask.Size()
	scope := byte(syscall.RT_SCOPE_UNIVERSE)
	if gw == "" {
		scope = syscall.RT_SCOPE_LINK
	}
	p := []byte{syscall.AF_INET, byte(ones), 0, 0, syscall.RT_TABLE_MAIN, syscall.RTPROT_BOOT, scope, syscall.RTN_UNICAST, 0, 0, 0, 0}
	if ones > 0 {
		p = append(p, nlAttr(syscall.RTA_DST, d.IP.To4())...)
	}
	if gw != "" {
		p = append(p, nlAttr(syscall.RTA_GATEWAY, net.ParseIP(gw).To4())...)
	}
	p = append(p, nlAttr(syscall.RTA_OIF, nlU32(uint32(index)))...)
	p = append(p, nlAttr(syscall.RTA_PRIORITY, nlU32(metric))...)
	nlDo(t, syscall.RTM_NEWROUTE, syscall.NLM_F_CREATE|syscall.NLM_F_EXCL, p)
}
