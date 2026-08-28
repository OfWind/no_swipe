$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "config\cli-version.json"))) { $Root = Split-Path -Parent $PSScriptRoot }
$Version = (Get-Content (Join-Path $Root "config\cli-version.json") | ConvertFrom-Json).version
$HomeRoot = if ($env:NO_SWIPE_HOME) { $env:NO_SWIPE_HOME } else { $env:USERPROFILE }
$Dest = Join-Path $HomeRoot ".config\no-swipe\bin\$Version"
$Bin = Join-Path $Dest "no-swipe.exe"

function Prune-OldPackages {
  $prunedBins = [System.Collections.Generic.List[string]]::new()
  $prunedPlugins = [System.Collections.Generic.List[string]]::new()
  $binRoot = Join-Path $HomeRoot ".config\no-swipe\bin"
  if (Test-Path $binRoot) {
    Get-ChildItem -Directory $binRoot | ForEach-Object {
      if ($_.Name -ne $Version -and $_.Name -match '^\d+\.\d+\.\d+$') {
        Remove-Item -Recurse -Force $_.FullName
        $prunedBins.Add($_.Name) | Out-Null
      }
    }
  }
  $parent = Split-Path -Parent $Root
  $grandparent = Split-Path -Parent $parent
  if ((Split-Path -Leaf $parent) -eq "no-swipe" -and (Split-Path -Leaf $grandparent) -eq "no-swipe-marketplace") {
    Get-ChildItem -Directory $parent | ForEach-Object {
      if ($_.FullName -ne $Root -and $_.Name -match '^\d+\.\d+\.\d+\+codex\.') {
        Remove-Item -Recurse -Force $_.FullName
        $prunedPlugins.Add($_.Name) | Out-Null
      }
    }
  }
  @{
    pruned_bins = @($prunedBins)
    pruned_plugins = @($prunedPlugins)
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $HomeRoot ".config\no-swipe") | Out-Null
Copy-Item -Force (Join-Path $Root "config\supabase.json") (Join-Path $HomeRoot ".config\no-swipe\supabase.json")

function Write-BootstrapResult([hashtable]$extra) {
  $pruned = Prune-OldPackages
  $payload = @{
    ok = $true
    path = $Bin
    pruned_bins = $pruned.pruned_bins
    pruned_plugins = $pruned.pruned_plugins
  }
  foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] }
  Write-Output ($payload | ConvertTo-Json -Compress)
}

if (Test-Path $Bin) {
  Write-BootstrapResult @{ skipped = $true }
  exit 0
}
$Config = Get-Content (Join-Path $Root "config\supabase.json") | ConvertFrom-Json
$Artifact = "no-swipe-windows-x64.exe.gz"
$Url = "$($Config.releases_base_url)/$Version/$Artifact"
$ManifestUrl = "$($Config.releases_base_url)/$Version/manifest.json"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$Tmp = Join-Path $env:TEMP "no-swipe-$Version.exe.gz"
Invoke-WebRequest -Uri $Url -OutFile $Tmp
$Manifest = Invoke-RestMethod -Uri $ManifestUrl
$Expected = [string]$Manifest.$Artifact
$Actual = (Get-FileHash -Algorithm SHA256 $Tmp).Hash.ToLowerInvariant()
if (-not $Expected -or $Expected.ToLowerInvariant() -ne $Actual) {
  Remove-Item -Force $Tmp
  throw "sha256 mismatch"
}
$InputStream = [System.IO.File]::OpenRead($Tmp)
$Gzip = New-Object System.IO.Compression.GzipStream($InputStream, [System.IO.Compression.CompressionMode]::Decompress)
$OutputStream = [System.IO.File]::Create($Bin)
$Gzip.CopyTo($OutputStream)
$OutputStream.Close()
$Gzip.Close()
$InputStream.Close()
Remove-Item -Force $Tmp
Write-BootstrapResult @{ version = $Version; target = "windows-x64" }
