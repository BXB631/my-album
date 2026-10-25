@echo off
chcp 65001 >nul
title My Album - self test
cd /d "%~dp0"

rem Self test: syntax check, geometry unit tests, server streaming smoke test,
rem the sidebar folder-tree test, the live photo merge test (uses testmedia\),
rem the cache-clearing test and the browser end-to-end test (jsdom).
rem Use this if "pnpm test" cannot find node on PATH: this file looks for node
rem the same way start-web.bat does.
rem ASCII-only on purpose: cmd.exe mis-parses UTF-8 batch files on consoles whose
rem initial code page is not UTF-8. Keep CRLF line endings.

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if defined MY_ALBUM_NODE set "NODE_EXE=%MY_ALBUM_NODE%"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto no_node

echo node: %NODE_EXE%
echo.
echo This writes temporary photos into test-runtime\ only; your real library is untouched.
echo It takes a few minutes.
echo.

echo [1/8] syntax check
"%NODE_EXE%" tools\check-syntax.js
if errorlevel 1 goto failed
echo.
echo [2/8] geometry unit tests
"%NODE_EXE%" tools\test-stream-geometry.js
if errorlevel 1 goto failed
echo.
echo [3/8] server streaming (cold scan / index / cancel)
"%NODE_EXE%" tools\test-stream.js
if errorlevel 1 goto failed
echo.
echo [4/8] live photo merge (real files from testmedia\)
"%NODE_EXE%" tools\test-live-photo.js
if errorlevel 1 goto failed
echo.
echo [5/8] cache clearing (thumbnails / opened media / all)
"%NODE_EXE%" tools\test-cache.js
if errorlevel 1 goto failed
echo.
echo [6/8] HEIC color (ICC from the container -> JPEG -> sharp converts to sRGB)
"%NODE_EXE%" tools\test-heic-color.js
if errorlevel 1 goto failed
echo.
echo [7/8] installed layout (cache / index / settings live in the install dir)
"%NODE_EXE%" tools\test-install-paths.js
if errorlevel 1 goto failed
echo.
echo [8/8] sidebar folder tree + browser end-to-end
echo       (the browser test skips itself if jsdom is not installed)
"%NODE_EXE%" tools\test-folder-nav.js
if errorlevel 1 goto failed
"%NODE_EXE%" tools\test-stream-dom.js
if errorlevel 1 goto failed

echo.
echo All checks passed.
echo.
pause
exit /b 0

:failed
echo.
echo A check failed: read the messages above.
echo.
pause
exit /b 1

:no_node
echo node was not found. Install Node.js 20.8 or newer,
echo or set MY_ALBUM_NODE to the full path of node.exe.
echo.
pause
exit /b 1
