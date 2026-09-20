# Start Elbi when you sign in to Windows — without asking for anything.
#
# Dot-sourced by install-windows.ps1 and tailscale-setup.ps1; not run directly.
#
# This used to register a scheduled task, which is the tidier mechanism and
# has a restart-on-failure setting. It also needs administrator rights on a
# default Windows install — Register-ScheduledTask fails with 0x80070005 —
# and there is nothing here worth a UAC prompt for. The Startup folder is the
# per-user equivalent, needs no rights at all, and runs at exactly the same
# moment.
#
# Two files do the work:
#   start-elbi.cmd   sets the environment and starts node
#   start-elbi.vbs   runs that with the console window hidden, so signing in
#                    does not leave a black box in the taskbar that anyone
#                    would reasonably close — killing the server with it

function Install-ElbiAutostart {
  param(
    [Parameter(Mandatory = $true)] [string]   $ElbiDir,
    [Parameter(Mandatory = $true)] [string]   $NodePath,
    [string[]] $EnvPairs = @()
  )

  $launcher = Join-Path $ElbiDir 'scripts\start-elbi.cmd'
  $lines = @('@echo off')
  foreach ($pair in $EnvPairs) { $lines += "set $pair" }
  $lines += "cd /d `"$ElbiDir`""
  $lines += "`"$NodePath`" `"$ElbiDir\server.js`""
  Set-Content -Path $launcher -Value $lines -Encoding ASCII

  $hidden = Join-Path $ElbiDir 'scripts\start-elbi.vbs'
  @"
Set sh = CreateObject("WScript.Shell")
sh.Run """$launcher""", 0, False
"@ | Set-Content -Path $hidden -Encoding ASCII

  $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Elbi.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($startup)
  $link.TargetPath = 'wscript.exe'
  $link.Arguments = "`"$hidden`""
  $link.WorkingDirectory = $ElbiDir
  $link.Description = 'Starts Elbi in the background'
  $icon = Join-Path $ElbiDir 'public\icons\elbi.ico'
  if (Test-Path $icon) { $link.IconLocation = "$icon,0" }
  $link.Save()

  return [pscustomobject]@{ Launcher = $launcher; Hidden = $hidden; Startup = $startup }
}

# Start it now, unless it is already answering.
function Start-ElbiNow {
  param(
    [Parameter(Mandatory = $true)] [string] $Hidden,
    [Parameter(Mandatory = $true)] [string] $Port
  )

  if (Test-ElbiUp -Port $Port -Tries 1) { return $true }
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Hidden`"" -WindowStyle Hidden
  return (Test-ElbiUp -Port $Port -Tries 30)
}

function Test-ElbiUp {
  param(
    [Parameter(Mandatory = $true)] [string] $Port,
    [int] $Tries = 30
  )

  foreach ($i in 1..$Tries) {
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/auth/status" -UseBasicParsing -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      if ($i -lt $Tries) { Start-Sleep -Seconds 1 }
    }
  }
  return $false
}
