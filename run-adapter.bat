@echo off
title Agent mailbox adapter
cd /d "%~dp0"
echo Starting the local adapter for this PC.
echo Cursor should use http://127.0.0.1:8788/mcp
echo.
call npx tsx src/adapter-main.ts
pause
