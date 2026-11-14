@echo off
cd /d "%~dp0"
title Install Angel
if not exist package.json (
  echo This file has to run inside Angel's folder, beside package.json.
  echo If you opened it inside the zip, unzip the whole folder first, then double-click it there.
  pause
  exit /b
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed, or this window can't find it.
  echo Opening nodejs.org: install the LTS version, then double-click this file again.
  start "" https://nodejs.org
  pause
  exit /b
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)"
if errorlevel 1 (
  echo Your Node.js is too old: Angel needs 22.12 or newer.
  echo Opening nodejs.org: install the LTS version, then double-click this file again.
  start "" https://nodejs.org
  pause
  exit /b
)
echo.
echo ===== Step 1 of 4: installing Angel's packages (a minute or two) =====
call npm install
if errorlevel 1 goto fail
echo.
echo ===== Step 2 of 4: your keys =====
echo Paste each key when asked: right-click pastes. The key won't show; you'll see its start, end and length.
call npm run setup
if errorlevel 1 goto fail
echo.
echo ===== Step 3 of 4: invite Angel to your server =====
echo Copy the invite link above (select it with the mouse, right-click; in the newer Terminal Ctrl+click opens it),
echo open it in your browser,
echo pick your server and approve. Then come back here and press any key.
pause
echo Now press Enter at each question to keep your keys: this saves your server.
call npm run setup
if errorlevel 1 goto fail
echo.
echo ===== Step 4 of 4: checking everything =====
call npm run check
if errorlevel 1 goto fail
echo.
echo All done. Tell Angel in the chat what the lines above say.
pause
exit /b
:fail
echo.
echo Something went wrong: see the message above, and tell Angel in the chat.
pause
