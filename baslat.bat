@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 8n8
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. https://nodejs.org adresinden LTS surumunu kurup tekrar deneyin.
  pause
  exit /b 1
)
if not exist "node_modules\@anthropic-ai\sdk" (
  echo Ilk kurulum yapiliyor ^(npm install^)...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Kurulum basarisiz.
    pause
    exit /b 1
  )
)
node server.js
pause
