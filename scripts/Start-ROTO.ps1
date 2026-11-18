param([int]$Port = 8000, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$pythonExe = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $pythonExe)) {
    throw 'Run Setup-ROTO.cmd first to create the local Python environment.'
}
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'frontend\dist\index.html'))) {
    throw 'Build missing. Run Setup-ROTO.cmd first.'
}
$viewerUrl = "http://127.0.0.1:$Port"
$existing = $null
try { $existing = Invoke-RestMethod "$viewerUrl/api/health" -TimeoutSec 2 } catch { }
if ($existing) {
    if ($existing.build -like 's1-core-*') {
        if (!$NoBrowser) { Start-Process $viewerUrl }
        Write-Host "ROTO is already running at $viewerUrl"
        exit 0
    }
    throw "Port $Port is occupied by another service."
}
$runtimeDir = Join-Path $projectRoot 'runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$serverArgs = @('-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', $Port)
$server = Start-Process -FilePath $pythonExe -ArgumentList $serverArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'server-out.log') -RedirectStandardError (Join-Path $runtimeDir 'server-error.log')
$server.Id | Set-Content -LiteralPath (Join-Path $runtimeDir 'server.pid')
$started = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    if ($server.HasExited) { throw 'Server stopped. See runtime\server-error.log.' }
    try {
        $health = Invoke-RestMethod "$viewerUrl/api/health" -TimeoutSec 1
        if ($health.build -like 's1-core-*') { $started = $true; break }
    } catch { }
}
if (!$started) { throw 'Startup timeout. See runtime\server-error.log.' }
if (!$NoBrowser) { Start-Process $viewerUrl }
Write-Host "ROTO ($($health.build)) running at $viewerUrl"
Write-Host 'Use scripts\Stop-ROTO.ps1 to stop this app.'
