@echo off
rem Installs or updates Fusion. See install.ps1 for what it does.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
rem The script waits for Enter itself; pause here only if it stopped early.
if errorlevel 1 (
  echo.
  pause
)
