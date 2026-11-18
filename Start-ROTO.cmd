@echo off
rem Starts the ROTO server and opens the team console. Double-click to run. Stop with scripts\Stop-ROTO.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-ROTO.ps1" %*
if errorlevel 1 pause
