@echo off
title GnomeShell setup
rem Downloads the newest setup script from GitHub and runs it. Nothing here needs changing between versions.
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; $f=Join-Path $env:TEMP 'gnomeshell-install.ps1'; try { Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/physare/gnomeshell/main/install.ps1' -OutFile $f } catch { Write-Host '  Could not reach GitHub. Check the internet connection and run setup again.'; exit 1 }; & $f; exit $LASTEXITCODE"
if errorlevel 1 pause
