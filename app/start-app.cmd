@echo off
rem ===================================================================
rem  dsh-pair - standalone app window (Edge "app mode")
rem
rem  Opens the UI in its OWN window: no tabs, no address bar, its own
rem  taskbar entry - it looks and behaves like a native app.
rem  Falls back to the default browser if Edge is not installed.
rem
rem  ASCII only on purpose: .cmd files with non-ASCII text can be misread
rem  depending on the console code page.
rem ===================================================================
setlocal EnableExtensions
if "%PORT%"=="" set "PORT=8787"
set "APPDIR=%~dp0"
cd /d "%APPDIR%"

rem --- make sure the backend is up -------------------------------------
call :health
if not errorlevel 1 goto open

echo [dsh-pair] starting server on port %PORT% ...
start "dsh-pair server" /min cmd /c "node server.js --port %PORT%"

set /a tries=0
:waitloop
set /a tries+=1
timeout /t 1 /nobreak >nul
call :health
if not errorlevel 1 goto open
if %tries% lss 25 goto waitloop
echo [dsh-pair] the server did not come up on port %PORT%.
echo [dsh-pair] run start.cmd in a console to see the error:
echo             node "%~dp0server.js" --port %PORT%
pause
exit /b 1

:open
set "EDGE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE goto fallback

start "" "%EDGE%" --app="http://127.0.0.1:%PORT%/" --start-maximized
exit /b 0

:fallback
echo [dsh-pair] Edge not found; opening in the default browser instead.
start "" "http://127.0.0.1:%PORT%/"
exit /b 0

:health
node -e "fetch('http://127.0.0.1:%PORT%/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
exit /b %errorlevel%
