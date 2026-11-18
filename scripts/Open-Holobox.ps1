<#
Opens the holobox output as an Edge app window (no tabs, no address bar), 1080 x 1920, with its own browser profile.
The picture is a true 1080x1920; on a smaller screen (for example 1920x1080) the page scales it to fit the window height.
Press F11 in the window for full screen. Starts the server first if it is not running.
Profile folder: -ProfileDir, or the ROTO_EDGE_PROFILE environment variable, or %LOCALAPPDATA%\ROTO\edge-holobox-app.
Usage: powershell -NoProfile -File scripts\Open-Holobox.ps1 [-Port 8000] [-Width 1080] [-Height 1920] [-ProfileDir <folder>]
#>
param([int]$Port = 8000, [int]$Width = 1080, [int]$Height = 1920, [string]$ProfileDir = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/holobox"
function Test-Server { try { (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).StatusCode -eq 200 } catch { $false } }
if (-not (Test-Server)) {
  Write-Host "Starting ROTO on port $Port ..."
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Start-ROTO.ps1') -Port $Port -NoBrowser | Out-Null
  for ($i = 0; $i -lt 40 -and -not (Test-Server); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Server)) { throw "ROTO did not start on port $Port. See runtime\ for logs." }
}
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge was not found.' }
if (-not $ProfileDir) { $ProfileDir = $env:ROTO_EDGE_PROFILE }
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:LOCALAPPDATA 'ROTO\edge-holobox-app' }
$profileDir = $ProfileDir
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
Start-Process -FilePath $edge -ArgumentList @("--app=$url", "--window-size=$Width,$Height", "--user-data-dir=`"$profileDir`"", '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--disable-features=Translate')
