@echo off
rem Starts TeczoForge: ComfyUI, backend and frontend, each in its own window.
rem Double-click this file. To stop everything, close the three windows.
set COMFY_DIR=C:\AI\ComfyUI_windows_portable
set APP_DIR=%~dp0

curl.exe -s -o nul http://127.0.0.1:8188/system_stats
if errorlevel 1 (
  echo Starting ComfyUI...
  start "ComfyUI" /D "%COMFY_DIR%" run_nvidia_gpu.bat
) else (
  echo ComfyUI is already running.
)

echo Waiting for ComfyUI on http://127.0.0.1:8188 ...
echo If this takes more than a few minutes, check the ComfyUI window for errors.
:wait
curl.exe -s -o nul http://127.0.0.1:8188/system_stats
if errorlevel 1 (
  timeout /t 2 /nobreak >nul
  goto wait
)

echo Starting backend...
start "TeczoForge backend" /D "%APP_DIR%backend" cmd /k npm run dev

echo Starting frontend...
start "TeczoForge frontend" /D "%APP_DIR%frontend" cmd /k npm run dev

timeout /t 5 /nobreak >nul
start "" http://localhost:5173
