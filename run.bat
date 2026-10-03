@echo off
title Agent mailbox
cd /d "%~dp0"
echo Starting the shared mailbox.
echo The other PC connects with its adapter. This window is the host.
echo.
call npx tsx src/index.ts
pause
