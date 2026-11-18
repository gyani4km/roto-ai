$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot 'runtime\server.pid'
if (!(Test-Path -LiteralPath $pidPath)) { Write-Host 'No launcher-owned server recorded.'; exit 0 }
$serverId = [int](Get-Content -LiteralPath $pidPath)
$server = Get-CimInstance Win32_Process -Filter "ProcessId = $serverId"
if ($server -and $server.CommandLine -match 'uvicorn backend.main:app' -and $server.ExecutablePath -eq (Join-Path $projectRoot '.venv\Scripts\python.exe')) {
    Stop-Process -Id $serverId
    Write-Host 'Stopped the launcher-owned ROTO server.'
} elseif ($server) { throw 'Recorded PID belongs to a different process; left it untouched.' }
Remove-Item -LiteralPath $pidPath
