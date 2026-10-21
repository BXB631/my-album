@echo off
chcp 65001 >nul
title My Album
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo Electron runtime was not found.
  echo Run: pnpm install
  echo.
  pause
  exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" "%~dp0"
