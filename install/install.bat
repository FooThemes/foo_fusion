@echo off
rem Installs or updates Fusion. See install.ps1 for what it does.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
