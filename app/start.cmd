@echo off
rem ===================================================================
rem  dsh-pair launcher - double click this file to open the chat window.
rem  ASCII only on purpose: .cmd/.ps1 files with non-ASCII text can be
rem  misread depending on the console code page.
rem
rem  Stop it with stop.cmd (kills only the PID in server.pid).
rem  NEVER taskkill /IM node.exe - that kills every node on the machine,
rem  including the other agent's test servers. (We learned that the hard way.)
rem ===================================================================
setlocal EnableExtensions
if "%PORT%"=="" set "PORT=8787"
set "APPDIR=%~dp0"
cd /d "%APPDIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo [dsh-pair] Node.js was not found in PATH.
  echo [dsh-pair] Install Node 18 or newer, then run this file again.
  pause
  exit /b 1
)

rem If our server is already up, just open the window.
call :health
if not errorlevel 1 goto open

echo [dsh-pair] starting server on port %PORT% ...
rem Prefer the watchdog (bin\watchdog.js): it starts the server AND restarts it if it dies.
rem Falls back to starting the server directly if the watchdog is missing.
if exist "%APPDIR%bin\watchdog.js" (
  start "dsh-pair watchdog" /min cmd /c node "%APPDIR%bin\watchdog.js" --port %PORT%
) else (
  start "dsh-pair server" /min cmd /c node "%APPDIR%server.js" --port %PORT%
)

set /a TRIES=0
:wait
call :health
if not errorlevel 1 goto open
set /a TRIES+=1
if %TRIES% GEQ 30 goto failed
ping -n 2 127.0.0.1 >nul
goto wait

:open
start "" "http://127.0.0.1:%PORT%/"
exit /b 0

:failed
echo.
echo [dsh-pair] the server did not come up on port %PORT% within 30 seconds.
echo [dsh-pair] log file: %APPDIR%logs\server-%PORT%.log
echo [dsh-pair] last lines of that log:
powershell -NoProfile -Command "if (Test-Path '%APPDIR%logs\server-%PORT%.log') { Get-Content '%APPDIR%logs\server-%PORT%.log' -Tail 15 } else { Write-Host '(no log written yet - the server probably never started)' }"
echo.
echo [dsh-pair] run it in a console to see the error:
echo             node "%APPDIR%server.js" --port %PORT%
echo.
pause
exit /b 1

rem Readiness probe. Uses node itself (we already verified node exists)
rem instead of curl, so the launcher has no extra dependency.
:health
node -e "fetch('http://127.0.0.1:%PORT%/api/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})" >nul 2>nul
exit /b %errorlevel%
