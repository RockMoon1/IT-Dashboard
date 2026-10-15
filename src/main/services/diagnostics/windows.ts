import type { CommandSpec, Purpose } from '../../../shared/types.ts'

/**
 * Windows diagnostic command sets, one PowerShell script per command.
 *
 * Conventions:
 * - `format: 'json'` scripts emit exactly one JSON document via ConvertTo-Json -InputObject so
 *   single-element arrays stay arrays (piping into ConvertTo-Json unwraps them on PowerShell 5.1).
 * - Anything that needs admin rights or an unsupported WMI class is wrapped in try/catch and
 *   reports `available: false` / `supported: false` instead of failing the session.
 * - Scripts are written with String.raw so backslashes survive; they must not contain backticks
 *   or the sequence "${" (template-literal syntax).
 * - Under WinRM, HKCU and %LOCALAPPDATA% refer to the remoting account, not the person logged on
 *   at the console. Commands that read per-user state report `evaluatedAs` so this is visible.
 */

const ps = (
  id: string,
  title: string,
  format: 'json' | 'text',
  script: string,
  extra: Partial<CommandSpec> = {}
): CommandSpec => ({ id, title, shell: 'powershell', format, script: script.trim(), ...extra })

const REG_HELPER = String.raw`
function Get-RegValue($path, $name) { try { (Get-ItemProperty -Path $path -Name $name -ErrorAction Stop).$name } catch { $null } }
`

const PROBLEM_DEVICES = ps(
  'problem-devices',
  'Plug and Play devices with a non-OK status',
  'json',
  String.raw`
$bad = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Status -ne 'OK' } | Select-Object FriendlyName, Class, Status, InstanceId)
ConvertTo-Json -InputObject $bad -Compress
`
)

const SYSTEM_DIAGNOSTICS: CommandSpec[] = [
  ps(
    'sys-overview',
    'System overview (OS, CPU, RAM, disks, BIOS)',
    'json',
    String.raw`
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS
$load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [pscustomobject]@{
    drive = $_.DeviceID
    sizeGB = [math]::Round($_.Size / 1GB, 1)
    freeGB = [math]::Round($_.FreeSpace / 1GB, 1)
    freePct = if ($_.Size) { [math]::Round(100 * $_.FreeSpace / $_.Size, 1) } else { $null }
  }
})
$biosDate = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { $null }
$info = [ordered]@{
  hostname = $env:COMPUTERNAME
  evaluatedAs = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  os = $os.Caption
  version = $os.Version
  build = $os.BuildNumber
  arch = $os.OSArchitecture
  lastBoot = $os.LastBootUpTime.ToString('s')
  uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  manufacturer = $cs.Manufacturer
  model = $cs.Model
  cpu = $cpu.Name
  cores = $cpu.NumberOfCores
  logicalProcessors = $cpu.NumberOfLogicalProcessors
  cpuLoadPct = $load
  ramTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  ramFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
  ramUsedPct = [math]::Round(100 * (1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize), 1)
  biosVersion = $bios.SMBIOSBIOSVersion
  biosDate = $biosDate
  serial = $bios.SerialNumber
  disks = $disks
}
ConvertTo-Json -InputObject ([pscustomobject]$info) -Depth 4 -Compress
`
  ),
  PROBLEM_DEVICES,
  ps(
    'sys-thermal',
    'ACPI thermal zones (unsupported on many consumer boards)',
    'json',
    String.raw`
try {
  $zones = @(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ zone = $_.InstanceName; celsius = [math]::Round(($_.CurrentTemperature / 10) - 273.15, 1) }
  })
  ConvertTo-Json -InputObject ([pscustomobject]@{ supported = $true; zones = $zones }) -Depth 3 -Compress
} catch {
  ConvertTo-Json -InputObject ([pscustomobject]@{ supported = $false; reason = $_.Exception.Message }) -Compress
}
`,
    { optional: true }
  ),
  ps(
    'sys-drivers',
    'Most recently updated third-party drivers',
    'text',
    String.raw`
Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue |
  Where-Object { $_.DeviceName -and $_.DriverProviderName -ne 'Microsoft' } |
  Sort-Object DriverDate -Descending |
  Select-Object -First 30 DeviceName, DriverVersion, @{ n = 'DriverDate'; e = { if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } } }, DriverProviderName |
  Format-Table -AutoSize | Out-String -Width 200
`,
    { optional: true, timeoutMs: 120000 }
  )
]

const SECURITY_CHECK: CommandSpec[] = [
  ps(
    'sec-defender',
    'Microsoft Defender status',
    'json',
    String.raw`
try {
  $s = Get-MpComputerStatus -ErrorAction Stop
  $o = [ordered]@{
    available = $true
    amServiceEnabled = $s.AMServiceEnabled
    antivirusEnabled = $s.AntivirusEnabled
    realTimeProtectionEnabled = $s.RealTimeProtectionEnabled
    antispywareEnabled = $s.AntispywareEnabled
    networkInspectionEnabled = $s.NISEnabled
    tamperProtected = $s.IsTamperProtected
    signatureAgeDays = $s.AntivirusSignatureAge
    signatureVersion = $s.AntivirusSignatureVersion
    lastQuickScan = if ($s.QuickScanEndTime) { $s.QuickScanEndTime.ToString('s') } else { $null }
    lastFullScan = if ($s.FullScanEndTime) { $s.FullScanEndTime.ToString('s') } else { $null }
  }
  ConvertTo-Json -InputObject ([pscustomobject]$o) -Compress
} catch {
  ConvertTo-Json -InputObject ([pscustomobject]@{ available = $false; reason = $_.Exception.Message }) -Compress
}
`
  ),
  ps(
    'sec-av-products',
    'Registered antivirus products (Security Center)',
    'json',
    String.raw`
try {
  $p = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct -ErrorAction Stop | ForEach-Object {
    $state = [int]$_.productState
    [pscustomobject]@{
      name = $_.displayName
      productState = $state
      enabled = (($state -band 0x1000) -ne 0)
      upToDate = (($state -band 0x10) -eq 0)
      timestamp = $_.timestamp
    }
  })
  ConvertTo-Json -InputObject $p -Compress
} catch {
  ConvertTo-Json -InputObject @() -Compress
}
`,
    { optional: true }
  ),
  ps(
    'sec-firewall',
    'Windows Firewall profiles',
    'json',
    String.raw`
$p = @(Get-NetFirewallProfile -ErrorAction SilentlyContinue | Select-Object Name, @{ n = 'Enabled'; e = { [string]$_.Enabled } }, @{ n = 'DefaultInboundAction'; e = { [string]$_.DefaultInboundAction } }, @{ n = 'DefaultOutboundAction'; e = { [string]$_.DefaultOutboundAction } })
ConvertTo-Json -InputObject $p -Compress
`
  ),
  ps(
    'sec-updates',
    'Installed updates (latest 10) and Windows Update state',
    'json',
    String.raw`
$h = @(Get-HotFix -ErrorAction SilentlyContinue | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 10 HotFixID, Description, @{ n = 'InstalledOn'; e = { $_.InstalledOn.ToString('yyyy-MM-dd') } })
$lastSearch = $null; $lastInstall = $null
try {
  $au = (New-Object -ComObject Microsoft.Update.AutoUpdate).Results
  if ($au.LastSearchSuccessDate) { $lastSearch = ([datetime]$au.LastSearchSuccessDate).ToString('s') }
  if ($au.LastInstallationSuccessDate) { $lastInstall = ([datetime]$au.LastInstallationSuccessDate).ToString('s') }
} catch {}
$rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
ConvertTo-Json -InputObject ([pscustomobject]@{ hotfixes = $h; lastSearchSuccess = $lastSearch; lastInstallSuccess = $lastInstall; rebootPending = $rebootPending }) -Depth 3 -Compress
`
  ),
  ps(
    'sec-bitlocker',
    'BitLocker volume status (requires admin)',
    'json',
    String.raw`
try {
  $v = @(Get-BitLockerVolume -ErrorAction Stop | Select-Object MountPoint, @{ n = 'ProtectionStatus'; e = { [string]$_.ProtectionStatus } }, @{ n = 'VolumeStatus'; e = { [string]$_.VolumeStatus } }, EncryptionPercentage, @{ n = 'VolumeType'; e = { [string]$_.VolumeType } })
  ConvertTo-Json -InputObject ([pscustomobject]@{ available = $true; volumes = $v }) -Depth 3 -Compress
} catch {
  ConvertTo-Json -InputObject ([pscustomobject]@{ available = $false; reason = $_.Exception.Message }) -Compress
}
`,
    { optional: true }
  ),
  ps(
    'sec-policies',
    'UAC, SmartScreen, RDP, SMB1, AutoRun and Secure Boot',
    'json',
    REG_HELPER +
      String.raw`
$smb1 = $null
try { $smb1 = [bool](Get-SmbServerConfiguration -ErrorAction Stop).EnableSMB1Protocol } catch {}
$secureBoot = $null
try { $secureBoot = Confirm-SecureBootUEFI -ErrorAction Stop } catch {}
$o = [ordered]@{
  uacEnabled = (Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'EnableLUA') -eq 1
  uacAdminPromptLevel = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'ConsentPromptBehaviorAdmin'
  smartScreenExplorer = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' 'SmartScreenEnabled'
  smartScreenPolicy = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'EnableSmartScreen'
  rdpEnabled = (Get-RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' 'fDenyTSConnections') -eq 0
  smb1Enabled = $smb1
  autorunDisabledForAllDrives = (Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer' 'NoDriveTypeAutoRun') -eq 255
  secureBoot = $secureBoot
}
ConvertTo-Json -InputObject ([pscustomobject]$o) -Compress
`
  ),
  ps(
    'sec-local-admins',
    'Members of the local Administrators group',
    'text',
    String.raw`
try {
  Get-LocalGroupMember -Group 'Administrators' -ErrorAction Stop | Select-Object Name, ObjectClass, PrincipalSource | Format-Table -AutoSize | Out-String -Width 200
} catch {
  'Unable to enumerate local Administrators: ' + $_.Exception.Message
}
`,
    { optional: true }
  )
]

const EMAIL_SETUP: CommandSpec[] = [
  ps(
    'mail-outlook',
    'Outlook / Microsoft 365 installation and profiles',
    'json',
    REG_HELPER +
      String.raw`
$local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$appPath = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\OUTLOOK.EXE' '(default)'
$profiles = @()
foreach ($ver in '16.0', '15.0') {
  $p = "HKCU:\Software\Microsoft\Office\$ver\Outlook\Profiles"
  if (Test-Path $p) { $profiles += @(Get-ChildItem $p | ForEach-Object { $_.PSChildName }) }
}
$ost = @(Get-ChildItem (Join-Path $local 'Microsoft\Outlook') -Filter '*.ost' -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; sizeGB = [math]::Round($_.Length / 1GB, 2); modified = $_.LastWriteTime.ToString('s') }
})
$c2r = 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration'
$o = [ordered]@{
  evaluatedAs = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  classicOutlookInstalled = [bool]$appPath
  classicOutlookPath = $appPath
  outlookRunning = [bool](Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue)
  newOutlookInstalled = [bool](Get-AppxPackage -Name 'Microsoft.OutlookForWindows' -ErrorAction SilentlyContinue)
  profiles = $profiles
  defaultProfile = Get-RegValue 'HKCU:\Software\Microsoft\Office\16.0\Outlook' 'DefaultProfile'
  ostFiles = $ost
  m365Products = Get-RegValue $c2r 'ProductReleaseIds'
  m365Version = Get-RegValue $c2r 'VersionToReport'
  m365Channel = Get-RegValue $c2r 'UpdateChannel'
}
ConvertTo-Json -InputObject ([pscustomobject]$o) -Depth 3 -Compress
`
  ),
  ps(
    'mail-connectivity',
    'TCP reachability of Microsoft 365 mail endpoints',
    'json',
    String.raw`
$targets = @(
  @{ host = 'outlook.office365.com'; port = 443 },
  @{ host = 'smtp.office365.com'; port = 587 },
  @{ host = 'login.microsoftonline.com'; port = 443 },
  @{ host = 'autodiscover-s.outlook.com'; port = 443 }
)
$r = @(foreach ($t in $targets) {
  $ok = $false
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect($t.host, $t.port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(4000)) { $client.EndConnect($iar); $ok = $client.Connected }
    $client.Close()
  } catch { $ok = $false }
  $sw.Stop()
  [pscustomobject]@{ host = $t.host; port = $t.port; reachable = $ok; ms = $sw.ElapsedMilliseconds }
})
ConvertTo-Json -InputObject $r -Compress
`
  ),
  ps(
    'mail-dns',
    'MX, autodiscover and SPF records for the signed-in UPN domain',
    'text',
    String.raw`
$upn = $null
try { $upn = (whoami /upn 2>$null) } catch {}
if ($upn -and $upn.Contains('@')) {
  $domain = $upn.Split('@')[1]
  "UPN: $upn"
  "MX records for $domain :"
  Resolve-DnsName -Name $domain -Type MX -ErrorAction SilentlyContinue | Select-Object NameExchange, Preference | Format-Table -AutoSize | Out-String -Width 200
  'Autodiscover CNAME:'
  Resolve-DnsName -Name "autodiscover.$domain" -Type CNAME -ErrorAction SilentlyContinue | Select-Object Name, NameHost | Format-Table -AutoSize | Out-String -Width 200
  'SPF TXT:'
  Resolve-DnsName -Name $domain -Type TXT -ErrorAction SilentlyContinue | Where-Object { $_.Strings -match 'v=spf1' } | ForEach-Object { $_.Strings -join '' }
} else {
  'No UPN for the evaluating account (local account, or not AD/Entra joined); skipping MX/autodiscover lookup.'
}
`,
    { optional: true }
  )
]

const HARDWARE_ISSUES: CommandSpec[] = [
  PROBLEM_DEVICES,
  ps(
    'hw-disks',
    'Physical disk health, reliability counters and SMART failure prediction',
    'json',
    String.raw`
$disks = @(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  $r = $null
  try { $r = $_ | Get-StorageReliabilityCounter -ErrorAction Stop } catch {}
  [pscustomobject]@{
    name = $_.FriendlyName
    media = [string]$_.MediaType
    bus = [string]$_.BusType
    sizeGB = [math]::Round($_.Size / 1GB, 1)
    health = [string]$_.HealthStatus
    operational = (@($_.OperationalStatus) -join ',')
    temperatureC = if ($r) { $r.Temperature } else { $null }
    wearPct = if ($r) { $r.Wear } else { $null }
    readErrorsTotal = if ($r) { $r.ReadErrorsTotal } else { $null }
    writeErrorsTotal = if ($r) { $r.WriteErrorsTotal } else { $null }
    powerOnHours = if ($r -and $r.PowerOnHours) { [int]$r.PowerOnHours } else { $null }
  }
})
$smart = @()
try {
  $smart = @(Get-CimInstance -Namespace root/wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{ instance = $_.InstanceName; predictFailure = [bool]$_.PredictFailure }
  })
} catch {}
ConvertTo-Json -InputObject ([pscustomobject]@{ disks = $disks; smart = $smart }) -Depth 4 -Compress
`
  ),
  ps(
    'hw-battery',
    'Battery health (laptops)',
    'json',
    String.raw`
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $b) {
  ConvertTo-Json -InputObject ([pscustomobject]@{ present = $false }) -Compress
} else {
  $full = $null; $design = $null; $cycles = $null
  try { $full = (Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity -ErrorAction Stop | Select-Object -First 1).FullChargedCapacity } catch {}
  try { $design = (Get-CimInstance -Namespace root/wmi -ClassName BatteryStaticData -ErrorAction Stop | Select-Object -First 1).DesignedCapacity } catch {}
  try { $cycles = (Get-CimInstance -Namespace root/wmi -ClassName BatteryCycleCount -ErrorAction Stop | Select-Object -First 1).CycleCount } catch {}
  $health = if ($design -and $full) { [math]::Round(100 * $full / $design, 1) } else { $null }
  ConvertTo-Json -InputObject ([pscustomobject]@{ present = $true; name = $b.Name; statusCode = $b.BatteryStatus; chargePct = $b.EstimatedChargeRemaining; designCapacity_mWh = $design; fullChargeCapacity_mWh = $full; healthPct = $health; cycleCount = $cycles }) -Compress
}
`
  ),
  ps(
    'hw-memory',
    'Installed memory modules',
    'text',
    String.raw`
Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue | Select-Object BankLabel, DeviceLocator, @{ n = 'GB'; e = { [math]::Round($_.Capacity / 1GB) } }, Speed, Manufacturer, PartNumber | Format-Table -AutoSize | Out-String -Width 200
`
  ),
  ps(
    'hw-system-errors',
    'Critical and error events in the System log (last 7 days)',
    'text',
    String.raw`
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 40 -ErrorAction SilentlyContinue)
if ($events.Count -eq 0) {
  'No critical/error events in the System log in the last 7 days.'
} else {
  $events | Select-Object @{ n = 'Time'; e = { $_.TimeCreated.ToString('s') } }, Id, ProviderName, @{ n = 'Message'; e = { if ($_.Message) { ($_.Message -split '\r?\n')[0] } } } | Format-Table -AutoSize -Wrap | Out-String -Width 220
}
`,
    { optional: true }
  )
]

const SLOW_PERFORMANCE: CommandSpec[] = [
  ps(
    'perf-resources',
    'CPU, memory and disk pressure (3-second sample)',
    'json',
    String.raw`
$os = Get-CimInstance Win32_OperatingSystem
$cpu = $null; $diskQueue = $null; $diskTime = $null; $committed = $null
try {
  $samples = (Get-Counter -Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 3 -ErrorAction Stop).CounterSamples
  $cpu = [math]::Round(($samples | Measure-Object -Property CookedValue -Average).Average, 1)
} catch {}
try {
  $c = (Get-Counter -Counter '\PhysicalDisk(_Total)\Current Disk Queue Length', '\PhysicalDisk(_Total)\% Disk Time', '\Memory\% Committed Bytes In Use' -ErrorAction Stop).CounterSamples
  $diskQueue = [math]::Round(($c | Where-Object { $_.Path -like '*Queue Length' }).CookedValue, 2)
  $diskTime = [math]::Round(($c | Where-Object { $_.Path -like '*% Disk Time' }).CookedValue, 1)
  $committed = [math]::Round(($c | Where-Object { $_.Path -like '*Committed Bytes*' }).CookedValue, 1)
} catch {}
$o = [ordered]@{
  cpuPct = $cpu
  ramTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  ramUsedPct = [math]::Round(100 * (1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize), 1)
  committedPct = $committed
  diskQueueLength = $diskQueue
  diskTimePct = $diskTime
  processCount = (Get-Process).Count
  uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID; freePct = if ($_.Size) { [math]::Round(100 * $_.FreeSpace / $_.Size, 1) } else { $null } } })
}
ConvertTo-Json -InputObject ([pscustomobject]$o) -Depth 3 -Compress
`
  ),
  ps(
    'perf-top-processes',
    'Top processes by CPU time and by working set',
    'json',
    String.raw`
$cols = @('Name', 'Id', @{ n = 'cpuSeconds'; e = { if ($_.CPU) { [math]::Round($_.CPU, 1) } else { 0 } } }, @{ n = 'workingSetMB'; e = { [math]::Round($_.WorkingSet64 / 1MB) } })
$byCpu = @(Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 -Property $cols)
$byMem = @(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10 -Property $cols)
ConvertTo-Json -InputObject ([pscustomobject]@{ byCpu = $byCpu; byMemory = $byMem }) -Depth 3 -Compress
`
  ),
  ps(
    'perf-startup',
    'Startup programs',
    'json',
    String.raw`
$s = @(Get-CimInstance Win32_StartupCommand -ErrorAction SilentlyContinue | Select-Object Name, Command, Location, User)
ConvertTo-Json -InputObject $s -Compress
`
  ),
  ps(
    'perf-services',
    'Running third-party services',
    'text',
    String.raw`
Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Running' -and $_.PathName -and $_.PathName -notlike '*\Windows\*' } |
  Select-Object Name, DisplayName, StartMode, PathName | Format-Table -AutoSize | Out-String -Width 220
`
  ),
  ps('perf-power', 'Active power plan', 'text', String.raw`powercfg /getactivescheme`, {
    optional: true
  })
]

const PHISHING_ASSESSMENT: CommandSpec[] = [
  ps(
    'phish-extensions',
    'Installed browser extensions (Chrome, Edge, Brave, Firefox)',
    'json',
    String.raw`
$local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$roaming = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE 'AppData\Roaming' }
$browsers = @(
  @{ name = 'Chrome'; root = (Join-Path $local 'Google\Chrome\User Data') },
  @{ name = 'Edge'; root = (Join-Path $local 'Microsoft\Edge\User Data') },
  @{ name = 'Brave'; root = (Join-Path $local 'BraveSoftware\Brave-Browser\User Data') }
)
$items = New-Object System.Collections.Generic.List[object]
foreach ($b in $browsers) {
  if (-not (Test-Path $b.root)) { continue }
  foreach ($profileDir in (Get-ChildItem $b.root -Directory -ErrorAction SilentlyContinue)) {
    $extRoot = Join-Path $profileDir.FullName 'Extensions'
    if (-not (Test-Path $extRoot)) { continue }
    foreach ($extDir in (Get-ChildItem $extRoot -Directory -ErrorAction SilentlyContinue)) {
      $verDir = Get-ChildItem $extDir.FullName -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
      if (-not $verDir) { continue }
      $manifestPath = Join-Path $verDir.FullName 'manifest.json'
      if (-not (Test-Path $manifestPath)) { continue }
      try {
        $m = Get-Content $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
        $name = [string]$m.name
        if ($name -like '__MSG_*') {
          $key = $name -replace '^__MSG_', '' -replace '__$', ''
          $loc = Join-Path $verDir.FullName '_locales\en\messages.json'
          if (-not (Test-Path $loc)) {
            $loc = Get-ChildItem (Join-Path $verDir.FullName '_locales') -Recurse -Filter 'messages.json' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
          }
          if ($loc) { try { $msgs = Get-Content $loc -Raw | ConvertFrom-Json; if ($msgs.$key.message) { $name = $msgs.$key.message } } catch {} }
        }
        $perms = @()
        if ($m.permissions) { $perms += @($m.permissions | ForEach-Object { [string]$_ }) }
        if ($m.host_permissions) { $perms += @($m.host_permissions | ForEach-Object { [string]$_ }) }
        $items.Add([pscustomobject]@{ browser = $b.name; profile = $profileDir.Name; id = $extDir.Name; name = $name; version = [string]$m.version; permissions = $perms })
      } catch {}
    }
  }
}
$ffRoot = Join-Path $roaming 'Mozilla\Firefox\Profiles'
if (Test-Path $ffRoot) {
  foreach ($p in (Get-ChildItem $ffRoot -Directory -ErrorAction SilentlyContinue)) {
    $ext = Join-Path $p.FullName 'extensions.json'
    if (-not (Test-Path $ext)) { continue }
    try {
      $data = Get-Content $ext -Raw -ErrorAction Stop | ConvertFrom-Json
      foreach ($a in $data.addons) {
        if ($a.type -ne 'extension' -or $a.location -eq 'app-builtin' -or $a.location -eq 'app-system-defaults') { continue }
        $perms = @()
        if ($a.userPermissions) { $perms = @($a.userPermissions.permissions) + @($a.userPermissions.origins) }
        $items.Add([pscustomobject]@{ browser = 'Firefox'; profile = $p.Name; id = $a.id; name = $a.defaultLocale.name; version = $a.version; permissions = $perms; active = $a.active })
      }
    } catch {}
  }
}
ConvertTo-Json -InputObject @($items.ToArray()) -Depth 4 -Compress
`
  ),
  ps(
    'phish-settings',
    'SmartScreen, Defender PUA/network protection, Office macro and Outlook content settings',
    'json',
    REG_HELPER +
      String.raw`
$pref = $null
try { $pref = Get-MpPreference -ErrorAction Stop } catch {}
$o = [ordered]@{
  evaluatedAs = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  smartScreenExplorer = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' 'SmartScreenEnabled'
  smartScreenPolicy = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'EnableSmartScreen'
  edgeSmartScreenPolicy = Get-RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' 'SmartScreenEnabled'
  chromeSafeBrowsingPolicy = Get-RegValue 'HKLM:\SOFTWARE\Policies\Google\Chrome' 'SafeBrowsingProtectionLevel'
  defenderPuaProtection = if ($pref) { [int]$pref.PUAProtection } else { $null }
  defenderNetworkProtection = if ($pref) { [int]$pref.EnableNetworkProtection } else { $null }
  defenderCloudBlockLevel = if ($pref) { [int]$pref.CloudBlockLevel } else { $null }
  defenderMapsReporting = if ($pref) { [int]$pref.MAPSReporting } else { $null }
  wordVbaWarnings = Get-RegValue 'HKCU:\Software\Microsoft\Office\16.0\Word\Security' 'VBAWarnings'
  wordBlockMacrosFromInternet = Get-RegValue 'HKCU:\Software\Policies\Microsoft\Office\16.0\Word\Security' 'blockcontentexecutionfrominternet'
  outlookReadAsPlainText = Get-RegValue 'HKCU:\Software\Microsoft\Office\16.0\Outlook\Options\Mail' 'ReadAsPlain'
  outlookBlockExternalContent = Get-RegValue 'HKCU:\Software\Microsoft\Office\16.0\Outlook\Options\Mail' 'BlockExtContent'
}
ConvertTo-Json -InputObject ([pscustomobject]$o) -Compress
`
  ),
  ps(
    'phish-network',
    'Proxy, DNS servers and hosts-file overrides',
    'json',
    REG_HELPER +
      String.raw`
$inet = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$hosts = @()
try { $hosts = @(Get-Content $hostsPath -ErrorAction Stop | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }) } catch {}
$dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses } | ForEach-Object { [pscustomobject]@{ interface = $_.InterfaceAlias; servers = @($_.ServerAddresses) } })
$o = [ordered]@{
  proxyEnabled = (Get-RegValue $inet 'ProxyEnable') -eq 1
  proxyServer = Get-RegValue $inet 'ProxyServer'
  autoConfigUrl = Get-RegValue $inet 'AutoConfigURL'
  dns = $dns
  hostsEntries = $hosts
}
ConvertTo-Json -InputObject ([pscustomobject]$o) -Depth 4 -Compress
`
  ),
  ps(
    'phish-outlook-rules',
    'Client-side Outlook rules (needs an interactive session with Outlook installed)',
    'text',
    String.raw`
try {
  $ol = New-Object -ComObject Outlook.Application -ErrorAction Stop
  $rules = $ol.Session.DefaultStore.GetRules()
  if ($rules.Count -eq 0) {
    'No client-side Outlook rules.'
  } else {
    foreach ($r in $rules) {
      $actions = @()
      if ($r.Actions.Forward.Enabled) { $actions += 'FORWARD to ' + (@($r.Actions.Forward.Recipients | ForEach-Object { $_.Address }) -join ';') }
      if ($r.Actions.Redirect.Enabled) { $actions += 'REDIRECT' }
      if ($r.Actions.Delete.Enabled) { $actions += 'DELETE' }
      if ($r.Actions.MoveToFolder.Enabled) { $actions += 'MOVE to ' + $r.Actions.MoveToFolder.Folder.Name }
      '{0} | enabled={1} | {2}' -f $r.Name, $r.Enabled, ($actions -join ', ')
    }
  }
} catch {
  'Outlook rules unavailable in this session (Outlook COM needs an interactive session on the device; for Microsoft 365 mailboxes run Get-InboxRule from an admin host): ' + $_.Exception.Message
}
`,
    { optional: true }
  ),
  ps(
    'phish-downloads',
    'Executable, script and archive downloads from the last 14 days',
    'text',
    String.raw`
$dl = Join-Path $env:USERPROFILE 'Downloads'
$risky = '^\.(exe|msi|msix|bat|cmd|ps1|js|jse|vbs|vbe|wsf|hta|scr|iso|img|vhd|lnk|docm|xlsm|pptm|zip|7z|rar|one)$'
$files = @(Get-ChildItem $dl -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-14) -and $_.Extension -match $risky })
if ($files.Count -eq 0) {
  'No executable/script/archive downloads modified in the last 14 days.'
} else {
  $files | Sort-Object LastWriteTime -Descending | Select-Object Name, @{ n = 'Modified'; e = { $_.LastWriteTime.ToString('s') } }, @{ n = 'KB'; e = { [math]::Round($_.Length / 1KB) } }, @{ n = 'MarkOfTheWeb'; e = { [bool](Get-Item -Path $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue) } } | Format-Table -AutoSize | Out-String -Width 200
}
`,
    { optional: true }
  )
]

export const WINDOWS_COMMANDS: Record<Exclude<Purpose, 'other'>, CommandSpec[]> = {
  'system-diagnostics': SYSTEM_DIAGNOSTICS,
  'security-check': SECURITY_CHECK,
  'email-setup': EMAIL_SETUP,
  'hardware-issues': HARDWARE_ISSUES,
  'slow-performance': SLOW_PERFORMANCE,
  'phishing-assessment': PHISHING_ASSESSMENT
}
