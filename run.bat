@echo off
title Agent mail
cd /d "%~dp0"
echo Starting the agent-mail receiver on TCP 47832.
echo Discover this PC from the other one, then pin its fingerprint.
echo.
call npx tsx src/cli.ts listen
pause
