@echo off
rem ===================================================================
rem  Creates a desktop shortcut for dsh-pair (ASCII only, see start.cmd).
rem  Shortcut name is ASCII too: "DSH Pair".
rem ===================================================================
setlocal EnableExtensions
set "APPDIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $lnk = $ws.CreateShortcut((Join-Path $desktop 'DSH Pair.lnk')); $lnk.TargetPath = Join-Path '%APPDIR%' 'start.cmd'; $lnk.WorkingDirectory = '%APPDIR%'; $lnk.IconLocation = '%SystemRoot%\System32\shell32.dll,167'; $lnk.Description = 'dsh-pair - chat with both DSH instances'; $lnk.WindowStyle = 7; $lnk.Save(); Write-Host ('created: ' + (Join-Path $desktop 'DSH Pair.lnk'))"

if errorlevel 1 (
  echo [dsh-pair] failed to create the shortcut.
  pause
  exit /b 1
)

echo [dsh-pair] done. Double click "DSH Pair" on your desktop.
pause
exit /b 0
