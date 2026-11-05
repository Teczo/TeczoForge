@echo off
rem Run this once. It puts a "TeczoForge" shortcut on your Desktop
rem that starts start-teczoforge.bat from this folder.
set APP_DIR=%~dp0
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop');" ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'TeczoForge.lnk'));" ^
  "$s.TargetPath='%APP_DIR%start-teczoforge.bat';" ^
  "$s.WorkingDirectory='%APP_DIR%';" ^
  "$s.IconLocation='%SystemRoot%\System32\shell32.dll,137';" ^
  "$s.Save()"
echo Done. Look for "TeczoForge" on your Desktop.
pause
