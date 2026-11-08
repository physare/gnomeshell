# GnomeShell setup. Installs (or updates) GnomeShell for this Windows user,
# sets up Blender 5.2 next to it if the computer doesn't have it, adds desktop
# and Start menu shortcuts, and opens the app. GnomeShell-Setup.bat runs it.
# No administrator rights are needed: everything goes in this user's folders.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is far faster without its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName PresentationFramework

$Repo = 'physare/gnomeshell'
$AppDir = Join-Path $env:LOCALAPPDATA 'Programs\GnomeShell'
$Tmp = Join-Path $env:TEMP ('GnomeShellSetup_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

function Say([string]$t) { Write-Host "  $t" }
function Ask([string]$t) { [System.Windows.MessageBox]::Show($t, 'GnomeShell setup', 'YesNo', 'Question') -eq 'Yes' }
function Tell([string]$t, [string]$icon = 'Information') { [System.Windows.MessageBox]::Show($t, 'GnomeShell setup', 'OK', $icon) | Out-Null }
function Stop-Setup([string]$t) {
    Tell $t 'Error'
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# curl.exe comes with Windows 10 and 11 and is much quicker for big files
function Get-File([string]$url, [string]$out) {
    $curl = Join-Path $env:WINDIR 'System32\curl.exe'
    if (Test-Path $curl) {
        & $curl -L --fail --silent --show-error -o $out $url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $url" }
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out
    }
}

function Get-Version([string]$text) {
    $m = [regex]::Match([string]$text, '(\d+)\.(\d+)')
    if ($m.Success) { return [version]("{0}.{1}" -f $m.Groups[1].Value, $m.Groups[2].Value) }
    return $null
}

# Blender 5.2 or newer: the version written into blender.exe, or failing that its folder's name
function Test-Blender([string]$exe) {
    if (-not $exe -or -not (Test-Path $exe)) { return $false }
    $v = $null
    try { $v = Get-Version ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion) } catch { }
    if (-not $v) { $v = Get-Version (Split-Path (Split-Path $exe -Parent) -Leaf) }
    if (-not $v) { return $true }  # can't tell; let GnomeShell try it
    return $v -ge [version]'5.2'
}

function Find-Blender {
    $c = New-Object System.Collections.Generic.List[string]
    $txt = Join-Path $AppDir 'blender_path.txt'
    if (Test-Path $txt) { $c.Add(((Get-Content $txt -TotalCount 1) -replace '"', '').Trim()) }
    $c.Add((Join-Path $AppDir 'blender\blender.exe'))
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($root -and (Test-Path (Join-Path $root 'Blender Foundation'))) {
            Get-ChildItem (Join-Path $root 'Blender Foundation') -Directory -Filter 'Blender*' |
                Sort-Object Name -Descending | ForEach-Object { $c.Add((Join-Path $_.FullName 'blender.exe')) }
        }
    }
    $w = Get-Command blender.exe -ErrorAction SilentlyContinue
    if ($w) { $c.Add($w.Source) }
    if (${env:ProgramFiles(x86)}) { $c.Add((Join-Path ${env:ProgramFiles(x86)} 'Steam\steamapps\common\Blender\blender.exe')) }
    foreach ($p in $c) { if (Test-Blender $p) { return $p } }
    return $null
}

Write-Host ''
Write-Host '  GnomeShell setup'
Write-Host '  ----------------'
Write-Host ''

# 1. GnomeShell itself, the newest version
try {
    Say 'Downloading GnomeShell...'
    $zip = Join-Path $Tmp 'gnomeshell.zip'
    Get-File "https://codeload.github.com/$Repo/zip/refs/heads/main" $zip
    Expand-Archive -Path $zip -DestinationPath $Tmp -Force
    $src = Get-ChildItem $Tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'engine\server.py') } | Select-Object -First 1
    if (-not $src) { throw "The download doesn't look like GnomeShell." }
    Say "Installing it in $AppDir"
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    foreach ($f in Get-ChildItem $src.FullName -Recurse -File) {
        $rel = $f.FullName.Substring($src.FullName.Length).TrimStart('\')
        $to = Join-Path $AppDir $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent) | Out-Null
        Copy-Item -LiteralPath $f.FullName -Destination $to -Force
    }
} catch {
    Stop-Setup ("GnomeShell couldn't be downloaded. Check the internet connection and run setup again.`n`n" + $_.Exception.Message)
}

# 2. Blender
Say 'Looking for Blender 5.2...'
$blender = Find-Blender
if ($blender) {
    Say "Found it: $blender"
} else {
    $yes = Ask ("GnomeShell uses Blender 5.2 (free, from blender.org) to do its work, and this computer doesn't have it.`n`n" +
                "Download and set it up now? It's about 400 MB and takes a few minutes. It goes in GnomeShell's own folder and doesn't change any other Blender.")
    if (-not $yes) {
        Tell "GnomeShell is installed, but it needs Blender 5.2 to run. Install Blender 5.2 from blender.org, then start GnomeShell from its shortcut." 'Warning'
    } else {
        try {
            Say 'Finding the newest Blender 5.2...'
            $page = (Invoke-WebRequest -UseBasicParsing -Uri 'https://download.blender.org/release/Blender5.2/').Content
            $patches = @([regex]::Matches($page, 'blender-5\.2\.(\d+)-windows-x64\.zip') | ForEach-Object { [int]$_.Groups[1].Value } | Sort-Object -Unique)
            if ($patches.Count -eq 0) { throw 'No Blender 5.2 download for Windows was listed.' }
            $name = 'blender-5.2.{0}-windows-x64' -f $patches[-1]
            Say "Downloading $name (about 400 MB, a few minutes)..."
            $bzip = Join-Path $Tmp "$name.zip"
            Get-File "https://download.blender.org/release/Blender5.2/$name.zip" $bzip
            Say 'Unpacking Blender...'
            $dest = Join-Path $AppDir 'blender'
            if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
            $tar = Join-Path $env:WINDIR 'System32\tar.exe'
            if (Test-Path $tar) {
                & $tar -xf $bzip -C $AppDir
                if ($LASTEXITCODE -ne 0) { throw 'Unpacking Blender failed.' }
            } else {
                Expand-Archive -Path $bzip -DestinationPath $AppDir -Force
            }
            Rename-Item (Join-Path $AppDir $name) 'blender'
            $blender = Join-Path $dest 'blender.exe'
            if (-not (Test-Path $blender)) { throw 'blender.exe is missing after unpacking.' }
            Say 'Blender is ready.'
        } catch {
            Tell ("Blender couldn't be set up: " + $_.Exception.Message + "`n`nGnomeShell is installed. Install Blender 5.2 from blender.org, then start GnomeShell from its shortcut.") 'Warning'
            $blender = $null
        }
    }
}
if ($blender) { [IO.File]::WriteAllText((Join-Path $AppDir 'blender_path.txt'), $blender + "`r`n") }

# 3. Shortcuts on the desktop and in the Start menu (and the old Mold Shell one goes)
Say 'Adding shortcuts...'
$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$start = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
foreach ($dir in @($desktop, $start)) {
    $s = $ws.CreateShortcut((Join-Path $dir 'GnomeShell.lnk'))
    $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $s.Arguments = '"' + (Join-Path $AppDir 'GnomeShell.vbs') + '"'
    $s.WorkingDirectory = $AppDir
    $s.IconLocation = Join-Path $AppDir 'gnomeshell.ico'
    $s.Description = 'Build 3D-printable shells for latex molds'
    $s.Save()
}
$old = Join-Path $desktop 'Mold Shell.lnk'
if (Test-Path $old) { Remove-Item $old -Force }

Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue

# 4. Open it
if ($blender) {
    Say 'Starting GnomeShell...'
    Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $AppDir 'GnomeShell.vbs') + '"')
}
Write-Host ''
Say 'Done. GnomeShell is on your desktop and in the Start menu.'
Start-Sleep -Seconds 3
