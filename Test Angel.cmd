@echo off
cd /d "%~dp0"
title Test Angel
if not exist "node_modules\discord.js\package.json" (
  echo Run Install Angel.cmd first.
  pause
  exit /b
)
echo Asking Angel about thirty-five test questions with your own keys (two or three minutes, about a dollar).
echo No Discord and no talking needed. Angel can be running or not.
node src\check.mjs --selftest
if errorlevel 1 (
  echo.
  echo Finished, with at least one test FAILED: that is what the test is for.
) else (
  echo.
  echo Finished.
)
echo Tell Angel in the chat: she reads the result from the data\selftest folder.
pause
