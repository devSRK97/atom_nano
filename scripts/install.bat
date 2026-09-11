@echo off
REM ============================================================
REM  AtomNano - install dependencies
REM ============================================================
setlocal
cd /d "%~dp0\.."

echo.
echo  Installing AtomNano dependencies...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js was not found on PATH. Install Node 18+ from https://nodejs.org
  pause
  exit /b 1
)

call npm install
if errorlevel 1 (
  echo.
  echo  [ERROR] npm install failed.
  pause
  exit /b 1
)

call npm run icon

echo.
echo  Done. Run scripts\dev.bat to launch AtomNano.
echo.
pause
