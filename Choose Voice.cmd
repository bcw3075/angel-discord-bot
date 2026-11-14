@echo off
cd /d "%~dp0"
title Choose Angel's voice
if not exist "node_modules\discord.js\package.json" (
  echo Run Install Angel.cmd first.
  pause
  exit /b
)
echo Saving a sample of every voice (about half a minute)...
call npm run --silent voices
if errorlevel 1 goto fail
start "" "data\voices"
echo.
echo The voices folder is open: double-click each one to hear it.
set "V="
set /p "V=Type the name of the one you want (for example luna), or just press Enter to keep the current one: "
if not defined V goto done
call npm run --silent voices -- --set %V%
if errorlevel 1 goto fail
:done
echo.
echo If Angel is running, close her window and double-click Start Angel.cmd so she uses the new voice.
pause
exit /b
:fail
echo.
echo Something went wrong: see the message above, and tell Angel in the chat.
pause
