@echo off
cd /d "%~dp0"
title Angel (Discord bot)
rem stop with a message, not a restart loop, when Node or the packages are missing
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed, or this window can't find it.
  echo Install the LTS version from https://nodejs.org, then double-click this file again.
  pause
  exit /b
)
if not exist "node_modules\discord.js\package.json" (
  echo Angel's packages aren't installed in this folder yet.
  echo Open a command window here: click File Explorer's address bar, type cmd, press Enter, then run  npm install
  pause
  exit /b
)
:loop
node src\main.mjs
if %errorlevel%==2 (
  echo Angel can't start yet: see the message above. Missing keys? Run  npm run setup  in this folder.
  pause
  exit /b
)
rem 3 = stopped on purpose (Ctrl+C or the window closing): don't start her again
if %errorlevel%==3 exit /b
echo Angel stopped (exit %errorlevel%). Restarting in 10 seconds... Close this window to quit.
rem ping waits even without a console window, where timeout would fail at once and loop fast
ping -n 11 127.0.0.1 >nul
goto loop
