@echo off
rem ===========================================================================
rem  Elbi - one file, double-click, done.
rem
rem  Downloads Elbi, downloads a private copy of Node if this PC has none, and
rem  sets it up so it starts by itself whenever you sign in. Nothing to type.
rem
rem  No administrator rights are needed: everything lands in your own
rem  AppData folder and nothing is installed system-wide.
rem
rem  It uses only what Windows already ships with - curl and tar, both present
rem  since Windows 10 1803 - so there is nothing to install first.
rem
rem  NOTE: this has not been run on a Windows machine; there was none to test
rem  on. If it stops, the message tells you where, and the manual route is in
rem  SETUP.md.
rem ===========================================================================

setlocal enableextensions
title Elbi

set "REPO=https://codeload.github.com/oltionselmani/Elbi/zip/refs/heads/claude/elbi-netflix-replica-8y3y7t"
set "NODEVER=v24.21.0"
set "NODEZIP=https://nodejs.org/dist/%NODEVER%/node-%NODEVER%-win-x64.zip"
set "ROOT=%LOCALAPPDATA%\Elbi"
set "WORK=%TEMP%\elbi-install"

echo.
echo   ELBI
echo   ====
echo.
echo   Installing into %ROOT%
echo.

rem --- what Windows must already have --------------------------------------
where curl.exe >nul 2>&1 || goto :tooold
where tar.exe  >nul 2>&1 || goto :tooold

if exist "%WORK%" rd /s /q "%WORK%"
mkdir "%WORK%" 2>nul

rem --- Elbi itself ----------------------------------------------------------
echo   [1/4] Downloading Elbi...
curl.exe -fsSL -o "%WORK%\elbi.zip" "%REPO%"
if errorlevel 1 goto :nodownload

mkdir "%WORK%\src" 2>nul
tar.exe -xf "%WORK%\elbi.zip" -C "%WORK%\src"
if errorlevel 1 goto :badzip

rem GitHub wraps the files in one folder whose name carries the branch.
set "SRC="
for /d %%D in ("%WORK%\src\*") do set "SRC=%%D"
if not defined SRC goto :badzip

mkdir "%ROOT%" 2>nul
rem /E copies subfolders; no /MIR, because that would delete the library and
rem the films of anyone running this a second time.
robocopy "%SRC%" "%ROOT%" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul
if errorlevel 8 goto :nocopy
echo         done.

rem --- Node, only if this PC has none ---------------------------------------
where node.exe >nul 2>&1
if %errorlevel%==0 (
  echo   [2/4] Node is already installed. Good.
) else (
  echo   [2/4] Downloading Node %NODEVER% ^(about 30 MB, no installer^)...
  curl.exe -fsSL -o "%WORK%\node.zip" "%NODEZIP%"
  if errorlevel 1 goto :nonode

  mkdir "%WORK%\node" 2>nul
  tar.exe -xf "%WORK%\node.zip" -C "%WORK%\node"
  if errorlevel 1 goto :nonode

  robocopy "%WORK%\node\node-%NODEVER%-win-x64" "%ROOT%\node" /E /NFL /NDL /NJH /NJS /NC /NS /NP >nul
  if errorlevel 8 goto :nonode
  echo         done - kept inside %ROOT%\node, not installed system-wide.
)

rem --- set it up ------------------------------------------------------------
echo   [3/4] Setting it up...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\install-windows.ps1"
if errorlevel 1 goto :setupfailed

rem --- tidy -----------------------------------------------------------------
echo.
echo   [4/4] Cleaning up...
rd /s /q "%WORK%" 2>nul
echo.
echo   Finished. Elbi is on your desktop.
echo.
pause
exit /b 0

rem ===========================================================================
:tooold
echo.
echo   This needs Windows 10 (2018) or newer - it uses curl and tar, which
echo   older versions do not have.
echo.
echo   The manual route is in SETUP.md on the Elbi page on GitHub.
echo.
pause
exit /b 1

:nodownload
echo.
echo   Could not download Elbi. Check the internet connection and try again.
echo.
pause
exit /b 1

:badzip
echo.
echo   The download arrived damaged. Try again - it is usually a broken
echo   connection partway through.
echo.
pause
exit /b 1

:nocopy
echo.
echo   Could not write to %ROOT%.
echo   If Elbi is already running, close it and run this again.
echo.
pause
exit /b 1

:nonode
echo.
echo   Could not set up Node. You can install it yourself from
echo   https://nodejs.org (the LTS button), then run this file again.
echo.
pause
exit /b 1

:setupfailed
echo.
echo   Elbi was downloaded to %ROOT%, but the setup step stopped.
echo   The message above says where. Nothing is broken; you can run this
echo   file again once it is sorted.
echo.
pause
exit /b 1
