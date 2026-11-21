@echo off
setlocal EnableExtensions
title Build Lumen R9 for Windows

rem =====================================================================
rem  Lumen R9 — one-click Windows build.
rem
rem  Produces (in build\r9\windows):
rem     Lumen.exe        the portable player (always built)
rem     Lumen-Setup-*.exe  the installer (only when NSIS 3.x is found)
rem
rem  NSIS is OPTIONAL. It is only the installer packer; the player itself
rem  never needs it. When it is missing the portable app is still built and
rem  a portable ZIP is written instead, so a missing NSIS can no longer stop
rem  the build. Put this BAT beside the source folder or inside it.
rem =====================================================================

set "SRC_DIR="
if exist "%~dp0package.json" set "SRC_DIR=%~dp0"
if not defined SRC_DIR if exist "%~dp0source\package.json" set "SRC_DIR=%~dp0source\"
if not defined SRC_DIR (
  echo ERROR: Could not find package.json.
  echo Put this BAT beside the source folder or beside package.json.
  pause
  exit /b 1
)
for %%I in ("%SRC_DIR%..") do set "ROOT_DIR=%%~fI"
set "BUILD_DIR=%ROOT_DIR%\build\r9"
set "ELECTRON_ZIP=%ROOT_DIR%\.electron\electron-v44.5.1-win32-x64.zip"
set "ELECTRON_URL=https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-win32-x64.zip"
set "ELECTRON_SHA=9b382492dcfee91f8f9e92c91f7972550a1b95d2299cac72279dab33a600d7db"
set "FFMPEG_ZIP=%USERPROFILE%\.cache\lumen-build\ffmpeg-9.0.2-essentials_build.zip"
set "FFMPEG_URL=https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip"
set "FFMPEG_SHA=60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba"
set "SETUP_EXE=%BUILD_DIR%\windows\Lumen-Setup-1.0.0-r9.exe"
set "PORTABLE_EXE=%BUILD_DIR%\windows\Lumen.exe"
set "PORTABLE_ZIP=%BUILD_DIR%\Lumen-portable-1.0.0-r9.zip"
set "PF86=%ProgramFiles(x86)%"
set "PF64=%ProgramFiles%"
set "MAKENSIS="

echo.
echo ============================================================
echo   Lumen R9 Windows x64 build
echo ============================================================
echo Source: %SRC_DIR%
echo Output: %BUILD_DIR%\windows
echo.

pushd "%SRC_DIR%"
if errorlevel 1 (
  echo ERROR: Could not open the source folder.
  pause
  exit /b 1
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not on PATH.
  echo Install Node.js 22.12 or newer, then run this BAT again.
  set "BUILD_RC=1"
  goto :fail
)
node -e "const v=process.versions.node.split('.').map(Number); process.exit(v[0] > 22 || (v[0] === 22 && v[1] >= 12) ? 0 : 1)"
if errorlevel 1 (
  echo ERROR: Node.js 22.12 or newer is required. Detected:
  node --version
  set "BUILD_RC=1"
  goto :fail
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found. Reinstall Node.js with npm enabled.
  set "BUILD_RC=1"
  goto :fail
)

if not exist "%ROOT_DIR%\.electron" mkdir "%ROOT_DIR%\.electron"
if not exist "%USERPROFILE%\.cache\lumen-build" mkdir "%USERPROFILE%\.cache\lumen-build"

echo [1/5] Installing the source build dependencies...
call npm.cmd install --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto :fail

echo.
echo [2/5] Downloading/checking the pinned FFmpeg 9.0.2 package...
if not exist "%FFMPEG_ZIP%" (
  where curl.exe >nul 2>&1
  if not errorlevel 1 (
    curl.exe -fL --retry 3 --connect-timeout 20 -o "%FFMPEG_ZIP%" "%FFMPEG_URL%"
    if errorlevel 1 (
      del /q "%FFMPEG_ZIP%" 2>nul
      echo Standard Windows TLS revocation check failed; retrying with --ssl-no-revoke.
      echo TLS certificate/hostname validation remains enabled; the pinned SHA-256 is checked next.
      curl.exe --ssl-no-revoke -fL --retry 3 --connect-timeout 20 -o "%FFMPEG_ZIP%" "%FFMPEG_URL%"
    )
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:FFMPEG_URL -OutFile $env:FFMPEG_ZIP"
  )
  if errorlevel 1 (
    del /q "%FFMPEG_ZIP%" 2>nul
    echo ERROR: FFmpeg package download failed.
    set "BUILD_RC=1"
    goto :fail
  )
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:FFMPEG_ZIP; $e='%FFMPEG_SHA%'; $a=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant(); if ($a -ne $e) { Write-Error ('FFmpeg SHA-256 mismatch: '+$a); exit 1 }; Write-Host ('FFmpeg SHA-256 OK: '+$a)"
if errorlevel 1 (
  del /q "%FFMPEG_ZIP%" 2>nul
  set "BUILD_RC=1"
  goto :fail
)

echo.
echo [3/5] Downloading/checking the pinned Electron 44.5.1 Windows x64 runtime...
if not exist "%ELECTRON_ZIP%" (
  where curl.exe >nul 2>&1
  if not errorlevel 1 (
    curl.exe -fL --retry 3 --connect-timeout 20 -o "%ELECTRON_ZIP%" "%ELECTRON_URL%"
    if errorlevel 1 (
      del /q "%ELECTRON_ZIP%" 2>nul
      echo Standard Windows TLS revocation check failed; retrying with --ssl-no-revoke.
      echo TLS certificate/hostname validation remains enabled; the pinned SHA-256 is checked next.
      curl.exe --ssl-no-revoke -fL --retry 3 --connect-timeout 20 -o "%ELECTRON_ZIP%" "%ELECTRON_URL%"
    )
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:ELECTRON_URL -OutFile $env:ELECTRON_ZIP"
  )
  if errorlevel 1 (
    del /q "%ELECTRON_ZIP%" 2>nul
    echo ERROR: Electron download failed.
    set "BUILD_RC=1"
    goto :fail
  )
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:ELECTRON_ZIP; $e='%ELECTRON_SHA%'; $a=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant(); if ($a -ne $e) { Write-Error ('Electron SHA-256 mismatch: '+$a); exit 1 }; Write-Host ('Electron SHA-256 OK: '+$a)"
if errorlevel 1 (
  del /q "%ELECTRON_ZIP%" 2>nul
  set "BUILD_RC=1"
  goto :fail
)

echo.
echo [4/5] Building the portable Windows app with bundled FFmpeg/ffprobe...
node tools\build-windows.js --zip "%ELECTRON_ZIP%" --ffmpeg-zip "%FFMPEG_ZIP%" --out "%BUILD_DIR%" --build-id r9-2026-10-04
if errorlevel 1 goto :fail
if not exist "%PORTABLE_EXE%" (
  echo ERROR: The portable app was not created at "%PORTABLE_EXE%".
  set "BUILD_RC=1"
  goto :fail
)

echo.
echo [5/5] Building the NSIS installer (optional)...
call :find_nsis
if not defined MAKENSIS goto :nsis_missing
echo Using makensis: %MAKENSIS%
node tools\build-installer.js --out "%BUILD_DIR%" --revision r9 --makensis "%MAKENSIS%"
rem  exit code 3 = "makensis not found" (build-installer already printed why)
rem  exit code 1+ = a real failure. Never read %ERRORLEVEL% inside a ( ) block.
if "%ERRORLEVEL%"=="3" goto :nsis_missing
if errorlevel 1 goto :fail
if not exist "%SETUP_EXE%" (
  echo ERROR: Installer was not created at "%SETUP_EXE%".
  set "BUILD_RC=1"
  goto :fail
)
goto :done

:nsis_missing
echo.
echo NSIS was not found on PATH or in any standard folder — installer skipped.
goto :no_nsis


:no_nsis
echo.
echo NOTE: no installer was built. That is not an error.
echo       NSIS is only the packer for Lumen-Setup.exe; the player itself
echo       does not need it. Your runnable app is:
echo           %PORTABLE_EXE%
echo.
echo       To also get an installer, install NSIS 3.x and run this BAT again:
echo           winget install --id NSIS.NSIS -e
echo           choco install nsis -y
echo           or https://nsis.sourceforge.io/Download  and add its folder to PATH
echo.
echo       Packaging the portable app as a ZIP instead...
if exist "%PORTABLE_ZIP%" del /q "%PORTABLE_ZIP%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '%BUILD_DIR%\windows\*' -DestinationPath '%PORTABLE_ZIP%' -CompressionLevel Optimal -Force"
if errorlevel 1 (
  echo NOTE: the portable ZIP could not be created; the folder itself is complete.
  set "PORTABLE_ZIP="
) else (
  echo Portable ZIP: %PORTABLE_ZIP%
)
goto :done


:done
echo.
echo ============================================================
echo   BUILD COMPLETE
echo ============================================================
if exist "%PORTABLE_EXE%" echo Portable app: %PORTABLE_EXE%
if exist "%SETUP_EXE%" echo Installer:    %SETUP_EXE%
if defined PORTABLE_ZIP if exist "%PORTABLE_ZIP%" echo Portable ZIP: %PORTABLE_ZIP%
echo.
echo Keep Lumen.exe beside all the other files in its windows folder.
echo FFmpeg and ffprobe are bundled; the finished player does not download them.
echo.
if exist "%SETUP_EXE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Item -LiteralPath $env:PORTABLE_EXE | Select-Object FullName,Length | Format-Table -AutoSize; Get-FileHash -LiteralPath $env:SETUP_EXE -Algorithm SHA256"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Item -LiteralPath $env:PORTABLE_EXE | Select-Object FullName,Length | Format-Table -AutoSize"
)
popd
pause
exit /b 0


:fail
if not defined BUILD_RC set "BUILD_RC=%ERRORLEVEL%"
if "%BUILD_RC%"=="0" set "BUILD_RC=1"
echo.
echo BUILD FAILED. The command that failed is shown immediately above.
echo Check Node.js 22.12+, network access and free disk space.
echo (NSIS is optional and is not the reason for a failure at this stage.)
echo If this is not enough, save the complete console text or a screenshot.
popd
pause
exit /b %BUILD_RC%


rem ============================================================ subroutines
rem  Find makensis.exe: PATH, NSIS_DIR, the usual install folders, and the
rem  registry key the official NSIS installer writes.
:find_nsis
for /f "delims=" %%I in ('where.exe makensis.exe 2^>nul') do if not defined MAKENSIS set "MAKENSIS=%%I"
if defined MAKENSIS exit /b 0
call :try_nsis "%NSIS_DIR%"
call :try_nsis "%PF64%\NSIS"
call :try_nsis "%PF86%\NSIS"
call :try_nsis "%ProgramW6432%\NSIS"
call :try_nsis "%LOCALAPPDATA%\Programs\NSIS"
call :try_nsis "%LOCALAPPDATA%\NSIS"
call :try_nsis "%APPDATA%\NSIS"
call :try_nsis "%ProgramData%\chocolatey\bin"
call :try_nsis "%USERPROFILE%\scoop\shims"
call :try_nsis "%LOCALAPPDATA%\Microsoft\WinGet\Links"
call :try_nsis "%SystemDrive%\NSIS"
call :try_nsis "C:\Program Files (x86)\NSIS"
call :try_nsis "C:\Program Files\NSIS"
call :try_nsis "D:\Program Files (x86)\NSIS"
call :try_nsis "D:\Program Files\NSIS"
if defined MAKENSIS exit /b 0
call :nsis_from_registry "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\NSIS"
if defined MAKENSIS exit /b 0
call :nsis_from_registry "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\NSIS"
if defined MAKENSIS exit /b 0
call :nsis_from_registry "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\NSIS"
exit /b 0

:try_nsis
if defined MAKENSIS exit /b 0
if "%~1"=="" exit /b 0
if exist "%~1\makensis.exe" set "MAKENSIS=%~1\makensis.exe"
exit /b 0

:nsis_from_registry
if defined MAKENSIS exit /b 0
for /f "tokens=2,*" %%A in ('reg query "%~1" /v InstallLocation 2^>nul ^| findstr /i "InstallLocation"') do call :try_nsis "%%~B"
exit /b 0
