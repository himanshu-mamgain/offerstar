# Installs the offerstar binary on Windows (x64).
#   irm https://raw.githubusercontent.com/himanshu-mamgain/offerstar/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$repo = 'himanshu-mamgain/offerstar'
$base = "https://github.com/$repo/releases/latest/download"
$dir = Join-Path $env:LOCALAPPDATA 'Programs\offerstar'

if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
  throw "offerstar: only a Windows x64 build exists; install Node 22.18+ and run: npm i -g offerstar"
}
$asset = 'offerstar-windows-x64.exe'

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("offerstar-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  Write-Host "Downloading $asset..."
  Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')

  $line = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object { $_ -match "\s$([regex]::Escape($asset))$" } | Select-Object -First 1
  $expected = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
  $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw 'offerstar: checksum mismatch, not installing' }

  New-Item -ItemType Directory -Force $dir | Out-Null
  Move-Item -Force (Join-Path $tmp $asset) (Join-Path $dir 'offerstar.exe')
  Write-Host "Installed $dir\offerstar.exe"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $dir)) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$dir"), 'User')
  Write-Host "Added $dir to your PATH. Open a new terminal to use it."
}
Write-Host "Next: offerstar init, then in Claude Code: /plugin install offerstar --marketplace $repo"
