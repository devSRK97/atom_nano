@echo off
REM ============================================================
REM  AtomNano - run in development (with DevTools)
REM ============================================================
setlocal
cd /d "%~dp0\.."

if not exist "node_modules" (
  echo  Dependencies not installed. Running install first...
  call scripts\install.bat
)

echo  Launching AtomNano (dev)...
call npm run dev
