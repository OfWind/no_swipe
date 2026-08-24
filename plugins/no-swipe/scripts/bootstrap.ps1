$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "config\cli-version.json"))) { $Root = Split-Path -Parent $PSScriptRoot }
$Version = (Get-Content (Join-Path $Root "config\cli-version.json") | ConvertFrom-Json).version
$Dest = Join-Path $env:USERPROFILE ".config\no-swipe\bin\$Version"
$Bin = Join-Path $Dest "no-swipe.exe"
New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE ".config\no-swipe") | Out-Null
Copy-Item -Force (Join-Path $Root "config\supabase.json") (Join-Path $env:USERPROFILE ".config\no-swipe\supabase.json")
if (Test-Path $Bin) {
  Write-Output (@{ ok = $true; path = $Bin; skipped = $true } | ConvertTo-Json -Compress)
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
Write-Output (@{ ok = $true; path = $Bin; version = $Version; target = "windows-x64" } | ConvertTo-Json -Compress)
