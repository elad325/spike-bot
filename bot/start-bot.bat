@echo off
chcp 65001 >nul 2>nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ================================
echo   SPIKE Bot - Smart Start
echo ================================
echo.

REM === 1) Node.js installed? ===
where node >nul 2>nul
if errorlevel 1 (
    echo [X] Node.js is not installed.
    echo Please install Node.js 18+ from https://nodejs.org and re-run this script.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
echo [OK] Node.js !NODE_VER!

REM Warn (don't block) if Node is older than v18
node -e "process.exit(parseInt(process.version.slice(1).split('.')[0])>=18?0:1)" 2>nul
if errorlevel 1 (
    echo [!] Warning: Node.js is older than v18 - the bot may misbehave.
    echo     Update from https://nodejs.org for best results.
    timeout /t 3 >nul
)

REM === 2) npm installed? ===
where npm >nul 2>nul
if errorlevel 1 (
    echo [X] npm is missing - reinstall Node.js to fix this.
    pause
    exit /b 1
)

REM === 3) First-time install if needed ===
if not exist node_modules\ (
    echo.
    echo [..] First-time install - downloading all dependencies...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [X] npm install failed - see errors above.
        pause
        exit /b 1
    )
)
echo [OK] Dependencies installed

REM === 4) .env file ===
if not exist .env (
    echo.
    echo [..] .env is missing - creating it from .env.example
    if not exist .env.example (
        echo [X] .env.example is missing too. Reinstall the bot folder.
        pause
        exit /b 1
    )
    copy .env.example .env >nul
    echo.
    echo Opening .env in Notepad. Please fill in:
    echo    - SUPABASE_SERVICE_ROLE_KEY
    echo    - GOOGLE_CLIENT_ID
    echo    - GOOGLE_CLIENT_SECRET
    echo.
    echo Save and close Notepad, then press any key here.
    notepad .env
    pause >nul
)
echo [OK] .env present

REM === 5) Preflight loop (env vars + Supabase + Google Drive) ===
:preflight
echo.
echo [..] Running preflight checks...
node preflight.js
set EC=!errorlevel!

if !EC! equ 0 goto :launch

echo.
if !EC! equ 10 (
    echo [!] Supabase credentials are missing or empty in .env.
    notepad .env
    echo Saved? Press any key to re-check.
    pause >nul
    goto :preflight
)

if !EC! equ 11 (
    echo [!] Cannot reach Supabase or the service role key is wrong.
    notepad .env
    echo Saved? Press any key to re-check.
    pause >nul
    goto :preflight
)

if !EC! equ 12 (
    echo [!] Google Drive is not connected yet.
    echo     Launching one-time Google authorization flow...
    call npm run setup-google
    if errorlevel 1 (
        echo [X] Google setup failed or was cancelled.
        pause
        exit /b 1
    )
    goto :preflight
)

if !EC! equ 13 (
    echo [!] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing in .env.
    notepad .env
    echo Saved? Press any key to re-check.
    pause >nul
    goto :preflight
)

echo [X] Preflight returned an unknown exit code: !EC!
pause
exit /b 1

REM === 6) Launch (auto-updates Baileys + all packages, then starts the bot) ===
:launch
echo.
echo ================================
echo   Starting SPIKE Bot
echo ================================
echo (Press Ctrl+C to stop)
echo.
node update-and-start.js
echo.
echo Bot exited. Press any key to close.
pause >nul
