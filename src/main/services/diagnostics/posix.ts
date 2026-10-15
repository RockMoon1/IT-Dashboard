import type { CommandSpec, Purpose } from '../../../shared/types.ts'

/**
 * macOS and Linux diagnostic command sets. Each script is POSIX sh and is delivered to the target
 * on stdin of `/bin/sh -s`, so the user's login shell (zsh on macOS) never parses it.
 * Scripts avoid sudo: anything that needs root prints a clear note instead of failing.
 */

const sh = (
  id: string,
  title: string,
  script: string,
  extra: Partial<CommandSpec> = {}
): CommandSpec => ({ id, title, shell: 'sh', format: 'text', script: script.trim(), ...extra })

const MAC_SYSTEM: CommandSpec[] = [
  sh(
    'sys-overview',
    'System overview',
    String.raw`
sw_vers
echo "kernel: $(uname -mr)"
echo "hostname: $(hostname)"
echo "user: $(id -un)"
uptime
echo "cpu: $(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
echo "cores: $(sysctl -n hw.ncpu)"
echo "memory_gb: $(( $(sysctl -n hw.memsize) / 1073741824 ))"
system_profiler SPHardwareDataType 2>/dev/null | grep -E 'Model Name|Model Identifier|Chip|Serial Number|System Firmware|Memory'
echo "--- disks"
df -h / /System/Volumes/Data 2>/dev/null
echo "--- memory pressure"
memory_pressure 2>/dev/null | tail -1
`
  ),
  sh(
    'sys-thermal-power',
    'Thermal and power state',
    String.raw`
pmset -g therm 2>/dev/null
pmset -g batt 2>/dev/null
echo "(per-sensor temperatures need root: sudo powermetrics --samplers smc -n 1)"
`,
    { optional: true }
  ),
  sh(
    'sys-kexts',
    'Third-party kernel and system extensions',
    String.raw`
kextstat 2>/dev/null | grep -v com.apple | head -30
systemextensionsctl list 2>/dev/null | head -40
`,
    { optional: true }
  )
]

const LINUX_SYSTEM: CommandSpec[] = [
  sh(
    'sys-overview',
    'System overview',
    String.raw`
hostnamectl 2>/dev/null || { uname -a; cat /etc/os-release 2>/dev/null; }
echo "user: $(id -un)"
uptime -p 2>/dev/null || uptime
echo "--- cpu"
lscpu 2>/dev/null | grep -E 'Model name|^CPU\(s\)|Thread|Socket' || grep -m1 'model name' /proc/cpuinfo
echo "--- load"
cat /proc/loadavg
echo "--- memory"
free -h
echo "--- disks"
df -h -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -h
echo "--- firmware"
cat /sys/class/dmi/id/bios_version /sys/class/dmi/id/bios_date /sys/class/dmi/id/product_name 2>/dev/null
`
  ),
  sh(
    'sys-thermal',
    'Thermal zones',
    String.raw`
found=0
for z in /sys/class/thermal/thermal_zone*; do
  [ -f "$z/temp" ] || continue
  found=1
  t=$(cat "$z/temp" 2>/dev/null)
  ty=$(cat "$z/type" 2>/dev/null)
  echo "$ty: $(awk "BEGIN { printf \"%.1f\", $t / 1000 }") C"
done
[ "$found" = 1 ] || echo "no thermal zones exposed via sysfs"
sensors 2>/dev/null | head -30
`,
    { optional: true }
  ),
  sh(
    'sys-drivers',
    'Kernel modules and PCI drivers',
    String.raw`
lspci -k 2>/dev/null | grep -E '^[0-9a-f]|Kernel driver' | head -60
echo "--- modules"
lsmod 2>/dev/null | head -30
`,
    { optional: true }
  )
]

const MAC_SECURITY: CommandSpec[] = [
  sh(
    'sec-status',
    'Gatekeeper, firewall, FileVault, SIP',
    String.raw`
echo "gatekeeper: $(spctl --status 2>&1)"
echo "app_firewall: $(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>&1)"
echo "stealth_mode: $(/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode 2>&1)"
echo "filevault: $(fdesetup status 2>&1)"
echo "sip: $(csrutil status 2>&1)"
echo "xprotect: $(defaults read /Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist CFBundleShortVersionString 2>/dev/null)"
`
  ),
  sh(
    'sec-updates',
    'Software update history',
    String.raw`
softwareupdate --history 2>/dev/null | tail -12
echo "--- automatic updates"
defaults read /Library/Preferences/com.apple.SoftwareUpdate 2>/dev/null | grep -E 'AutomaticCheckEnabled|AutomaticDownload|CriticalUpdateInstall|ConfigDataInstall'
`,
    { optional: true }
  ),
  sh(
    'sec-admins',
    'Administrator accounts and remote access',
    String.raw`
echo "admins: $(dscl . -read /Groups/admin GroupMembership 2>/dev/null | cut -d: -f2)"
echo "remote_login_ssh: $(systemsetup -getremotelogin 2>&1)"
echo "screen_sharing: $(launchctl print system/com.apple.screensharing >/dev/null 2>&1 && echo enabled || echo disabled)"
`,
    { optional: true }
  )
]

const LINUX_SECURITY: CommandSpec[] = [
  sh(
    'sec-firewall',
    'Firewall state',
    String.raw`
if command -v ufw >/dev/null 2>&1; then ufw status 2>&1 | head -20
elif command -v firewall-cmd >/dev/null 2>&1; then firewall-cmd --state 2>&1; firewall-cmd --list-all 2>&1 | head -30
elif command -v nft >/dev/null 2>&1; then nft list ruleset 2>&1 | head -40
else iptables -S 2>&1 | head -40; fi
`
  ),
  sh(
    'sec-updates',
    'Package update state',
    String.raw`
if command -v apt >/dev/null 2>&1; then
  echo "last apt history: $(ls -l --time-style=long-iso /var/log/apt/history.log 2>/dev/null | awk '{print $6, $7}')"
  apt list --upgradable 2>/dev/null | head -20
elif command -v dnf >/dev/null 2>&1; then dnf check-update 2>/dev/null | tail -20
elif command -v rpm >/dev/null 2>&1; then rpm -qa --last 2>/dev/null | head -10
elif command -v pacman >/dev/null 2>&1; then pacman -Qu 2>/dev/null | head -20
fi
[ -f /var/run/reboot-required ] && echo "REBOOT REQUIRED: $(cat /var/run/reboot-required.pkgs 2>/dev/null | tr '\n' ' ')"
`,
    { optional: true }
  ),
  sh(
    'sec-hardening',
    'Sudo users, SSH daemon settings, disk encryption, MAC status',
    String.raw`
echo "sudo_group: $(getent group sudo wheel 2>/dev/null | cut -d: -f4 | tr '\n' ' ')"
echo "--- sshd"
grep -Ei '^\s*(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|Port)\b' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null
echo "--- block devices"
lsblk -o NAME,TYPE,FSTYPE,SIZE,MOUNTPOINT 2>/dev/null
echo "--- mandatory access control"
command -v aa-status >/dev/null 2>&1 && (aa-status --enabled 2>/dev/null && echo "apparmor: enabled" || echo "apparmor: disabled")
command -v getenforce >/dev/null 2>&1 && echo "selinux: $(getenforce 2>/dev/null)"
echo "--- antivirus"
systemctl is-active clamav-daemon clamd 2>/dev/null | head -2
`,
    { optional: true }
  )
]

const MAC_EMAIL: CommandSpec[] = [
  sh(
    'mail-clients',
    'Installed mail clients',
    String.raw`
ls /Applications 2>/dev/null | grep -Ei 'outlook|mail|thunderbird'
echo "outlook_version: $(defaults read /Applications/Microsoft\ Outlook.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null)"
echo "apple_mail_accounts: $(defaults read ~/Library/Preferences/com.apple.mail-shared 2>/dev/null | grep -c -i 'smtp' )"
`
  ),
  sh(
    'mail-connectivity',
    'TCP reachability of Microsoft 365 endpoints',
    String.raw`
for t in outlook.office365.com:443 smtp.office365.com:587 login.microsoftonline.com:443 autodiscover-s.outlook.com:443; do
  h=$(echo "$t" | cut -d: -f1); p=$(echo "$t" | cut -d: -f2)
  if nc -z -w 4 "$h" "$p" >/dev/null 2>&1; then echo "$h:$p reachable"; else echo "$h:$p UNREACHABLE"; fi
done
`
  ),
  sh(
    'mail-dns',
    'DNS resolver configuration',
    String.raw`
scutil --dns 2>/dev/null | grep -E 'nameserver|search domain' | sort -u | head -10
`,
    { optional: true }
  )
]

const LINUX_EMAIL: CommandSpec[] = [
  sh(
    'mail-clients',
    'Installed mail clients',
    String.raw`
for c in thunderbird evolution kmail geary mutt; do command -v "$c" >/dev/null 2>&1 && echo "$c: $(command -v $c)"; done
flatpak list 2>/dev/null | grep -Ei 'thunderbird|evolution|geary'
`
  ),
  sh(
    'mail-connectivity',
    'TCP reachability of Microsoft 365 endpoints',
    String.raw`
for t in outlook.office365.com:443 smtp.office365.com:587 login.microsoftonline.com:443 autodiscover-s.outlook.com:443; do
  h=$(echo "$t" | cut -d: -f1); p=$(echo "$t" | cut -d: -f2)
  if command -v nc >/dev/null 2>&1; then
    if nc -z -w 4 "$h" "$p" >/dev/null 2>&1; then echo "$h:$p reachable"; else echo "$h:$p UNREACHABLE"; fi
  elif command -v timeout >/dev/null 2>&1; then
    if timeout 4 sh -c "exec 3<>/dev/tcp/$h/$p" 2>/dev/null; then echo "$h:$p reachable"; else echo "$h:$p UNREACHABLE"; fi
  else
    echo "$h:$p (no nc/timeout available to test)"
  fi
done
`
  ),
  sh(
    'mail-dns',
    'DNS resolver configuration',
    String.raw`
resolvectl status 2>/dev/null | grep -E 'DNS Servers|DNS Domain' | head -10 || cat /etc/resolv.conf
`,
    { optional: true }
  )
]

const MAC_HARDWARE: CommandSpec[] = [
  sh(
    'hw-storage',
    'Storage devices and SMART status',
    String.raw`
diskutil list 2>/dev/null | head -40
for d in $(diskutil list 2>/dev/null | grep -Eo '^/dev/disk[0-9]+' | sort -u); do
  echo "--- $d"
  diskutil info "$d" 2>/dev/null | grep -E 'Device / Media Name|SMART Status|Solid State|Disk Size|Protocol'
done
`
  ),
  sh(
    'hw-battery',
    'Battery condition',
    String.raw`
system_profiler SPPowerDataType 2>/dev/null | grep -E 'Cycle Count|Condition|Maximum Capacity|Full Charge Capacity|State of Charge'
pmset -g batt 2>/dev/null
`,
    { optional: true }
  ),
  sh(
    'hw-usb',
    'USB devices',
    String.raw`
system_profiler SPUSBDataType 2>/dev/null | grep -E '^\s{4,8}[A-Za-z].*:$|Product ID|Vendor ID|Serial Number' | head -60
`,
    { optional: true }
  ),
  sh(
    'hw-errors',
    'Recent kernel/hardware errors (last hour)',
    String.raw`
log show --last 1h --predicate 'process == "kernel" AND (eventMessage CONTAINS[c] "error" OR eventMessage CONTAINS[c] "fault")' --style compact 2>/dev/null | tail -30
`,
    { optional: true, timeoutMs: 120000 }
  )
]

const LINUX_HARDWARE: CommandSpec[] = [
  sh(
    'hw-devices',
    'PCI and USB devices',
    String.raw`
lspci 2>/dev/null | head -40
echo "--- usb"
lsusb 2>/dev/null | head -30
`
  ),
  sh(
    'hw-storage',
    'Block devices and SMART health',
    String.raw`
lsblk -o NAME,MODEL,SIZE,TYPE,ROTA,TRAN,MOUNTPOINT 2>/dev/null
if command -v smartctl >/dev/null 2>&1; then
  for d in $(lsblk -dn -o NAME,TYPE 2>/dev/null | awk '$2=="disk"{print "/dev/"$1}'); do
    echo "--- $d"; smartctl -H "$d" 2>&1 | grep -Ei 'overall-health|SMART Health|Permission denied' || echo "smartctl needs root for $d"
  done
else
  echo "smartctl not installed (apt install smartmontools) - SMART not checked"
fi
`
  ),
  sh(
    'hw-battery',
    'Battery condition',
    String.raw`
if command -v upower >/dev/null 2>&1; then
  for b in $(upower -e 2>/dev/null | grep -i bat); do upower -i "$b" | grep -E 'state|percentage|energy-full|energy-full-design|capacity|cycle'; done
else
  for b in /sys/class/power_supply/BAT*; do [ -d "$b" ] && { echo "$b"; cat "$b/status" "$b/capacity" "$b/cycle_count" 2>/dev/null; }; done
fi
`,
    { optional: true }
  ),
  sh(
    'hw-errors',
    'Kernel and journal errors (last 7 days)',
    String.raw`
journalctl -p err -S -7d --no-pager 2>/dev/null | tail -40 || dmesg --level=err,crit,alert,emerg 2>/dev/null | tail -40
`,
    { optional: true }
  )
]

const MAC_PERFORMANCE: CommandSpec[] = [
  sh(
    'perf-resources',
    'CPU, memory and disk pressure',
    String.raw`
top -l 2 -n 0 -s 1 2>/dev/null | grep -E 'CPU usage|PhysMem|Load Avg' | tail -3
memory_pressure 2>/dev/null | tail -1
echo "--- swap"
sysctl -n vm.swapusage 2>/dev/null
echo "--- disk"
df -h / 2>/dev/null
`
  ),
  sh(
    'perf-top-processes',
    'Top processes by CPU and memory',
    String.raw`
top -l 2 -n 12 -o cpu -stats pid,command,cpu,mem 2>/dev/null | tail -14
echo "--- by memory"
top -l 1 -n 12 -o mem -stats pid,command,cpu,mem 2>/dev/null | tail -13
`
  ),
  sh(
    'perf-startup',
    'Login items and third-party launch agents',
    String.raw`
osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null
echo "--- launch agents/daemons (non-Apple)"
ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null | grep -v '^$' | grep -v com.apple | head -40
`,
    { optional: true }
  )
]

const LINUX_PERFORMANCE: CommandSpec[] = [
  sh(
    'perf-resources',
    'CPU, memory and disk pressure',
    String.raw`
cat /proc/loadavg
echo "--- vmstat (3 samples)"
vmstat 1 3 2>/dev/null
echo "--- memory"
free -h
echo "--- pressure stall info"
for f in cpu memory io; do [ -f /proc/pressure/$f ] && echo "$f: $(head -1 /proc/pressure/$f)"; done
echo "--- disk"
df -h -x tmpfs -x devtmpfs 2>/dev/null | head -15
`
  ),
  sh(
    'perf-top-processes',
    'Top processes by CPU and memory',
    String.raw`
ps -eo pid,user,pcpu,pmem,rss,etime,comm --sort=-pcpu 2>/dev/null | head -12
echo "--- by memory"
ps -eo pid,user,pcpu,pmem,rss,etime,comm --sort=-rss 2>/dev/null | head -12
`
  ),
  sh(
    'perf-services',
    'Running services and boot blame',
    String.raw`
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -40
echo "--- boot blame"
systemd-analyze blame --no-pager 2>/dev/null | head -12
`,
    { optional: true }
  )
]

const MAC_PHISHING: CommandSpec[] = [
  sh(
    'phish-extensions',
    'Browser extensions (Chrome, Edge, Brave, Safari)',
    String.raw`
for root in "$HOME/Library/Application Support/Google/Chrome" "$HOME/Library/Application Support/Microsoft Edge" "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"; do
  [ -d "$root" ] || continue
  echo "--- $root"
  find "$root" -maxdepth 4 -path '*/Extensions/*' -name manifest.json 2>/dev/null | while read -r m; do
    id=$(basename "$(dirname "$(dirname "$m")")")
    name=$(grep -m1 '"name"' "$m" | sed 's/.*"name"[^"]*"\([^"]*\)".*/\1/')
    echo "$id | $name"
  done
done
echo "--- safari"
pluginkit -mAvvv -p com.apple.Safari.extension 2>/dev/null | grep -E 'Display Name|Path' | head -40
`
  ),
  sh(
    'phish-settings',
    'Gatekeeper, proxy, DNS and hosts overrides',
    String.raw`
echo "gatekeeper: $(spctl --status 2>&1)"
echo "--- proxy"
scutil --proxy 2>/dev/null | grep -E 'Enable|Proxy|PAC' | grep -v ': 0$'
echo "--- dns"
scutil --dns 2>/dev/null | grep nameserver | sort -u
echo "--- hosts overrides"
grep -v '^#' /etc/hosts | grep -v '^$' | grep -v 'localhost'
`
  ),
  sh(
    'phish-downloads',
    'Recent quarantined downloads and risky files',
    String.raw`
sqlite3 "$HOME/Library/Preferences/com.apple.LaunchServices.QuarantineEventsV2" "select datetime(LSQuarantineTimeStamp + 978307200, 'unixepoch'), LSQuarantineAgentName, LSQuarantineOriginURLString from LSQuarantineEvent order by LSQuarantineTimeStamp desc limit 15" 2>/dev/null
echo "--- Downloads (14 days)"
find "$HOME/Downloads" -maxdepth 1 -type f -mtime -14 \( -name '*.dmg' -o -name '*.pkg' -o -name '*.zip' -o -name '*.sh' -o -name '*.command' -o -name '*.app' \) -exec ls -la {} \; 2>/dev/null | head -30
`,
    { optional: true }
  )
]

const LINUX_PHISHING: CommandSpec[] = [
  sh(
    'phish-extensions',
    'Browser extensions (Chrome, Chromium, Brave, Firefox)',
    String.raw`
for root in "$HOME/.config/google-chrome" "$HOME/.config/chromium" "$HOME/.config/BraveSoftware/Brave-Browser" "$HOME/.config/microsoft-edge"; do
  [ -d "$root" ] || continue
  echo "--- $root"
  find "$root" -maxdepth 4 -path '*/Extensions/*' -name manifest.json 2>/dev/null | while read -r m; do
    id=$(basename "$(dirname "$(dirname "$m")")")
    name=$(grep -m1 '"name"' "$m" | sed 's/.*"name"[^"]*"\([^"]*\)".*/\1/')
    echo "$id | $name"
  done
done
for p in "$HOME"/.mozilla/firefox/*/extensions.json "$HOME"/snap/firefox/common/.mozilla/firefox/*/extensions.json; do
  [ -f "$p" ] || continue
  echo "--- firefox: $p"
  tr ',' '\n' < "$p" | grep -E '"id":|"name":' | grep -v '"name":""' | head -40
done
`
  ),
  sh(
    'phish-settings',
    'Proxy, DNS and hosts overrides',
    String.raw`
echo "--- proxy env"
env | grep -i proxy
gsettings get org.gnome.system.proxy mode 2>/dev/null
echo "--- dns"
resolvectl status 2>/dev/null | grep -E 'DNS Servers' | head -5 || grep nameserver /etc/resolv.conf
echo "--- hosts overrides"
grep -v '^#' /etc/hosts | grep -v '^$' | grep -Ev 'localhost|ip6-'
`
  ),
  sh(
    'phish-downloads',
    'Recent risky downloads',
    String.raw`
find "$HOME/Downloads" -maxdepth 1 -type f -mtime -14 \( -name '*.sh' -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' -o -name '*.run' -o -name '*.zip' -o -name '*.tar.gz' -o -name '*.py' \) -exec ls -la {} \; 2>/dev/null | head -30
`,
    { optional: true }
  )
]

export const MACOS_COMMANDS: Record<Exclude<Purpose, 'other'>, CommandSpec[]> = {
  'system-diagnostics': MAC_SYSTEM,
  'security-check': MAC_SECURITY,
  'email-setup': MAC_EMAIL,
  'hardware-issues': MAC_HARDWARE,
  'slow-performance': MAC_PERFORMANCE,
  'phishing-assessment': MAC_PHISHING
}

export const LINUX_COMMANDS: Record<Exclude<Purpose, 'other'>, CommandSpec[]> = {
  'system-diagnostics': LINUX_SYSTEM,
  'security-check': LINUX_SECURITY,
  'email-setup': LINUX_EMAIL,
  'hardware-issues': LINUX_HARDWARE,
  'slow-performance': LINUX_PERFORMANCE,
  'phishing-assessment': LINUX_PHISHING
}
