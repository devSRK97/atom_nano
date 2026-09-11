@echo off
REM ============================================================
REM  AtomNano - build a PORTABLE unpacked app folder (no installer).
REM  Output: dist\win-unpacked\  (run AtomNano.exe inside it)
REM  All data (settings, sessions, API key, Claude login) is kept in
REM  dist\win-unpacked\AtomNano-Data so the folder is fully portable.
REM ============================================================
setlocal
cd /d "%~dp0\.."

if not exist "node_modules" call npm install
call npm run pack
if errorlevel 1 ( echo [ERROR] Pack failed. & pause & exit /b 1 )

REM Mark the unpacked build as portable + create the data folder.
echo portable> "dist\win-unpacked\portable.flag"
if not exist "dist\win-unpacked\AtomNano-Data" mkdir "dist\win-unpacked\AtomNano-Data"

echo.
echo  ============================================================
echo   Portable build ready.
echo     Run:        dist\win-unpacked\AtomNano.exe
echo     Data lives: dist\win-unpacked\AtomNano-Data\
echo.
echo   Copy the entire "win-unpacked" folder to another PC to take
echo   your sessions, settings, API key and Claude login with you.
echo  ============================================================
echo.
pause
