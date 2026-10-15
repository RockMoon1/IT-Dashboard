<#
.SYNOPSIS
  Read-only structural inspection of the ARH IT Obsidian vault.

.DESCRIPTION
  Walks the vault, never writes inside it, and produces a Markdown report in %TEMP%
  (or -OutFile) describing: folder tree, note sizes, frontmatter keys, heading outlines,
  task/checkbox conventions, due-date styles, tables, existing dashboard markers,
  Obsidian plugins in use, OneDrive conflict copies and cloud-only files, encodings.

  Only small verbatim samples are included (first few task lines, table header rows,
  first dated heading) so the report stays safe to paste into a chat.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Inspect-Vault.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Inspect-Vault.ps1 -VaultPath "D:\Vault\ARH IT" -OutFile "$env:TEMP\report.md"
#>
[CmdletBinding()]
param(
  [string]$VaultPath = "$env:USERPROFILE\OneDrive\Documents\Obsidian Vault\ARH IT",
  [string]$OutFile = "$env:TEMP\arh-vault-report.md",
  [int]$SampleLines = 3
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $VaultPath)) { throw "Vault not found: $VaultPath" }
$vaultFull = (Resolve-Path -LiteralPath $VaultPath).Path
$outFull = [System.IO.Path]::GetFullPath($OutFile)
if ($outFull.StartsWith($vaultFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write the report inside the vault. Choose an -OutFile outside $vaultFull"
}

$lines = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$text = '') { $script:lines.Add($text) }
function Rel([string]$path) { return $path.Substring($vaultFull.Length).TrimStart('\') }

Add-Line "# ARH IT vault inspection"
Add-Line ""
Add-Line "- Vault: ``$vaultFull``"
Add-Line "- Generated: $(Get-Date -Format 's') on $env:COMPUTERNAME by $env:USERNAME"
Add-Line "- Mode: read-only (this script only reads the vault)"
Add-Line ""

# ---------- Obsidian configuration ----------
Add-Line "## Obsidian configuration"
Add-Line ""
# The .obsidian folder lives at the vault root, which can be a parent of the ARH IT folder.
# Walk up until one is found; only its JSON settings are read.
function Find-ObsidianConfig([string]$start) {
  $dir = Get-Item -LiteralPath $start
  while ($dir) {
    $candidate = Join-Path $dir.FullName '.obsidian'
    if (Test-Path -LiteralPath $candidate -PathType Container) { return $candidate }
    $dir = $dir.Parent
  }
  return $null
}
$obs = Find-ObsidianConfig $vaultFull
if ($obs) {
  $vaultRoot = Split-Path -Parent $obs
  if ($vaultRoot -ne $vaultFull) {
    Add-Line "- Obsidian vault root: ``$vaultRoot`` (the inspected folder is inside it)"
  }
  Add-Line "- Settings read from: ``$obs``"
  foreach ($cfg in 'core-plugins.json', 'community-plugins.json') {
    $p = Join-Path $obs $cfg
    if (Test-Path -LiteralPath $p) {
      try {
        $raw = Get-Content -LiteralPath $p -Raw
        $json = $raw | ConvertFrom-Json
        $enabled = @()
        if ($json -is [System.Array]) { $enabled = $json }
        elseif ($json.PSObject.Properties) { $enabled = @($json.PSObject.Properties | Where-Object { $_.Value -eq $true } | ForEach-Object { $_.Name }) }
        Add-Line ("- {0}: {1}" -f $cfg, (($enabled | Sort-Object) -join ', '))
      } catch { Add-Line "- ${cfg}: unreadable ($($_.Exception.Message))" }
    } else { Add-Line "- ${cfg}: not present" }
  }
  $pluginsDir = Join-Path $obs 'plugins'
  if (Test-Path -LiteralPath $pluginsDir) {
    $ids = Get-ChildItem -LiteralPath $pluginsDir -Directory | ForEach-Object { $_.Name }
    Add-Line "- Installed community plugin folders: $($ids -join ', ')"
    foreach ($id in 'obsidian-tasks-plugin', 'dataview', 'templater-obsidian', 'obsidian-kanban') {
      $data = Join-Path $pluginsDir "$id\data.json"
      if (Test-Path -LiteralPath $data) {
        try {
          $d = Get-Content -LiteralPath $data -Raw | ConvertFrom-Json
          $keys = @($d.PSObject.Properties | ForEach-Object { $_.Name }) -join ', '
          Add-Line "  - $id settings keys: $keys"
          if ($id -eq 'obsidian-tasks-plugin' -and $d.globalFilter) { Add-Line "  - Tasks global filter: ``$($d.globalFilter)``" }
        } catch {}
      }
    }
  }
  $daily = Join-Path $obs 'daily-notes.json'
  if (Test-Path -LiteralPath $daily) { Add-Line "- daily-notes.json: $((Get-Content -LiteralPath $daily -Raw) -replace '\s+', ' ')" }
  $templates = Join-Path $obs 'templates.json'
  if (Test-Path -LiteralPath $templates) { Add-Line "- templates.json: $((Get-Content -LiteralPath $templates -Raw) -replace '\s+', ' ')" }
} else {
  Add-Line "- No .obsidian folder found in the folder or any parent folder."
}
Add-Line ""

# ---------- Tree ----------
Add-Line "## Folder tree"
Add-Line ""
Add-Line '```'
function Write-Tree([string]$dir, [string]$indent) {
  $items = Get-ChildItem -LiteralPath $dir -Force | Where-Object { $_.Name -ne '.obsidian' -and $_.Name -ne '.trash' } | Sort-Object { -not $_.PSIsContainer }, Name
  foreach ($item in $items) {
    if ($item.PSIsContainer) {
      Add-Line ("{0}{1}/" -f $indent, $item.Name)
      Write-Tree $item.FullName ($indent + '  ')
    } else {
      $attr = @()
      if ($item.Attributes -band [IO.FileAttributes]::Offline) { $attr += 'cloud-only' }
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $attr += 'reparse' }
      if ($item.Name -match 'conflict') { $attr += 'CONFLICT?' }
      $suffix = if ($attr.Count) { ' [' + ($attr -join ',') + ']' } else { '' }
      Add-Line ("{0}{1}  ({2} bytes, modified {3}){4}" -f $indent, $item.Name, $item.Length, $item.LastWriteTime.ToString('yyyy-MM-dd'), $suffix)
    }
  }
}
Write-Tree $vaultFull ''
Add-Line '```'
Add-Line ""

$allFiles = Get-ChildItem -LiteralPath $vaultFull -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\\.obsidian\\' -and $_.FullName -notmatch '\\\.trash\\' }
$mdFiles = @($allFiles | Where-Object { $_.Extension -eq '.md' })
Add-Line "- Files: $($allFiles.Count) total, $($mdFiles.Count) markdown"
$byExt = $allFiles | Group-Object Extension | Sort-Object Count -Descending | ForEach-Object { "$($_.Name): $($_.Count)" }
Add-Line "- By extension: $($byExt -join ', ')"
$conflicts = @($allFiles | Where-Object { $_.Name -match 'conflict' })
Add-Line "- Possible OneDrive conflict copies: $($conflicts.Count)"
foreach ($c in $conflicts) { Add-Line "  - $(Rel $c.FullName)" }
$cloudOnly = @($allFiles | Where-Object { $_.Attributes -band [IO.FileAttributes]::Offline })
Add-Line "- Cloud-only (not downloaded) files: $($cloudOnly.Count)"
Add-Line ""

# ---------- Conventions across the vault ----------
$taskPatterns = [ordered]@{
  'open task "- [ ]"'        = '^\s*[-*+]\s+\[ \]\s'
  'done task "- [x]"'        = '^\s*[-*+]\s+\[[xX]\]\s'
  'other status "- [/]" etc' = '^\s*[-*+]\s+\[[^ xX\]]\]\s'
  'numbered task "1. [ ]"'   = '^\s*\d+[.)]\s+\[.\]\s'
  'task led by 🔴 🟠 🟡 ⚪ 🧊' = '^\s*[-*+]\s+\[.\]\s+(🔴|🟠|🟡|⚪|🧊)'
}
$datePatterns = [ordered]@{
  'Tasks plugin due 📅 YYYY-MM-DD'      = '📅\s*\d{4}-\d{2}-\d{2}'
  'Tasks plugin scheduled ⏳'           = '⏳\s*\d{4}-\d{2}-\d{2}'
  'Tasks plugin start 🛫'               = '🛫\s*\d{4}-\d{2}-\d{2}'
  'Tasks plugin done ✅'                = '✅\s*\d{4}-\d{2}-\d{2}'
  'Tasks plugin priority ⏫🔼🔽⏬🔺'       = '⏫|🔼|🔽|⏬|🔺'
  'Dataview inline [due:: ...]'         = '\[due::'
  'Dataview inline (due:: ...)'         = '\(due::'
  'plain "due:" or "Due:"'              = '\bdue:\s*\d{4}'
  'ISO date anywhere YYYY-MM-DD'        = '\b\d{4}-\d{2}-\d{2}\b'
  'US date M/D/YYYY'                    = '\b\d{1,2}/\d{1,2}/\d{4}\b'
  '@date style @YYYY-MM-DD'             = '@\d{4}-\d{2}-\d{2}'
}
# Alternation above, not a [class]: 🔼 🔽 🔺 are surrogate pairs in .NET strings, and a class
# matches any emoji sharing a surrogate half (🔴 📅 🚨 ...), which inflated the first report.
$markerPattern = '<!--\s*DASH:[A-Z0-9_-]+:(START|END)\s*-->'

$global:totals = @{}
foreach ($k in $taskPatterns.Keys) { $global:totals[$k] = 0 }
foreach ($k in $datePatterns.Keys) { $global:totals[$k] = 0 }
$totalMarkers = 0
$totalTables = 0
$totalDataview = 0
$totalCallouts = 0
$tagCounts = @{}
$linkCounts = @{}

$noteReports = New-Object System.Collections.Generic.List[string]

foreach ($f in ($mdFiles | Sort-Object FullName)) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  if ($hasBom) { $text = $text.Substring(1) }
  $eol = if ($text.Contains("`r`n")) { 'CRLF' } elseif ($text.Contains("`n")) { 'LF' } else { 'none' }
  $fileLines = $text -split "`r?`n"

  $fm = $null
  if ($fileLines.Count -gt 2 -and $fileLines[0].Trim() -eq '---') {
    $end = -1
    for ($i = 1; $i -lt $fileLines.Count; $i++) { if ($fileLines[$i].Trim() -eq '---') { $end = $i; break } }
    if ($end -gt 1) { $fm = $fileLines[1..($end - 1)] } elseif ($end -eq 1) { $fm = @('(empty frontmatter)') }
  }
  $headings = @($fileLines | Where-Object { $_ -match '^#{1,6}\s' })
  $tasks = @($fileLines | Where-Object { $_ -match '^\s*([-*+]|\d+[.)])\s+\[.\]\s' })
  $tables = @()
  for ($i = 0; $i -lt $fileLines.Count - 1; $i++) {
    if ($fileLines[$i] -match '^\s*\|.*\|\s*$' -and $fileLines[$i + 1] -match '^\s*\|?\s*:?-{3,}') { $tables += $fileLines[$i].Trim() }
  }
  $markers = @($fileLines | Where-Object { $_ -match $markerPattern })
  $dataviewBlocks = ([regex]::Matches($text, '```(dataview|dataviewjs|tasks)')).Count
  $callouts = @($fileLines | Where-Object { $_ -match '^>\s*\[!' } | ForEach-Object { ([regex]::Match($_, '\[!([A-Za-z-]+)')).Groups[1].Value.ToLower() } | Sort-Object -Unique)
  $tags = [regex]::Matches($text, '(?<![\w/])#([A-Za-z][\w/-]*)') | ForEach-Object { $_.Groups[1].Value }
  foreach ($t in $tags) { $tagCounts[$t] = 1 + [int]$tagCounts[$t] }
  $links = [regex]::Matches($text, '\[\[([^\]\|#]+)') | ForEach-Object { $_.Groups[1].Value }
  foreach ($l in $links) { $linkCounts[$l] = 1 + [int]$linkCounts[$l] }
  $datedHeadings = @($headings | Where-Object { $_ -match '\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4}' })

  foreach ($k in $taskPatterns.Keys) { $global:totals[$k] += @($fileLines | Where-Object { $_ -match $taskPatterns[$k] }).Count }
  foreach ($k in $datePatterns.Keys) { $global:totals[$k] += ([regex]::Matches($text, $datePatterns[$k])).Count }
  $totalMarkers += $markers.Count
  $totalTables += $tables.Count
  $totalDataview += $dataviewBlocks
  $totalCallouts += $callouts.Count

  $r = New-Object System.Collections.Generic.List[string]
  $r.Add("### $(Rel $f.FullName)")
  $r.Add("")
  $r.Add("- Size: $($f.Length) bytes, $($fileLines.Count) lines, EOL $eol, BOM $hasBom, modified $($f.LastWriteTime.ToString('s'))")
  if ($fm) { $r.Add("- Frontmatter:"); foreach ($l in $fm) { $r.Add("  - ``$l``") } } else { $r.Add("- Frontmatter: none") }
  $r.Add("- Headings ($($headings.Count)):")
  foreach ($h in ($headings | Select-Object -First 40)) { $r.Add("  - ``$h``") }
  if ($headings.Count -gt 40) { $r.Add("  - … $($headings.Count - 40) more") }
  if ($datedHeadings.Count) { $r.Add("- Dated headings: $($datedHeadings.Count); first ``$($datedHeadings[0])``; last ``$($datedHeadings[-1])``") }
  $r.Add("- Task lines: $($tasks.Count)")
  foreach ($t in ($tasks | Select-Object -First $SampleLines)) { $r.Add("  - sample: ``$($t.Trim())``") }
  $r.Add("- Tables: $($tables.Count)")
  foreach ($t in ($tables | Select-Object -First 6)) { $r.Add("  - header: ``$t``") }
  if ($markers.Count) { $r.Add("- Dashboard markers present:"); foreach ($m in $markers) { $r.Add("  - ``$($m.Trim())``") } } else { $r.Add("- Dashboard markers: none") }
  if ($dataviewBlocks) { $r.Add("- dataview/tasks query blocks: $dataviewBlocks") }
  if ($callouts.Count) { $r.Add("- Callout types: $($callouts -join ', ')") }
  $r.Add("")
  $noteReports.Add(($r -join "`n"))
}

Add-Line "## Conventions found across all notes"
Add-Line ""
Add-Line "| Convention | Occurrences |"
Add-Line "| --- | ---: |"
foreach ($k in $taskPatterns.Keys) { Add-Line ("| {0} | {1} |" -f $k, $global:totals[$k]) }
foreach ($k in $datePatterns.Keys) { Add-Line ("| {0} | {1} |" -f $k, $global:totals[$k]) }
Add-Line ("| tables (header rows) | {0} |" -f $totalTables)
Add-Line ("| dashboard markers | {0} |" -f $totalMarkers)
Add-Line ("| dataview/tasks blocks | {0} |" -f $totalDataview)
Add-Line ("| callouts | {0} |" -f $totalCallouts)
Add-Line ""
Add-Line ("- Top tags: " + (($tagCounts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15 | ForEach-Object { "#$($_.Key) ($($_.Value))" }) -join ', '))
Add-Line ("- Most linked notes: " + (($linkCounts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15 | ForEach-Object { "[[$($_.Key)]] ($($_.Value))" }) -join ', '))
Add-Line ""
Add-Line "## Notes"
Add-Line ""
foreach ($nr in $noteReports) { Add-Line $nr }

[System.IO.File]::WriteAllText($outFull, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Report written to $outFull ($($lines.Count) lines). The vault was not modified."
Write-Host "Paste that file back into the chat, or attach it, to continue with the schema proposal."
