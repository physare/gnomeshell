@echo off
set "HERE=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'GnomeShell.lnk')); $s.TargetPath=(Join-Path $env:WINDIR 'System32\wscript.exe'); $q=[char]34; $s.Arguments=$q+'%HERE%GnomeShell.vbs'+$q; $s.WorkingDirectory='%HERE%'; $s.IconLocation='%HERE%gnomeshell.ico'; $s.Description='Build 3D-printable shells for latex molds'; $s.Save(); $old=Join-Path $d 'Mold Shell.lnk'; if (Test-Path $old) { Remove-Item $old }"
echo A "GnomeShell" shortcut is now on your desktop. The old "Mold Shell" one was removed.
echo You can right-click it and choose "Pin to taskbar" or "Pin to Start".
pause
