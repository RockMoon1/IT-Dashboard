// arh-agent is the small, dependency-free program installed on a target computer. It connects
// outbound to the ARH IT Dashboard over the USB network link and runs only the scan profiles and
// named actions compiled into it, plus custom commands when this device's policy allows them.
// See docs/PROTOCOL.md and docs/PHASE3-DESIGN.md.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/RockMoon1/IT-Dashboard/actions"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/identity"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/keystore"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/link"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/policy"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/service"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/sysinfo"
	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// version is set at build time: -ldflags "-X main.version=0.2.0".
var version = "0.2.0-dev"

func usage() {
	fmt.Fprintf(os.Stderr, `arh-agent %s

Usage:
  arh-agent install --token ARH-XXXXXXXX-XXXXXXXXXXXXXXXX [--policy actions|full|read|clinical]
                                                            install as a system service and enroll (admin / sudo);
                                                            the policy is written only if the device has none yet
  arh-agent uninstall                                       remove the service, firewall rule and device key (admin / sudo)
  arh-agent run [--data-dir DIR]                            run in the foreground (what the service executes)
  arh-agent status                                          show identity, enrollment, policy and install paths
  arh-agent profiles                                        list the scan profiles compiled into this build
  arh-agent actions                                         list the named actions compiled into this build
  arh-agent policy [--set PRESET] [--allow K,K] [--deny K,K] [--deny-action NAME] [--allow-action NAME]
                                                            show or change what the dashboard may do here (admin / sudo);
                                                            K is write, execute, custom, lan or interrupts
  arh-agent host-cert [--cn NAME]                           generate a dashboard TLS identity (used by the dashboard itself)
  arh-agent version
`, version)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(version)
	case "host-cert":
		err = cmdHostCert(os.Args[2:])
	case "install":
		err = cmdInstall(os.Args[2:])
	case "uninstall":
		err = cmdUninstall()
	case "run":
		err = cmdRun(os.Args[2:])
	case "status":
		err = cmdStatus()
	case "profiles":
		err = cmdProfiles()
	case "actions":
		err = cmdActions()
	case "policy":
		err = cmdPolicy(os.Args[2:])
	case "help", "-h", "--help":
		usage()
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func cmdHostCert(args []string) error {
	fs := flag.NewFlagSet("host-cert", flag.ContinueOnError)
	cn := fs.String("cn", "ARH IT Dashboard", "certificate common name")
	if err := fs.Parse(args); err != nil {
		return err
	}
	hc, err := identity.GenerateHostCert(*cn)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	return enc.Encode(hc)
}

func cmdInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	token := fs.String("token", "", "enrollment token shown by the dashboard")
	preset := fs.String("policy", "actions", "what the dashboard may do here if the device has no policy yet: actions, full, read or clinical")
	if err := fs.Parse(args); err != nil {
		return err
	}
	pol, err := policy.Preset(*preset)
	if err != nil {
		return err
	}
	l := service.DefaultLayout()
	if err := service.Install(l, *token); err != nil {
		return fmt.Errorf("%w (this step needs an administrator / sudo shell)", err)
	}
	// A reinstall (the upgrade path) never overwrites a policy set on the device.
	if _, err := os.Stat(policy.Path(l.DataDir)); os.IsNotExist(err) {
		if err := policy.Save(l.DataDir, pol); err != nil {
			return fmt.Errorf("writing the device policy: %w", err)
		}
		fmt.Printf("Device policy: %s (change with arh-agent policy)\n", *preset)
	} else {
		fmt.Printf("Device policy: kept the existing one (%s)\n", describePolicy(policy.Load(l.DataDir)))
	}
	store := keystore.New(l.DataDir)
	id, err := identity.LoadOrCreate(store, l.DataDir, sysinfo.Hostname())
	if err != nil {
		return err
	}
	fmt.Printf("Installed %s to %s\n", service.DisplayName, l.ExePath)
	fmt.Printf("Device key: %s\n", store.Describe())
	fmt.Printf("Device fingerprint: %s\n", id.Fingerprint)
	fmt.Printf("Waiting for the dashboard beacon on the USB link to complete enrollment.\n")
	return nil
}

func cmdUninstall() error {
	l := service.DefaultLayout()
	store := keystore.New(l.DataDir)
	_ = store.Delete(identity.KeyName)
	if err := service.Uninstall(l); err != nil {
		return err
	}
	fmt.Println("Removed", service.DisplayName)
	return nil
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	l := service.DefaultLayout()
	dataDir := fs.String("data-dir", l.DataDir, "data directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		return err
	}
	logger := log.New(os.Stderr, "", log.LstdFlags)
	if f, err := os.OpenFile(filepath.Join(*dataDir, "agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		defer f.Close()
		logger = log.New(io.MultiWriter(os.Stderr, f), "", log.LstdFlags)
	}
	store := keystore.New(*dataDir)
	id, err := identity.LoadOrCreate(store, *dataDir, sysinfo.Hostname())
	if err != nil {
		return err
	}
	agent := link.New(link.Config{
		DataDir:  *dataDir,
		Identity: id,
		Version:  version,
		Hostname: sysinfo.Hostname(),
		Serial:   sysinfo.Serial(),
		OS:       sysinfo.OSName(),
		Logger:   logger,
	})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return agent.Run(ctx)
}

func cmdStatus() error {
	l := service.DefaultLayout()
	fmt.Printf("version:     %s\n", version)
	fmt.Printf("os:          %s\n", sysinfo.OSName())
	fmt.Printf("hostname:    %s\n", sysinfo.Hostname())
	fmt.Printf("serial:      %s\n", sysinfo.Serial())
	fmt.Printf("executable:  %s\n", l.ExePath)
	fmt.Printf("data dir:    %s\n", l.DataDir)
	store := keystore.New(l.DataDir)
	fmt.Printf("keystore:    %s\n", store.Describe())
	if _, err := store.Load(identity.KeyName); err == nil {
		if id, err := identity.LoadOrCreate(store, l.DataDir, sysinfo.Hostname()); err == nil {
			fmt.Printf("device id:   %s\n", id.Fingerprint)
		}
	} else {
		fmt.Printf("device id:   (no key yet)\n")
	}
	if b, err := os.ReadFile(filepath.Join(l.DataDir, "host.json")); err == nil {
		fmt.Printf("enrolled:    %s\n", string(b))
	} else if tok, err := service.ReadPendingToken(l.DataDir); err == nil {
		fmt.Printf("enrolled:    no, pending token %s\n", tok)
	} else {
		fmt.Printf("enrolled:    no\n")
	}
	fmt.Printf("policy:      %s\n", describePolicy(policy.Load(l.DataDir)))
	return nil
}

func describePolicy(p policy.Policy) string {
	if p.Error != "" {
		return "read only (" + p.Error + ")"
	}
	var on []string
	for _, x := range []struct {
		name string
		v    bool
	}{{"write", p.Write}, {"execute", p.Execute}, {"custom", p.Custom}, {"lan", p.LAN}, {"interrupts", p.Interrupts}} {
		if x.v {
			on = append(on, x.name)
		}
	}
	s := "read"
	if len(on) > 0 {
		s += ", " + strings.Join(on, ", ")
	}
	if len(p.Deny) > 0 {
		s += "; refuses " + strings.Join(p.Deny, ", ")
	}
	return s
}

func cmdActions() error {
	all, err := actions.All()
	if err != nil {
		return err
	}
	for _, a := range all {
		if a.OS != sysinfo.OSName() {
			continue
		}
		fmt.Printf("%-32s v%d  %-7s %-10s %s\n", a.Name, a.Version, a.Access, a.Impact, a.Title)
	}
	return nil
}

func cmdPolicy(args []string) error {
	fs := flag.NewFlagSet("policy", flag.ContinueOnError)
	set := fs.String("set", "", "start from a preset: actions, full, read or clinical")
	allow := fs.String("allow", "", "comma-separated: write, execute, custom, lan, interrupts")
	deny := fs.String("deny", "", "comma-separated: write, execute, custom, lan, interrupts")
	denyAction := fs.String("deny-action", "", "refuse named actions, comma-separated (see arh-agent actions)")
	allowAction := fs.String("allow-action", "", "stop refusing named actions, comma-separated")
	if err := fs.Parse(args); err != nil {
		return err
	}
	l := service.DefaultLayout()
	p := policy.Load(l.DataDir)
	if *set == "" && *allow == "" && *deny == "" && *denyAction == "" && *allowAction == "" {
		fmt.Println(describePolicy(p))
		return nil
	}
	if *set != "" {
		var err error
		if p, err = policy.Preset(*set); err != nil {
			return err
		}
	} else if p.Error != "" {
		return fmt.Errorf("the current policy is unusable (%s); start from a preset with --set", p.Error)
	}
	apply := func(list string, v bool) error {
		for _, k := range strings.Split(list, ",") {
			switch strings.TrimSpace(k) {
			case "":
			case "write":
				p.Write = v
			case "execute":
				p.Execute = v
			case "custom":
				p.Custom = v
			case "lan":
				p.LAN = v
			case "interrupts":
				p.Interrupts = v
			default:
				return fmt.Errorf("unknown kind %q (write, execute, custom, lan, interrupts)", k)
			}
		}
		return nil
	}
	if err := apply(*allow, true); err != nil {
		return err
	}
	if err := apply(*deny, false); err != nil {
		return err
	}
	// action names, one or a comma-separated list, each checked against this agent's actions so
	// a typo is an error rather than a refusal that refuses nothing
	names := func(list string) ([]string, error) {
		var out []string
		for _, n := range strings.Split(list, ",") {
			n = strings.TrimSpace(n)
			if n == "" {
				continue
			}
			known := false
			for _, a := range actions.ForOS(sysinfo.OSName()) {
				if strings.EqualFold(a.Name, n) {
					n, known = a.Name, true
				}
			}
			if !known {
				return nil, fmt.Errorf("no action %q on this agent (arh-agent actions lists them)", n)
			}
			out = append(out, n)
		}
		return out, nil
	}
	denyNames, err := names(*denyAction)
	if err != nil {
		return err
	}
	allowNames, err := names(*allowAction)
	if err != nil {
		return err
	}
	has := func(list []string, n string) bool {
		for _, d := range list {
			if strings.EqualFold(d, n) {
				return true
			}
		}
		return false
	}
	for _, n := range denyNames {
		if !has(p.Deny, n) {
			p.Deny = append(p.Deny, n)
		}
	}
	kept := p.Deny[:0]
	for _, d := range p.Deny {
		if !has(allowNames, d) {
			kept = append(kept, d)
		}
	}
	p.Deny = kept
	if err := policy.Save(l.DataDir, p); err != nil {
		return fmt.Errorf("%w (this step needs an administrator / sudo shell)", err)
	}
	fmt.Println(describePolicy(policy.Load(l.DataDir)))
	if p.Custom {
		fmt.Println("Note: with custom commands allowed, anyone holding the dashboard's key and a cable to this computer can run any command here as SYSTEM/root, including one that changes this policy.")
	}
	return nil
}

func cmdProfiles() error {
	all, err := profiles.All()
	if err != nil {
		return err
	}
	for _, p := range all {
		fmt.Printf("%-32s v%d  %-8s %d checks  %s\n", p.Name, p.Version, p.OS, len(p.Checks), p.Title)
	}
	return nil
}
