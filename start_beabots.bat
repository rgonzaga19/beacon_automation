@echo off
setlocal

cd /d "%~dp0"

if not defined PORT set "PORT=5417"
set "BEABOTS_URL=http://127.0.0.1:%PORT%/"
set "BEABOTS_HEALTH=%BEABOTS_URL%api/health"

if exist "%~dp0venv\Scripts\python.exe" (
    set "PYTHON_EXE=%~dp0venv\Scripts\python.exe"
) else (
    set "PYTHON_EXE=python"
)

echo Checking Beabots server on %BEABOTS_URL% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%BEABOTS_HEALTH%' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } } catch { exit 1 }; exit 1" >nul 2>nul
if errorlevel 1 (
    echo Starting Beabots server...
    start "Beabots Server" /min cmd /c ""%PYTHON_EXE%" server.py"
) else (
    echo Beabots server is already running.
)

echo Waiting for Beabots server to be ready...
for /l %%i in (1,1,60) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri '%BEABOTS_HEALTH%' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } } catch { exit 1 }; exit 1" >nul 2>nul
    if not errorlevel 1 (
        echo Server is ready. Opening browser...
        start "" "%BEABOTS_URL%"
        exit /b 0
    )
    timeout /t 1 /nobreak >nul
)

echo Beabots server did not become ready after 60 seconds.
echo Check the "Beabots Server" window for errors.
pause
exit /b 1
