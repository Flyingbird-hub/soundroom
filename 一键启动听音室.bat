@echo off
chcp 65001 >nul
title Soundroom Launcher
cd /d "%~dp0"
node start.js
echo.
echo Launcher exited. Press any key to close this window...
pause >nul
