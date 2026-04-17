#requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs the SPIKE bot as a Windows service that auto-starts on boot.

.DESCRIPTION
    Sets up PM2 to run the SPIKE bot 24/7 and survive reboots.
    Uses pm2-windows-startup to register PM2 as a Windows service via the Task Scheduler.

.NOTES
    Run this script ONCE, after running `npm install` in the bot folder.
    Run as Administrator.
#>

$ErrorActionPreference = 'Stop'
$BotDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " SPIKE Bot - Windows Auto-Start Setup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check Node
try {
    $nodeVer = node --version
    Write-Host "[OK] Node.js detected: $nodeVer" -ForegroundColor Green
}
catch {
    Write-Host "[ERROR] Node.js not found. Install from https://nodejs.org first." -ForegroundColor Red
    exit 1
}

# Install PM2 globally if missing
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
    Write-Host "Installing PM2 globally..." -ForegroundColor Yellow
    npm install -g pm2
}
else {
    Write-Host "[OK] PM2 already installed" -ForegroundColor Green
}

# Install pm2-windows-startup
$pm2startup = Get-Command pm2-startup -ErrorAction SilentlyContinue
if (-not $pm2startup) {
    Write-Host "Installing pm2-windows-startup..." -ForegroundColor Yellow
    npm install -g pm2-windows-startup
}
else {
    Write-Host "[OK] pm2-windows-startup already installed" -ForegroundColor Green
}

# Register PM2 to start on boot
Write-Host ""
Write-Host "Registering PM2 with Windows startup..." -ForegroundColor Yellow
pm2-startup install

# Start the bot
Write-Host ""
Write-Host "Starting the bot via PM2..." -ForegroundColor Yellow
Set-Location $BotDir
pm2 delete spike-bot 2>$null
pm2 start ecosystem.config.cjs

# Persist PM2 process list so it restores on reboot
pm2 save

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " Setup complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "The bot is now running and will auto-start on Windows boot." -ForegroundColor White
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Cyan
Write-Host "  pm2 status         - check status" -ForegroundColor Gray
Write-Host "  pm2 logs spike-bot - view live logs" -ForegroundColor Gray
Write-Host "  pm2 restart spike-bot - restart bot" -ForegroundColor Gray
Write-Host "  pm2 stop spike-bot - stop bot" -ForegroundColor Gray
Write-Host ""
Write-Host "First run? You may need to scan a QR code in the logs:" -ForegroundColor Yellow
Write-Host "  pm2 logs spike-bot" -ForegroundColor Gray
Write-Host ""
