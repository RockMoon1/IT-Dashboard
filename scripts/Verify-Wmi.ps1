<#
.SYNOPSIS
  Verifies, on this Windows build, the WMI/CIM classes and event queries the dashboard relies on.
.DESCRIPTION
  Read-only. Prints one line per check with OK/FAIL and exits non-zero if a required item fails.
  Run on the technician PC and on the Windows CI runner.
#>
[CmdletBinding()]
param([switch]$Quick)

$ErrorActionPreference = 'Stop'
$failed = 0
function Check([string]$name, [scriptblock]$body, [bool]$required = $true) {
  try {
    $detail = & $body
    Write-Host ("OK    {0}  {1}" -f $name, ($detail -join ' '))
  } catch {
    $tag = if ($required) { 'FAIL' } else { 'WARN' }
    Write-Host ("{0}  {1}  {2}" -f $tag, $name, $_.Exception.Message)
    if ($required) { $script:failed++ }
  }
}

$os = Get-CimInstance Win32_OperatingSystem
Write-Host ("Windows {0} build {1} ({2})" -f $os.Caption, $os.BuildNumber, $os.OSArchitecture)
Write-Host ("PowerShell {0}" -f $PSVersionTable.PSVersion)

Check 'class root/cimv2 Win32_PnPEntity' { (Get-CimClass -ClassName Win32_PnPEntity).CimClassName }
Check 'class root/cimv2 Win32_DeviceChangeEvent (extrinsic)' { (Get-CimClass -ClassName Win32_DeviceChangeEvent).CimClassName }
Check 'class root/cimv2 Win32_NetworkAdapter' { (Get-CimClass -ClassName Win32_NetworkAdapter).CimClassName }
Check 'class root/StandardCimv2 MSFT_NetAdapter' { (Get-CimClass -Namespace root/StandardCimv2 -ClassName MSFT_NetAdapter).CimClassName }
Check 'class root/cimv2 Win32_UserProfile' { (Get-CimClass -ClassName Win32_UserProfile).CimClassName }
Check 'class root/wmi MSAcpi_ThermalZoneTemperature (optional)' { (Get-CimClass -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature).CimClassName } $false
Check 'class root/SecurityCenter2 AntivirusProduct (client SKUs only)' { (Get-CimClass -Namespace root/SecurityCenter2 -ClassName AntivirusProduct).CimClassName } $false

Check 'cmdlet Get-PnpDevice' { (Get-Command Get-PnpDevice).Name }
Check 'cmdlet Get-NetAdapter' { (Get-Command Get-NetAdapter).Name }
Check 'cmdlet Get-NetIPAddress' { (Get-Command Get-NetIPAddress).Name }
Check 'cmdlet Get-NetNeighbor' { (Get-Command Get-NetNeighbor).Name }
Check 'cmdlet Register-CimIndicationEvent' { (Get-Command Register-CimIndicationEvent).Name }
Check 'cmdlet Get-MpComputerStatus (Defender)' { (Get-Command Get-MpComputerStatus).Name } $false
Check 'cmdlet Get-BitLockerVolume' { (Get-Command Get-BitLockerVolume).Name } $false

Check 'enumerate adapters with PnPDeviceID' {
  $a = @(Get-NetAdapter -ErrorAction Stop | Select-Object Name, InterfaceDescription, Status, PnPDeviceID, Virtual)
  "{0} adapters; USB-backed: {1}" -f $a.Count, @($a | Where-Object { $_.PnPDeviceID -like 'USB\*' }).Count
}

$subs = @(
  @{ id = 'ARHVerifyDev'; ns = 'root/cimv2'; q = "SELECT * FROM Win32_DeviceChangeEvent" },
  @{ id = 'ARHVerifyNetAdd'; ns = 'root/StandardCimv2'; q = "SELECT * FROM __InstanceCreationEvent WITHIN 2 WHERE TargetInstance ISA 'MSFT_NetAdapter'" },
  @{ id = 'ARHVerifyNetDel'; ns = 'root/StandardCimv2'; q = "SELECT * FROM __InstanceDeletionEvent WITHIN 2 WHERE TargetInstance ISA 'MSFT_NetAdapter'" },
  @{ id = 'ARHVerifyNetMod'; ns = 'root/StandardCimv2'; q = "SELECT * FROM __InstanceModificationEvent WITHIN 2 WHERE TargetInstance ISA 'MSFT_NetAdapter' AND TargetInstance.State <> PreviousInstance.State" },
  @{ id = 'ARHVerifyPnpAdd'; ns = 'root/cimv2'; q = "SELECT * FROM __InstanceCreationEvent WITHIN 5 WHERE TargetInstance ISA 'Win32_PnPEntity'" }
)
foreach ($s in $subs) {
  Check ("event subscription " + $s.id + " [" + $s.q + "]") {
    Register-CimIndicationEvent -Namespace $s.ns -Query $s.q -SourceIdentifier $s.id -ErrorAction Stop | Out-Null
    Unregister-Event -SourceIdentifier $s.id -ErrorAction SilentlyContinue
    'registered and unregistered'
  }
}

if (-not $Quick) {
  Check 'Get-PnpDevice -PresentOnly USB enumeration' {
    $d = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.InstanceId -like 'USB\*' })
    "{0} USB PnP entries" -f $d.Count
  }
  Check 'Win32_UserProfile enumeration' {
    $p = @(Get-CimInstance Win32_UserProfile | Where-Object { -not $_.Special })
    "{0} user profiles" -f $p.Count
  }
}

if ($failed -gt 0) { Write-Host "$failed required check(s) FAILED"; exit 1 }
Write-Host 'All required WMI/CIM checks passed.'
