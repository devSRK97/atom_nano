@echo off
REM ============================================================
REM  AtomNano - run the portable unpacked build.
REM  (Build it first with scripts\pack-dir.bat)
REM ============================================================
setlocal
cd /d "%~dp0\.."

if not exist "dist\win-unpacked\AtomNano.exe" (
  echo  Unpacked build not found. Building it now...
  call scripts\pack-dir.bat
)

REM Ensure portable mode is on for this folder.
if not exist "dist\win-unpacked\portable.flag" echo portable> "dist\win-unpacked\portable.flag"

echo  Launching portable AtomNano...
start "" "dist\win-unpacked\AtomNano.exe"
