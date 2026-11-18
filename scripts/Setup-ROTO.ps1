<#
One-time setup for a fresh Windows PC (also safe to re-run any time):
  1. checks Python 3.11+ and Node 20+
  2. creates the Python environment (.venv) and installs the pinned requirements
  3. creates .env from .env.example if it is missing
  4. checks the character file (assets\character.glb) against the pin in config\avatar-lock.json
  5. npm ci + builds the frontend
Optional: set ROTO_CACHE_DIR to keep pip's cache and temp files on another drive (for example F:\roto-cache).
#>
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Fail($message) { Write-Host ''; Write-Host "SETUP STOPPED: $message" -ForegroundColor Red; exit 1 }

# --- 1. Python 3.11+ and Node 20+ ------------------------------------------------------------------------------
function Find-Python {
    foreach ($candidate in @(@('py', '-3'), @('python'), @('python3'))) {
        try {
            $exe = $candidate[0]; $extra = @($candidate | Select-Object -Skip 1)
            $out = & $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
            if ($LASTEXITCODE -eq 0 -and $out) {
                $v = [version]($out | Select-Object -First 1)
                if ($v -ge [version]'3.11') { return ,(@($exe) + $extra) }
            }
        } catch { }
    }
    return $null
}
$python = Find-Python
if (-not $python) {
    Fail ("Python 3.11 or newer was not found.`n  Install it from https://www.python.org/downloads/windows/ and tick 'Add python.exe to PATH',`n  then double-click Setup-ROTO.cmd again.")
}
$nodeVersion = $null
try { $nodeVersion = (& node -v 2>$null) } catch { }
if (-not $nodeVersion -or [int](($nodeVersion -replace '^v', '').Split('.')[0]) -lt 20) {
    Fail ("Node.js 20 or newer was not found (found: '$nodeVersion').`n  Install the LTS version from https://nodejs.org/ then double-click Setup-ROTO.cmd again.")
}
Write-Host "Found Python ($($python -join ' ')) and Node $nodeVersion."

if ($env:ROTO_CACHE_DIR) {
    $env:PIP_CACHE_DIR = Join-Path $env:ROTO_CACHE_DIR 'pip'
    $env:TEMP = Join-Path $env:ROTO_CACHE_DIR 'tmp'; $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Force -Path $env:PIP_CACHE_DIR, $env:TEMP | Out-Null
}

# --- 2. Python environment --------------------------------------------------------------------------------------
$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host 'Creating the Python environment (.venv) ...'
    $extra = @($python | Select-Object -Skip 1)
    & $python[0] @extra -m venv .venv
    if ($LASTEXITCODE) { Fail 'Could not create the Python environment (.venv).' }
}
Write-Host 'Installing Python packages (pinned) ...'
& $venvPython -m pip install --disable-pip-version-check -r requirements.lock.txt
if ($LASTEXITCODE) {
    Write-Host 'The pinned set did not install on this Python version; trying requirements.txt ...' -ForegroundColor Yellow
    & $venvPython -m pip install --disable-pip-version-check -r requirements.txt
    if ($LASTEXITCODE) { Fail 'Python package install failed. Check your internet connection and run Setup again.' }
}

# --- 3. .env ----------------------------------------------------------------------------------------------------
$keysNote = $false
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    $keysNote = $true
    Write-Host 'Created .env from .env.example.'
}

# --- 4. Character file ------------------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path 'assets' | Out-Null
& $venvPython scripts\prepare_avatar.py
$avatarCode = $LASTEXITCODE
if ($avatarCode -eq 3) {
    Write-Host 'Pinning the character file you provided (updates config\avatar-lock.json on this PC) ...' -ForegroundColor Yellow
    & $venvPython scripts\prepare_avatar.py --pin assets\character.glb --reason 'Pinned from assets/character.glb during Setup'
    $avatarCode = $LASTEXITCODE
}
$characterMissing = ($avatarCode -ne 0)

# --- 5. Frontend ------------------------------------------------------------------------------------------------
Push-Location -LiteralPath 'frontend'
try {
    npm.cmd ci
    if ($LASTEXITCODE) { Fail 'npm ci failed. Check your internet connection and run Setup again.' }
    npm.cmd run build
    if ($LASTEXITCODE) { Fail 'The frontend build failed.' }
} finally { Pop-Location }

Write-Host ''
Write-Host '=== Setup complete ===' -ForegroundColor Green
if ($keysNote) { Write-Host 'NEXT: open .env in Notepad and paste the API keys (Groq, Google Cloud TTS, Sarvam). See README.md, step 3.' }
if ($characterMissing) {
    Write-Host ''
    Write-Host 'NEXT: the character file is still missing.' -ForegroundColor Yellow
    Write-Host '  Put the character file you received privately at:  assets\character.glb'
    Write-Host '  Then double-click Setup-ROTO.cmd once more (it takes a few seconds).'
}
Write-Host 'Then double-click Start-ROTO.cmd.'
