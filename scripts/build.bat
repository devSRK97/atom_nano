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

REM ------------------------------------------------------------
REM  Close the running unpacked app first. electron-builder empties dist\win-unpacked before it
REM  packages, and Windows never lets a running executable be deleted, whatever the account's
REM  rights — so a previous build still running from that folder (AtomNano.exe and children it
REM  spawned from resources\, e.g. codex.exe) fails the build with "Access is denied". Every
REM  process whose executable lives under dist\win-unpacked is closed here; then the script waits
REM  until they are gone. An installed AtomNano elsewhere (Program Files) is left alone.
REM ------------------------------------------------------------
echo.
echo  Closing any AtomNano windows running from dist\win-unpacked...
powershell -NoProfile -Command "$root = '%CD%\dist\win-unpacked\*'; $find = { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like $root }) }; $p = & $find; if ($p.Count -eq 0) { Write-Host '  Nothing to close.'; exit 0 }; Write-Host ('  Closing ' + $p.Count + ' process(es): ' + (($p | ForEach-Object { $_.ProcessName + ' (pid ' + $_.Id + ')' }) -join ', ')); $p | Stop-Process -Force -ErrorAction SilentlyContinue; $t = 0; while ((& $find).Count -gt 0 -and $t -lt 30) { Start-Sleep -Milliseconds 500; $t++ }; if ((& $find).Count -gt 0) { Write-Host '  [ERROR] Some processes would not close.'; exit 1 }; Start-Sleep -Seconds 1; Write-Host '  Closed.'; exit 0"
if errorlevel 1 (
  echo  [ERROR] The unpacked app could not be closed - close it by hand and run this script again.
  pause
  exit /b 1
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
