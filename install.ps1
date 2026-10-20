<#
  Desktop Pods installer. One line in PowerShell:

    irm https://raw.githubusercontent.com/Sarvesh-S-25/desktop-improver/main/install.ps1 | iex

  What it does (nothing else on your PC is changed):
    1. Makes sure Node.js is installed (offers to install it with winget if it isn't).
    2. Downloads the latest Desktop Pods into %LOCALAPPDATA%\Programs\Desktop Pods.
    3. Installs its parts (Electron) with npm.
    4. Adds "Desktop Pods" to the Start Menu and your desktop, then starts it.
  Your pods and settings live separately in %APPDATA%\Desktop Pods and survive updates.
  Run the same line again to update. Uninstall: run uninstall.ps1 from the install folder.
#>
param(
  [string]$Source = 'https://github.com/Sarvesh-S-25/desktop-improver/archive/refs/heads/main.zip',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Desktop Pods'),
  [string]$ShortcutDir = '',   # tests only: put shortcuts here instead of Start Menu + Desktop
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # makes Invoke-WebRequest much faster on PowerShell 5.1

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# 1. Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Desktop Pods needs Node.js (free, from nodejs.org).' -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $ok = Read-Host 'Install Node.js LTS now with winget? (Y/n)'
    if ($ok -notmatch '^[nN]') {
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js was not found. Install the LTS version from https://nodejs.org, then run this again.'
  }
}
$nodeMajor = [int]((node -v) -replace '^v(\d+).*', '$1')
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is needed (you have $(node -v)). Update it from https://nodejs.org." }

# 2. Download (a zip, so git isn't needed)
Step 'Downloading Desktop Pods'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("desktop-pods-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'pods.zip'
  if (Test-Path $Source) { Copy-Item $Source $zip } else { Invoke-WebRequest -Uri $Source -OutFile $zip -UseBasicParsing }
  Expand-Archive -Path $zip -DestinationPath $tmp
  $src = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -First 1
  if (-not $src) { throw 'The download did not contain Desktop Pods.' }

  # Stop a running copy so its files can be replaced (your pods are saved continuously).
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$InstallDir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500

  Step "Installing to $InstallDir"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  # Replace the app files but keep node_modules, so updates are quick.
  Get-ChildItem $InstallDir -Force | Where-Object { $_.Name -ne 'node_modules' } | Remove-Item -Recurse -Force
  Get-ChildItem $src.FullName -Force | Copy-Item -Destination $InstallDir -Recurse -Force
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# 3. Dependencies (Electron is downloaded here, about 100 MB the first time)
Step 'Installing Electron (first time takes a minute)'
Push-Location $InstallDir
try {
  & npm.cmd install --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check your internet connection and run this again.' }
  # Newer Electron packages no longer fetch the app binary during npm install; do it here.
  & node.exe node_modules\electron\install.js
} finally { Pop-Location }
$electron = Join-Path $InstallDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw 'Electron did not install correctly. Run this again.' }

# 4. Shortcuts that start it without a console window
Step 'Adding shortcuts'
$shell = New-Object -ComObject WScript.Shell
$targets = if ($ShortcutDir) { @($ShortcutDir) } else { @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) }
foreach ($dir in $targets) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $lnk = $shell.CreateShortcut((Join-Path $dir 'Desktop Pods.lnk'))
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $InstallDir 'Desktop Pods.vbs') + '"'
  $lnk.WorkingDirectory = $InstallDir
  $lnk.IconLocation = (Join-Path $InstallDir 'assets\icon.ico') + ',0'
  $lnk.Description = 'Desktop Pods'
  $lnk.Save()
}

Write-Host ''
Write-Host 'Desktop Pods is installed.' -ForegroundColor Green
Write-Host 'Find it in the Start Menu or on your desktop. Right-click a pod for themes, icons and more.'
if (-not $NoLaunch) { Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $InstallDir 'Desktop Pods.vbs') + '"') }
