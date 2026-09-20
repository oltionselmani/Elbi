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
#      (a shortcut in your Startup folder - no administrator rights needed)
#   2. Chrome or Edge puts it in your Start menu as a real app window, with the
#      Elbi icon and no browser bars. That is the Install button in the address
#      bar, and the script opens the page ready for it.
#
# Run on a real Windows 11 machine. The first version registered a scheduled
# task and failed there with 0x80070005, access denied: that needs
# administrator rights, and nothing here is worth a UAC prompt for. It uses the
# Startup folder now, which is the per-user equivalent and asks for nothing.

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
if (-not $mediaDir) {
  Info 'Type or paste the folder your films are in, then press Enter.'
  Info "Leave it empty to use $ElbiDir\media and add films from the browser."
  $answer = (Read-Host '  Folder').Trim().Trim('"')
  if ($answer) { $mediaDir = $answer }
}

if ($mediaDir) {
  if (-not (Test-Path $mediaDir)) {
    Warn "$mediaDir does not exist, so Elbi will use its own folder instead."
    Info 'Run this file again once the drive is plugged in, and give the folder then.'
    $mediaDir = $null
  } else {
    Info "Films: $mediaDir"
  }
}
if (-not $mediaDir) { Info "Films: $ElbiDir\media" }

# ---------------------------------------------------------------------------
Say '3. Starting Elbi whenever you sign in'
#
# ELBI_HOST=127.0.0.1 keeps it on this machine only: not on your home wifi, and
# certainly not on the internet. No password is needed for that, though you can
# still set one with `node scripts\set-login.js` - and you must, before publishing it
# anywhere.

$envPairs = @(
  'ELBI_HOST=127.0.0.1'
  "ELBI_PORT=$Port"
)
if ($mediaDir) { $envPairs += "ELBI_MEDIA_DIR=$mediaDir" }
foreach ($name in 'ELBI_SCAN_DIRS','ELBI_TMDB_KEY') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { $envPairs += "$name=$value" }
}

. (Join-Path $PSScriptRoot 'win-autostart.ps1')
$autostart = Install-ElbiAutostart -ElbiDir $ElbiDir -NodePath $node.Source -EnvPairs $envPairs
Info "Launcher: $($autostart.Launcher)"
Info "Startup shortcut: $($autostart.Startup)"

# ---------------------------------------------------------------------------
Say '4. Starting it'

if (-not (Start-ElbiNow -Hidden $autostart.Hidden -Port $Port)) {
  Info "Run this by hand to see what it says:  $($autostart.Launcher)"
  Die  "Elbi did not answer on port $Port."
}
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
    shell:startup (in the Run box)           the shortcut that starts it
    scripts\tailscale-setup.ps1              also reach it from your phone

  To undo everything this script did:
    Remove-Item "$($autostart.Startup)"
    Remove-Item "$($targets[0])", "$($targets[1])"

  To see what it is doing when something goes wrong, run the launcher by
  hand - it is exactly what starts at sign-in, only with the window showing:
    $($autostart.Launcher)
"@ | Write-Host
