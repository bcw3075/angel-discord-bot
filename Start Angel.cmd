@echo off
cd /d "%~dp0"
title Angel (Discord bot)
:loop
node src\main.mjs
if %errorlevel%==2 (
  echo Angel needs setting up first: run  npm run setup  in this folder.
  pause
  exit /b
)
echo Angel stopped (exit %errorlevel%). Restarting in 10 seconds... Press Ctrl+C to quit.
timeout /t 10 >nul
goto loop
