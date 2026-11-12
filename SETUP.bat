@echo off
setlocal
cd /d "%~dp0"
title Meeting Copilot - Setup
echo.
echo ============================================
echo   Meeting Copilot - one-time setup
echo ============================================
echo.

echo [1/5] Checking Node.js and Python...
where node >nul 2>&1 || goto :nonode
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 goto :nonode

rem Prefer 3.12 or 3.11, which every package here has wheels for, then any 3.x.
set "PY="
for %%v in (3.12 3.11 3.13 3) do (
  if not defined PY (
    py -%%v -c "import sys" >nul 2>&1 && set "PY=py -%%v"
  )
)
if not defined PY (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1 && set "PY=python"
)
if not defined PY goto :nopython
echo     Node %NODE_MAJOR%, Python via %PY%
echo.

echo [2/5] Installing Node packages...
call npm install --no-fund --no-audit
if errorlevel 1 goto :fail
echo.

echo [3/5] Installing Python audio packages into .venv ...
if not exist ".venv\Scripts\python.exe" %PY% -m venv .venv
if errorlevel 1 goto :fail
".venv\Scripts\python.exe" -m pip install -q --upgrade pip
".venv\Scripts\python.exe" -m pip install -q -r audio\requirements.txt
if errorlevel 1 goto :fail
echo.

echo [4/5] Downloading the speech model (about 75 MB, once)...
".venv\Scripts\python.exe" -c "from faster_whisper import WhisperModel; WhisperModel('tiny.en', compute_type='int8')"
if errorlevel 1 echo     Could not download it now. It will download the first time you start listening.
echo.

echo [5/5] Checking everything loads...
".venv\Scripts\python.exe" -c "import pyaudiowpatch, scipy, faster_whisper, webrtcvad, websockets; print('    audio packages OK')"
if errorlevel 1 goto :fail
node -e "require('koffi'); require('ws'); require('docx'); console.log('    node packages OK')"
if errorlevel 1 goto :fail

echo.
echo ============================================
echo   Setup finished.
echo.
echo   Last step, once: sign in to the AI that writes your answers.
echo   Pick one:
echo     Cursor:   irm 'https://cursor.com/install?win32=true' ^| iex
echo               then run  agent login
echo     Claude:   open a terminal, run  claude , type  /login
echo     ChatGPT:  open a terminal, run  npm install -g @openai/codex
echo               then  codex login
echo.
echo   In the app: Dashboard - Settings - Main brain - Cursor
echo   Then double-click START.bat
echo ============================================
echo.
pause
exit /b 0

:nonode
echo.
echo     Node.js 18 or newer is needed. Install the LTS version from
echo     https://nodejs.org and run SETUP.bat again.
pause
exit /b 1

:nopython
echo.
echo     Python 3.9 or newer is needed. Install it from https://python.org
echo     (tick "Add python.exe to PATH") and run SETUP.bat again.
pause
exit /b 1

:fail
echo.
echo     Setup did not finish. The error is above.
pause
exit /b 1
