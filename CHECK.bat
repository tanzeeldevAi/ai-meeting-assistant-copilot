@echo off
cd /d "%~dp0"
title Meeting Copilot - AI check
node tools\check-claude.js
node tools\check-chatgpt.js
node tools\check-cursor.js
echo.
pause
