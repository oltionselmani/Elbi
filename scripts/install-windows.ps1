# Install Elbi on this PC: starts by itself, opens like an app. (Windows)
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#
# This is the local install — Elbi runs on this machine and answers only on
# this machine. Nothing is published anywhere. If you also want it on your
# phone, run scripts\tailscale-setup.ps1 afterwards instead; that one publishes
# it privately on your own Tailscale network.
#
# There is no .exe to install. Elbi is a web app, so "installing" it means two
# things, and this script does the first and sets up the second:
#
#   1. The server starts by itself when you sign in, so the icon always works.
#   2. Chrome or Edge puts it in your Start menu as a real app window, with the
#      Elbi icon and no browser bars. That is the Install button in the address
#      bar, and the script opens the page ready for it.
#
# NOTE: this has not been run end to end — no Windows machine was available to
# test it on. Read it before running it, and tell me what breaks.

$ErrorActionPreference = 'Stop'

$ElbiDir = Split-Path -Parent $PSScriptRoot
$Port    = if ($env:ELBI_PORT) { $env:ELBI_PORT } else { '8080' }
$Url     = "http://127.0.0.1:$Port/browse"

function Say  ($m) { Write-Host "`n$m" -ForegroundColor White }
function Info ($m) { Write-Host "  $m" }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "`n  $m`n" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
Say '1. Checking Node.js'

$node = Get-Command node -ErrorAction SilentlyContinue

# Install-Elbi.cmd puts a private copy here when the PC has none of its own,
# so nothing has to be installed system-wide and no admin rights are needed.
$bundled = Join-Path $ElbiDir 'node\node.exe'
if (-not $node -and (Test-Path $bundled)) {
  $node = [pscustomobject]@{ Source = $bundled }
  Info 'Using the copy of Node that came with Elbi.'
}

if (-not $node) {
  Info 'Node.js is not installed. Get the LTS installer from https://nodejs.org'
  Die  'Install Node.js, then run this script again.'
}
$version = (& $node.Source --version)
Info "Node $version at $($node.Source)"

# ---------------------------------------------------------------------------
Say '2. Where your films are'

$mediaDir = [Environment]::GetEnvironmentVariable('ELBI_MEDIA_DIR')
if ($mediaDir) {
  if (-not (Test-Path $mediaDir)) { Warn "ELBI_MEDIA_DIR is set to $mediaDir, which does not exist yet." }
  else { Info "Films: $mediaDir" }
} else {
  Info "No ELBI_MEDIA_DIR set, so Elbi will use $ElbiDir\media"
  Info 'To point it at a drive instead, close this window and run:'
  Info '  $env:ELBI_MEDIA_DIR="D:\Films" ; powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1'
}

# ---------------------------------------------------------------------------
Say '3. Starting Elbi whenever you sign in'
#
# ELBI_HOST=127.0.0.1 keeps it on this machine only: not on your home wifi, and
# certainly not on the internet. No password is needed for that, though you can
# still set one with `npm run set-login` — and you must, before publishing it
# anywhere.

$envPairs = @(
  'ELBI_HOST=127.0.0.1'
  "ELBI_PORT=$Port"
)
foreach ($name in 'ELBI_MEDIA_DIR','ELBI_SCAN_DIRS','ELBI_TMDB_KEY') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { $envPairs += "$name=$value" }
}

# Task Scheduler has no environment block, so a small launcher sets the
# variables and then starts Elbi. Both setup scripts write this same file: the
# last one you run is the setup you have.
$launcher = Join-Path $ElbiDir 'scripts\start-elbi.cmd'
$lines = @('@echo off')
foreach ($pair in $envPairs) { $lines += "set $pair" }
$lines += "cd /d `"$ElbiDir`""
$lines += "`"$($node.Source)`" `"$ElbiDir\server.js`""
Set-Content -Path $launcher -Value $lines -Encoding ASCII
Info "Launcher written to $launcher"

# Task Scheduler runs a .cmd in a visible console window, which would leave a
# black box in the taskbar for as long as Elbi is running — and the first thing
# anyone does with that is close it, killing the server. wscript starts the
# same launcher with the window hidden.
$hidden = Join-Path $ElbiDir 'scripts\start-elbi.vbs'
@"
Set sh = CreateObject("WScript.Shell")
sh.Run """$launcher""", 0, False
"@ | Set-Content -Path $hidden -Encoding ASCII

$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$hidden`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName 'Elbi' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'Elbi' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Elbi media server' | Out-Null
Start-ScheduledTask -TaskName 'Elbi'
Info 'Scheduled task "Elbi" installed and started.'

# ---------------------------------------------------------------------------
Say '4. Waiting for it to come up'

$up = $false
foreach ($i in 1..30) {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/auth/status" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $up = $true; break
  } catch { Start-Sleep -Seconds 1 }
}
if (-not $up) { Die "Elbi did not answer on port $Port. Open Task Scheduler and look at the task named Elbi." }
Info "Elbi is answering on 127.0.0.1:$Port."

# ---------------------------------------------------------------------------
Say '5. Putting an icon on the desktop'

$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$browser = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1

$icon = Join-Path $ElbiDir 'public\icons\elbi.ico'
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Elbi.lnk')
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Elbi.lnk')
)

foreach ($target in $targets) {
  $parent = Split-Path -Parent $target
  if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $link = $shell.CreateShortcut($target)
  if ($browser) {
    # --app opens a plain window with no tabs or address bar, which is as close
    # to a native app as a shortcut gets before you press Install.
    $link.TargetPath = $browser
    $link.Arguments  = "--app=$Url"
  } else {
    $link.TargetPath = $Url
  }
  $link.WorkingDirectory = $ElbiDir
  if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
  $link.Description = 'Elbi — your own streaming library'
  $link.Save()
  Info "Shortcut: $target"
}

if (-not $browser) {
  Warn 'Chrome or Edge was not found, so the shortcut opens in your default browser as an ordinary tab.'
}

# ---------------------------------------------------------------------------
Say 'Done'

if ($browser) { Start-Process $browser $Url } else { Start-Process $Url }

@"

  Elbi is running at $Url
  It starts by itself every time you sign in to Windows.

  One last step, for a real app rather than a shortcut:

    In Chrome or Edge, open $Url and click the Install
    button in the address bar (a screen with a downward arrow), or
    the three-dot menu -> Cast, save and share -> Install page as app.

  That puts Elbi in your Start menu with its own icon, opens it in its own
  window with no browser bars, and lets you pin it to the taskbar.

  Later:
    node scripts\set-login.js                set or change the password
    Task Scheduler -> Elbi                   stop it starting at sign-in
    scripts\tailscale-setup.ps1              also reach it from your phone

  To undo everything this script did:
    Unregister-ScheduledTask -TaskName Elbi -Confirm:`$false
    Remove-Item "$($targets[0])", "$($targets[1])"

  To see what it is doing when something goes wrong, run the launcher by
  hand — the task runs exactly this, only with the window hidden:
    $launcher
"@ | Write-Host
