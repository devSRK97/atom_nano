@echo off
REM ============================================================
REM  AtomNano - run (no DevTools)
REM ============================================================
setlocal
cd /d "%~dp0\.."

if not exist "node_modules" call scripts\install.bat

echo  Launching AtomNano...
call npm start
