<#
  Removes Desktop Pods: the app folder, its Start Menu / desktop shortcuts and its
  "Send to" entry. Your files were never moved, so nothing else needs undoing.
  Your pods and settings in %APPDATA%\Desktop Pods are kept unless you add -RemoveSettings.
#>
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Desktop Pods'),
  [string]$ShortcutDir = '',   # tests only: look for shortcuts here instead of Start Menu + Desktop
  [switch]$RemoveSettings
)
$ErrorActionPreference = 'Stop'

Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$InstallDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

$dirs = if ($ShortcutDir) { @($ShortcutDir) } else {
  @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\SendTo'))
}
# Only remove shortcuts that point into this install, never one the user made themselves.
$shell = New-Object -ComObject WScript.Shell
foreach ($d in $dirs) {
  $l = Join-Path $d 'Desktop Pods.lnk'
  if (-not (Test-Path $l)) { continue }
  $s = $shell.CreateShortcut($l)
  if (("$($s.TargetPath) $($s.Arguments)") -like "*$InstallDir*") { Remove-Item $l -Force }
}

# Never delete a folder that doesn't look like ours.
if ((Test-Path $InstallDir) -and (Test-Path (Join-Path $InstallDir 'Desktop Pods.vbs'))) {
  Remove-Item $InstallDir -Recurse -Force
}
if ($RemoveSettings) { Remove-Item (Join-Path $env:APPDATA 'Desktop Pods') -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host 'Desktop Pods was removed.' -ForegroundColor Green
if (-not $RemoveSettings) { Write-Host "Your pods are still saved in $env:APPDATA\Desktop Pods (delete that folder to remove them too)." }
