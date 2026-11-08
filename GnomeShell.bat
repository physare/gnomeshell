@echo off
title GnomeShell
setlocal
set "HERE=%~dp0"
set "BL="
if exist "%HERE%blender_path.txt" set /p BL=<"%HERE%blender_path.txt"
if defined BL set "BL=%BL:"=%"
if not defined BL for /d %%D in ("%ProgramFiles%\Blender Foundation\Blender 5*") do set "BL=%%D\blender.exe"
if not exist "%BL%" for /f "delims=" %%P in ('where blender 2^>nul') do set "BL=%%P"
if not exist "%BL%" if exist "%ProgramFiles(x86)%\Steam\steamapps\common\Blender\blender.exe" set "BL=%ProgramFiles(x86)%\Steam\steamapps\common\Blender\blender.exe"
if not exist "%BL%" (
  if not exist "%HERE%blender_path.txt" echo C:\Program Files\Blender Foundation\Blender 5.2\blender.exe> "%HERE%blender_path.txt"
  powershell -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('GnomeShell could not find Blender 5.2. Open blender_path.txt in the GnomeShell folder, put the full path to blender.exe on the first line, save it, and start GnomeShell again.','GnomeShell') | Out-Null"
  if /i not "%~1"=="hidden" pause
  exit /b 1
)
echo.
echo   Starting GnomeShell with "%BL%"
echo   The GnomeShell window will open in a moment. Closing it quits GnomeShell.
echo.
"%BL%" -b --factory-startup --python "%HERE%engine\server.py" > "%TEMP%\GnomeShell.log" 2>&1
