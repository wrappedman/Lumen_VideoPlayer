; ===========================================================================
;  Lumen — Windows installer (NSIS)
;  Rendered by tools/build-installer.js — the @@…@@ placeholders below are
;  substituted before makensis runs. Solid LZMA keeps the download small
;  (~40% under a plain zip of the same portable folder).
; ===========================================================================

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "Sections.nsh"

!define APP_NAME      "Lumen"
!define APP_VERSION   "1.0.0"
!define APP_PUBLISHER "Behnam Ehsani"
!define APP_EXE       "Lumen.exe"
!define APP_ID        "Lumen"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "@@OUTFILE@@"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
RequestExecutionLevel user          ; no admin prompt, installs per-user

; /PORTABLE  -> extract only: no shortcuts, no registry, no uninstaller
; /desktop   -> force the (optional) desktop shortcut on
Var PortableMode
ShowInstDetails hide
ShowUninstDetails hide

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName"      "${APP_NAME}"
VIAddVersionKey "ProductVersion"   "${APP_VERSION}"
VIAddVersionKey "FileDescription"  "${APP_NAME} — Liquid Glass Player"
VIAddVersionKey "FileVersion"      "${APP_VERSION}"
VIAddVersionKey "CompanyName"      "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright"   "© ${APP_PUBLISHER}"

!define MUI_ABORTWARNING
!define MUI_ICON   "@@ICON@@"
!define MUI_UNICON "@@ICON@@"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Run ${APP_NAME}"
!define MUI_FINISHPAGE_TEXT "${APP_NAME} was installed.$\r$\n$\r$\nThe FFmpeg/ffprobe media engine is bundled: HEVC/x265 and many other codecs work without a separate codec pack."
!define MUI_WELCOMEPAGE_TEXT "This wizard installs ${APP_NAME} ${APP_VERSION} for the current user only — no administrator rights needed.$\r$\n$\r$\nOn the next page you can tick a shortcut for your Desktop; it is optional and OFF by default.$\r$\n$\r$\nFFmpeg + ffprobe are included. MKV, HEVC/x265, DTS, AC-3 and many other formats are handled by the bundled media engine."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS          ; <- the optional desktop shortcut
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"


; ---------------------------------------------------------------- install
Section "Lumen (required)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on
  ; never pack a previous installer or the build script into the new one
  File /r /x "Lumen-Setup-*.exe" /x "*.nsi" /x "READ-ME.txt" "@@PAYLOAD@@\*.*"

  ; ---- portable mode:  Lumen-Setup.exe /PORTABLE /D=D:\Apps\Lumen
  ;      extracts only — no shortcuts, no registry, no uninstaller.
  ;      (${GetOptions} raises the error flag when the switch is absent.)
  ${If} $PortableMode == 1
    SetDetailsPrint none
    Goto done
  ${EndIf}

  ; shortcuts
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  ; uninstaller + registry (per-user, no admin)
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_ID}" "Version" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1

  ; optional: associate the file types Lumen opens best (user can change it)
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXE}" "FriendlyAppName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXE}\shell\open\command" "" '"$INSTDIR\${APP_EXE}" "%1"'
  done:
SectionEnd

; Optional, UNTICKED by default (/o = not selected). The user ticks it on the
; components page if they want a Desktop shortcut; /desktop forces it on.
Section /o "Desktop shortcut (optional)" SecDesktop
  ${If} $PortableMode == 1
    Abort
  ${EndIf}
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\${APP_EXE}" 0
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "Lumen itself — required. Installs into your own user folder (no administrator rights)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Optional: put a Lumen shortcut on your Desktop. Leave it unticked if you do not want one."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ------------------------------------------------------------- command line
Function .onInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/PORTABLE" $R2
  ${IfNot} ${Errors}
    StrCpy $PortableMode 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/desktop" $R1
  ${IfNot} ${Errors}
    ; force the optional desktop-shortcut box on (it is off by default)
    SectionGetFlags ${SecDesktop} $0
    IntOp $0 $0 | ${SF_SELECTED}
    SectionSetFlags ${SecDesktop} $0
  ${EndIf}
FunctionEnd

; -------------------------------------------------------------- uninstall
Section "Uninstall"
  ; settings live in %APPDATA%\Lumen — ask before touching them
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your settings, playlist and resume positions?" IDNO keep
    RMDir /r "$APPDATA\Lumen"
  keep:

  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$DESKTOP\${APP_NAME}.lnk"

  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\${APP_ID}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXE}"
SectionEnd
