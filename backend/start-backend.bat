@echo off
rem Double-click this file to start the TeczoForge backend.
rem It works from any folder, and does not need PowerShell script permission.

rem Go to the folder this file is in (backend\).
cd /d "%~dp0"

rem First time only: install the packages.
if not exist node_modules (
  echo Installing packages, first time only...
  call npm install
)

echo Starting backend at http://127.0.0.1:4000
echo Health check: http://127.0.0.1:4000/api/health
echo Press Ctrl+C to stop.
call npm run dev

pause
