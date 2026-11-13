@echo off
cd /d "%~dp0"
title Angel (Discord bot)
:loop
node src\main.mjs
if %errorlevel%==2 (
  echo Angel needs setting up first: see the message above, or run  npm run setup  in this folder.
  pause
  exit /b
)
echo Angel stopped (exit %errorlevel%). Restarting in 10 seconds... Press Ctrl+C to quit.
rem ping waits even without a console window, where timeout would fail at once and loop fast
ping -n 11 127.0.0.1 >nul
goto loop
