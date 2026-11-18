@echo off
rem Opens the ROTO holobox (1080x1920) as an Edge app window. Double-click to run.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Open-Holobox.ps1" %*
if errorlevel 1 pause
