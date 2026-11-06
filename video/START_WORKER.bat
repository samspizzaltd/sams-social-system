@echo off
REM Sam's Social - video worker. Keep this window open while the system is ON:
REM it prepares the autopilot edits (frames, sounds, branded cut) and renders.
cd /d "%~dp0"
title Sam's Social - video worker
node render-worker.mjs --watch
echo.
echo The video worker stopped. Press any key to close this window.
pause >nul
