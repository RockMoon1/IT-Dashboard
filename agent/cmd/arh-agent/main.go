// arh-agent is the small, dependency-free program installed on a target computer. It connects
// outbound to the ARH IT Dashboard over the USB network link and runs only the read-only scan
// profiles compiled into it. See docs/PROTOCOL.md.
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
	"syscall"

	"github.com/RockMoon1/IT-Dashboard/agent/internal/identity"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/keystore"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/link"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/service"
	"github.com/RockMoon1/IT-Dashboard/agent/internal/sysinfo"
	"github.com/RockMoon1/IT-Dashboard/profiles"
)

// version is set at build time: -ldflags "-X main.version=0.2.0".
var version = "0.2.0-dev"

func usage() {
	fmt.Fprintf(os.Stderr, `arh-agent %s

Usage:
  arh-agent install --token ARH-XXXXXXXX-XXXXXXXXXXXXXXXX   install as a system service and enroll (admin / sudo)
  arh-agent uninstall                                       remove the service, firewall rule and device key (admin / sudo)
  arh-agent run [--data-dir DIR]                            run in the foreground (what the service executes)
  arh-agent status                                          show identity, enrollment and install paths
  arh-agent profiles                                        list the scan profiles compiled into this build
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
	if err := fs.Parse(args); err != nil {
		return err
	}
	l := service.DefaultLayout()
	if err := service.Install(l, *token); err != nil {
		return fmt.Errorf("%w (this step needs an administrator / sudo shell)", err)
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
