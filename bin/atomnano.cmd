@echo off
rem AtomNano CLI shim (Windows). The running app exports ATOMNANO_NODE (its own runtime, Electron
rem run as Node) so the CLI works even where no node.exe is installed; otherwise node on PATH runs it.
setlocal
if not defined ATOMNANO_NODE goto plain
if not exist "%ATOMNANO_NODE%" goto plain
set ELECTRON_RUN_AS_NODE=1
"%ATOMNANO_NODE%" "%~dp0atomnano.js" %*
exit /b %ERRORLEVEL%
:plain
node "%~dp0atomnano.js" %*
exit /b %ERRORLEVEL%
