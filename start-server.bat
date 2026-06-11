@echo off
title Boblox Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js ne ustanovlen! Skachay s https://nodejs.org i ustanovi.
    pause
    exit /b 1
)

if not exist node_modules (
    echo Pervyi zapusk: ustanavlivayu zavisimosti...
    call npm install
)

echo.
echo ============================================
echo   BOBLOX SERVER:  http://localhost:3000
echo   NE ZAKRYVAI eto okno poka igraesh!
echo ============================================
echo.
node boblox-platform-server.js
pause
