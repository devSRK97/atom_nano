@echo off
REM ============================================================
REM  AtomNano - build the macOS app FROM WINDOWS
REM  Runs .github/workflows/build-mac.yml on a free GitHub macOS
REM  runner and downloads the DMG to dist\mac\   (see mac\README.md)
REM  Needs: git, GitHub CLI (winget install GitHub.cli) + gh auth login
REM ============================================================
setlocal
cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-mac.ps1" %*
if errorlevel 1 (
  echo.
  echo  [ERROR] macOS build did not complete. See messages above.
  pause
  exit /b 1
)
pause
