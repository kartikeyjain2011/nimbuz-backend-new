<#
.SYNOPSIS
  Nimbus rig inventory: finds the NVMesh game-library disk (serial NIMBUSGAME), lists every installed
  Steam / Epic / GOG game on it, and reports to the Nimbus API.

.USAGE
  Run once by hand to test:
    powershell -ExecutionPolicy Bypass -File C:\Nimbus\report-inventory.ps1 -Api https://api.playnimbuz.com -Secret <INVENTORY_SECRET> -DryRun

  Install in the golden image (runs at every boot, as SYSTEM):
    powershell -ExecutionPolicy Bypass -File C:\Nimbus\report-inventory.ps1 -Install -Api https://api.playnimbuz.com -Secret <INVENTORY_SECRET>
#>
param(
  [string]$Api = $env:NIMBUS_API_URL,
  [string]$Secret = $env:NIMBUS_INVENTORY_SECRET,
  [string]$Serial = 'NIMBUSGAME',
  [switch]$DryRun,
  [switch]$Install
)

$ErrorActionPreference = 'Stop'

if ($Install) {
  if (-not $Api -or -not $Secret) { throw 'Pass -Api and -Secret with -Install' }
  $target = 'C:\Nimbus\report-inventory.ps1'
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  if ($PSCommandPath -ne $target) { Copy-Item $PSCommandPath $target -Force }
  [Environment]::SetEnvironmentVariable('NIMBUS_API_URL', $Api, 'Machine')
  [Environment]::SetEnvironmentVariable('NIMBUS_INVENTORY_SECRET', $Secret, 'Machine')
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$target`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $trigger.Delay = 'PT1M' # give NVMesh / the games disk a minute to come online
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)
  Register-ScheduledTask -TaskName 'Nimbus Inventory' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  Write-Host 'Installed scheduled task "Nimbus Inventory" (runs at startup).'
  exit 0
}

# ── 1. Locate the game library disk by serial ────────────────────────────────
$disk = Get-Disk | Where-Object { $_.SerialNumber -and $_.SerialNumber.Trim() -eq $Serial } | Select-Object -First 1
if (-not $disk) { throw "No disk with serial $Serial found" }
if ($disk.IsOffline) { Set-Disk -Number $disk.Number -IsOffline $false }
$letters = @(Get-Partition -DiskNumber $disk.Number | Where-Object DriveLetter | ForEach-Object { "$($_.DriveLetter):" })
if (-not $letters) { throw "Disk $Serial has no drive letter" }
Write-Host "Game library: disk $($disk.Number) → $($letters -join ', ')"

function OnLibrary([string]$path) {
  if (-not $path) { return $false }
  foreach ($l in $letters) { if ($path.ToUpper().StartsWith($l.ToUpper())) { return $true } }
  return $false
}

$games = New-Object System.Collections.Generic.List[object]

# ── 2. Steam: every <drive>:\**\steamapps\appmanifest_*.acf ──────────────────
function Read-Acf([string]$file) {
  $h = @{}
  foreach ($line in Get-Content -LiteralPath $file) {
    if ($line -match '^\s*"(\w+)"\s+"(.*)"\s*$') { if (-not $h.ContainsKey($matches[1])) { $h[$matches[1]] = $matches[2] } }
  }
  return $h
}

$steamDirs = New-Object System.Collections.Generic.HashSet[string]
foreach ($l in $letters) {
  foreach ($candidate in @("$l\SteamLibrary\steamapps", "$l\Steam\steamapps", "$l\Program Files (x86)\Steam\steamapps", "$l\steamapps")) {
    if (Test-Path $candidate) { [void]$steamDirs.Add($candidate) }
  }
  # fallback: search two levels deep for other library folders
  Get-ChildItem "$l\" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Join-Path $_.FullName 'steamapps'; if (Test-Path $p) { [void]$steamDirs.Add($p) }
    Get-ChildItem $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $q = Join-Path $_.FullName 'steamapps'; if (Test-Path $q) { [void]$steamDirs.Add($q) }
    }
  }
}
foreach ($dir in $steamDirs) {
  Get-ChildItem -LiteralPath $dir -Filter 'appmanifest_*.acf' -ErrorAction SilentlyContinue | ForEach-Object {
    $m = Read-Acf $_.FullName
    if (-not $m.appid -or -not $m.name) { return }
    $installDir = Join-Path (Join-Path $dir 'common') $m.installdir
    $games.Add([ordered]@{ launcher = 'steam'; id = $m.appid; name = $m.name; installDir = $installDir; sizeBytes = [double]($m.SizeOnDisk) })
  }
}

# ── 3. Epic: ProgramData manifests, keep installs that live on the library disk ─
$epic = Join-Path $env:ProgramData 'Epic\EpicGamesLauncher\Data\Manifests'
if (Test-Path $epic) {
  Get-ChildItem $epic -Filter '*.item' | ForEach-Object {
    try { $j = Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json } catch { return }
    if (-not (OnLibrary $j.InstallLocation)) { return }
    $games.Add([ordered]@{ launcher = 'epic'; id = $j.AppName; name = $j.DisplayName; installDir = $j.InstallLocation; sizeBytes = [double]($j.InstallSize) })
  }
}

# ── 4. GOG: registry entries pointing at the library disk ────────────────────
foreach ($root in @('HKLM:\SOFTWARE\WOW6432Node\GOG.com\Games', 'HKLM:\SOFTWARE\GOG.com\Games')) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root | ForEach-Object {
    $g = Get-ItemProperty $_.PSPath
    if (-not (OnLibrary $g.path)) { return }
    $size = (Get-ChildItem -LiteralPath $g.path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    $games.Add([ordered]@{ launcher = 'gog'; id = "$($g.gameID)"; name = $g.gameName; installDir = $g.path; sizeBytes = [double]$size })
  }
}

# de-dup (same launcher + id)
$unique = $games | Group-Object { "$($_.launcher):$($_.id)" } | ForEach-Object { $_.Group[0] }
Write-Host "Found $(@($unique).Count) games (steam $(@($unique | ? launcher -eq 'steam').Count), epic $(@($unique | ? launcher -eq 'epic').Count), gog $(@($unique | ? launcher -eq 'gog').Count))"

$report = [ordered]@{ vm = $env:COMPUTERNAME; drive = ($letters -join ','); full = $true; games = @($unique) }
$body = $report | ConvertTo-Json -Depth 5 -Compress

if ($DryRun) { $body; exit 0 }
if (-not $Api -or -not $Secret) { throw 'Set -Api/-Secret or NIMBUS_API_URL/NIMBUS_INVENTORY_SECRET' }

# ── 5. Sign (HMAC-SHA256 of the exact bytes) and send ────────────────────────
$bytes = [Text.Encoding]::UTF8.GetBytes($body)
$hmac = New-Object System.Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes($Secret))
$sig = -join ($hmac.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })

$res = Invoke-RestMethod -Method Post -Uri "$($Api.TrimEnd('/'))/v1/infra/inventory" -Body $bytes -ContentType 'application/json' -Headers @{ 'X-Nimbus-Signature' = "sha256=$sig" }
Write-Host "Reported: $($res.received) games · matched $($res.matched) · new $($res.created) · no longer installed $($res.removed)"
