@echo off
rem ===================================================================
rem  Stops dsh-pair servers started from THIS folder - and only those.
rem
rem  The logic lives in bin\stop.js on purpose:
rem    - this .cmd must stay ASCII only (Chinese text in a .cmd gets read
rem      wrong under a CJK code page and cmd tries to run the garbage);
rem    - nesting PowerShell inside cmd breaks on quote/paren escaping, and
rem      a broken parse once degraded the path check to an empty needle,
rem      which killed every node process on the machine.
rem  (That mistake cost the other agent a running server - see README.)
rem
rem  NEVER taskkill /IM node.exe.
rem ===================================================================
setlocal EnableExtensions
set "APPDIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [dsh-pair] Node.js was not found in PATH, cannot stop safely.
  echo [dsh-pair] Close the "dsh-pair server" window manually instead.
  pause
  exit /b 1
)

node "%APPDIR%bin\stop.js"
if errorlevel 1 (
  echo [dsh-pair] stop failed, see the message above.
  pause
  exit /b 1
)
exit /b 0
