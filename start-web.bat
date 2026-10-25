@echo off
chcp 65001 >nul
title My Album - web mode
cd /d "%~dp0"

rem Web mode: the album runs as a local Node.js server and you use it in your
rem browser. No desktop shell is involved, so it also works on machines where
rem Chromium cannot start (see the handover notes).
rem ASCII-only on purpose: cmd.exe mis-parses UTF-8 batch files on consoles whose
rem initial code page is not UTF-8.

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if defined MY_ALBUM_NODE set "NODE_EXE=%MY_ALBUM_NODE%"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto no_node

if not exist "node_modules\express\package.json" goto no_deps

if not defined PORT set "PORT=3000"

rem The server opens the browser itself once it is listening.
set "MY_ALBUM_OPEN_BROWSER=1"

echo Starting the local album server on http://localhost:%PORT%
echo.
echo   - A second console window named "My Album Server" keeps the server running.
echo   - Close that window to stop the album.
echo   - The browser opens by itself; if not, open the address manually.
echo.

start "My Album Server" cmd /k ""%NODE_EXE%" server.js"
timeout /t 3 /nobreak >nul

echo If the page does not load, the port may be in use: close other album windows
echo or set another port first, for example:  set PORT=3100
echo.
pause
exit /b 0

:no_deps
echo Dependencies are missing.
echo Run this once in this folder, then start again:
echo   pnpm install --node-linker=hoisted
echo.
pause
exit /b 1

:no_node
echo node was not found. Install Node.js 20.8 or newer,
echo or set MY_ALBUM_NODE to the full path of node.exe.
echo.
pause
exit /b 1