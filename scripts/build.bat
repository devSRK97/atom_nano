@echo off
REM ============================================================
REM  AtomNano - build Windows installer (.exe via NSIS)
REM  Output: dist\AtomNano-Setup-<version>.exe
REM ============================================================
setlocal
cd /d "%~dp0\.."

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js not found on PATH.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo  Installing dependencies...
  call npm install
  if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
)

echo.
echo  Generating icon...
call npm run icon

echo.
echo  Building Windows installer (this can take a few minutes)...
call npm run dist
if errorlevel 1 (
  echo.
  echo  [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo   Build complete. Installer is in the  dist\  folder:
echo.
dir /b "dist\*.exe"
echo  ============================================================
echo.
pause
