@echo off
rem Starts TeczoForge: ComfyUI, backend and frontend, each in its own window.
rem Double-click this file. To stop everything, close the three windows.
rem ComfyUI starts minimised on the taskbar. Click it there to see its log.
setlocal
set "APP_DIR=%~dp0"
set "COMFY_DIR=%APP_DIR%comfyui\ComfyUI_windows_portable"

rem The folder with all model files: MODELS_DIR in backend\.env.
rem Empty means the models folder in this repo.
set "MODELS_DIR="
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%APP_DIR%backend\.env") do (
  if /i "%%a"=="MODELS_DIR" set "MODELS_DIR=%%b"
)
if not defined MODELS_DIR set "MODELS_DIR=%APP_DIR%models"
rem Remove a backslash at the end, if there is one.
if "%MODELS_DIR:~-1%"=="\" set "MODELS_DIR=%MODELS_DIR:~0,-1%"

if not exist "%MODELS_DIR%\" (
  echo.
  echo The models folder was not found:
  echo   %MODELS_DIR%
  echo.
  echo If the models are on an external drive, plug it in and try again.
  echo Otherwise check MODELS_DIR in backend\.env.
  echo ComfyUI was NOT started.
  echo.
  pause
  exit /b 1
)

curl.exe -s -o nul http://127.0.0.1:8188/system_stats
if not errorlevel 1 (
  echo ComfyUI is already running.
  goto waitcomfy
)

if not exist "%COMFY_DIR%\python_embeded\python.exe" (
  echo.
  echo ComfyUI was not found in:
  echo   %COMFY_DIR%
  echo See docs\comfyui-setup.md.
  echo.
  pause
  exit /b 1
)

rem Tell ComfyUI where the models are. Written fresh each start, so moving the
rem models folder only needs a change to MODELS_DIR.
set "YAML=%COMFY_DIR%\ComfyUI\extra_model_paths.yaml"
> "%YAML%" echo # Made by start-teczoforge.bat. Do not edit by hand.
>> "%YAML%" echo # The models folder comes from MODELS_DIR in backend\.env.
>> "%YAML%" echo teczoforge:
>> "%YAML%" echo     base_path: '%MODELS_DIR%'
>> "%YAML%" echo     is_default: true
for %%f in (checkpoints configs loras vae text_encoders diffusion_models clip_vision style_models embeddings diffusers vae_approx controlnet gligen upscale_models latent_upscale_models hypernetworks photomaker classifiers model_patches audio_encoders background_removal frame_interpolation geometry_estimation optical_flow detection) do (
  >> "%YAML%" echo     %%f: %%f
)

echo Starting ComfyUI (minimised)...
echo Models folder: %MODELS_DIR%
rem conhost.exe opens a classic console window. Windows Terminal would ignore /MIN.
rem cmd /k keeps the window open if ComfyUI stops, so the error can be read.
rem Same flags as run_nvidia_gpu.bat, plus --disable-auto-launch (no extra browser tab).
start "ComfyUI" /MIN /D "%COMFY_DIR%" conhost.exe cmd /k "title ComfyUI && python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --disable-auto-launch"

:waitcomfy
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
start "" http://localhost:5180
