# Put Elbi on your Tailscale network: private, HTTPS, and always on. (Windows)
#
#   powershell -ExecutionPolicy Bypass -File scripts\tailscale-setup.ps1
#
# Nothing is exposed to the public internet. Tailscale is a private network
# between your own devices, so there is no address for a stranger to find.
#
# NOTE: unlike the bash version, this script has not been run end to end — no
# Windows machine was available to test it on. The bash one was exercised with
# a stubbed tailscale. Read it before running, and tell me what breaks.

$ErrorActionPreference = 'Stop'

$ElbiDir = Split-Path -Parent $PSScriptRoot
$Port    = if ($env:ELBI_PORT) { $env:ELBI_PORT } else { '8080' }

function Say  ($m) { Write-Host "`n$m" -ForegroundColor White }
function Info ($m) { Write-Host "  $m" }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "`n  $m`n" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
Say '1. Checking Tailscale'

$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) {
  $candidate = 'C:\Program Files\Tailscale\tailscale.exe'
  if (Test-Path $candidate) { $ts = $candidate } else {
    Info 'Tailscale is not installed. Get it from https://tailscale.com/download/windows'
    Die  'Install Tailscale, sign in, then run this script again.'
  }
} else { $ts = $ts.Source }

& $ts status *> $null
if ($LASTEXITCODE -ne 0) { Die "Tailscale is installed but not signed in. Run 'tailscale up' first." }
Info 'Tailscale is running.'

# ---------------------------------------------------------------------------
Say '2. Checking the sign-in'

if (-not (Test-Path (Join-Path $ElbiDir 'data\credentials.json'))) {
  Warn 'No sign-in has been set up yet.'
  Info "Run this first:  cd `"$ElbiDir`" ; npm run set-login"
  Die  'Set the login, then run this script again.'
}
Info 'A sign-in is configured.'

# ---------------------------------------------------------------------------
Say '3. Installing the scheduled task'
#
# Two settings matter and belong together:
#
#   ELBI_HOST=127.0.0.1   Elbi listens only on this machine, so Tailscale is
#                         the single way in — not your home wifi either.
#   ELBI_TRUST_PROXY=1    Behind a proxy every request looks like it comes from
#                         127.0.0.1, so without this one person mistyping their
#                         password five times would lock out the whole family.
#                         Safe only because of the line above.

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Die 'Node.js is not installed.' }

$envPairs = @(
  'ELBI_HOST=127.0.0.1'
  "ELBI_PORT=$Port"
  'ELBI_TRUST_PROXY=1'
)
foreach ($name in 'ELBI_MEDIA_DIR','ELBI_SCAN_DIRS','ELBI_TMDB_KEY') {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { $envPairs += "$name=$value" }
}

# Task Scheduler has no environment block, so a tiny launcher sets the
# variables and then starts Elbi.
$launcher = Join-Path $ElbiDir 'scripts\start-elbi.cmd'
$lines = @('@echo off')
foreach ($pair in $envPairs) { $lines += "set $pair" }
$lines += "cd /d `"$ElbiDir`""
$lines += "`"$($node.Source)`" `"$ElbiDir\server.js`""
Set-Content -Path $launcher -Value $lines -Encoding ASCII
Info "Launcher written to $launcher"

$action   = New-ScheduledTaskAction -Execute $launcher
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Unregister-ScheduledTask -TaskName 'Elbi' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'Elbi' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Elbi media server' | Out-Null
Start-ScheduledTask -TaskName 'Elbi'
Info 'Scheduled task "Elbi" installed and started (runs at every sign-in).'

# ---------------------------------------------------------------------------
Say '4. Publishing it on your tailnet'

$up = $false
foreach ($i in 1..30) {
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/auth/status" -UseBasicParsing -TimeoutSec 2 | Out-Null
    $up = $true; break
  } catch { Start-Sleep -Seconds 1 }
}
if (-not $up) { Die "Elbi did not come up on port $Port. Check the task in Task Scheduler." }
Info "Elbi is answering on 127.0.0.1:$Port."

& $ts serve --bg "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) { Die "Could not publish with 'tailscale serve'. Try: tailscale serve status" }

$url = (& $ts serve status 2>$null | Select-String -Pattern 'https://\S+' |
        ForEach-Object { $_.Matches[0].Value } | Select-Object -First 1)

# ---------------------------------------------------------------------------
Say 'Done'
@"

  Your address:   $url

  It is reachable only from devices signed into your Tailscale account.
  Nothing is published to the public internet.

  For each family member:
    1. Install Tailscale on their phone (App Store / Play Store).
    2. Sign in, or accept the invite from
       https://login.tailscale.com/admin/users
    3. Open $url in Safari or Chrome.
    4. Sign in once, leaving "Remember this device" ticked.
    5. iPhone: Share -> Add to Home Screen.

  Useful later:
    tailscale serve status              what is published
    tailscale serve --https=443 off     stop publishing
    npm run set-login                   change the email or password
"@ | Write-Host
