; SPDX-License-Identifier: AGPL-3.0-or-later
; Micup 1.0.0 bridge: moves Micup v1 (electron-builder NSIS) installs onto Micup v2 (Velopack).
; Published once on EphaX/micup-releases; v1's electron-updater runs it as "--updated /S --force-run".
; Always install v2 first and remove v1 only after v2 is on disk, so a failed v2 install leaves v1 working.
; v1 is per-user (HKCU) or, when "all users" was picked in its installer, per-machine (HKLM, 64- or 32-bit view);
; a per-machine v1 is removed through UAC. A v1 that stays is reported once and its update channel is closed
; (V1_UPDATER_ID), so it does not run the bridge again on every start.
; Log: %TEMP%\micup-bridge.log (Velopack's own log: %TEMP%\micup-bridge-velopack.log).
; Exit code: 0 v2 installed and no v1 left, 1 v2 not installed (v1 untouched), 2 v2 installed but v1 still installed.
Unicode true

!ifndef SETUP_EXE
	!error "Pass /DSETUP_EXE=<path to the Velopack Micup-win-Setup.exe>"
!endif
!ifndef OUT_FILE
	!define OUT_FILE "Micup-Setup-1.0.0-x64.exe"
!endif
!define V1_GUID "23f9d4a0-f5b8-519e-985d-0d53839c95e1"
!define UNINSTALL_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!define V2_ROOT "$LOCALAPPDATA\micup_desktop"
!define LINK_NAME "Micup.lnk"
; v1's Electron userData. electron-updater keeps its staged-rollout id there in .updaterId; latest.yml ships
; stagingPercentage: 100 and this id scores 0xffffffff / 0xffffffff = 1, which is never below 1, so v1 stops
; offering 1.0.0 to this Windows user. The same file tells a later bridge run that it already asked.
!define V1_USER_DATA "$APPDATA\Micup"
!define V1_UPDATER_ID "00000000-0000-4000-8000-0000ffffffff"

!include LogicLib.nsh
!include FileFunc.nsh

Name "Micup"
OutFile "${OUT_FILE}"
Icon "..\..\..\build_resources\icons-stable\icon.ico"
RequestExecutionLevel user
SilentInstall silent
VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "Micup"
VIAddVersionKey "FileDescription" "Micup"
VIAddVersionKey "FileVersion" "1.0.0"
VIAddVersionKey "ProductVersion" "1.0.0"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 Fluxer Platform AB and Micup"

Var log
Var v1Key
Var v1Name
Var v1LeftNow
Var hadDesktopLink
Var hadStartMenuLink

!macro Log text
	FileWrite $log "${text}$\r$\n"
!macroend

; Sets $v1Key (empty when absent) and $v1Name from v1's uninstall entry under ROOT in the VIEW-bit registry view.
!macro FindV1In ROOT VIEW
	SetRegView ${VIEW}
	StrCpy $v1Key ""
	ReadRegStr $0 ${ROOT} "${UNINSTALL_ROOT}\{${V1_GUID}}" "UninstallString"
	${If} $0 != ""
		StrCpy $v1Key "${UNINSTALL_ROOT}\{${V1_GUID}}"
	${Else}
		ReadRegStr $0 ${ROOT} "${UNINSTALL_ROOT}\${V1_GUID}" "UninstallString"
		${If} $0 != ""
			StrCpy $v1Key "${UNINSTALL_ROOT}\${V1_GUID}"
		${EndIf}
	${EndIf}
	${If} $v1Key != ""
		ReadRegStr $v1Name ${ROOT} "$v1Key" "DisplayName"
	${EndIf}
!macroend

; Runs v1's uninstaller found under ROOT/VIEW and waits for its entry to go. A per-machine one needs UAC.
!macro RemoveV1From ROOT VIEW
	!insertmacro FindV1In ${ROOT} ${VIEW}
	${If} $v1Key != ""
		ReadRegStr $1 ${ROOT} "$v1Key" "UninstallString"
		!insertmacro Log "removing v1 (${ROOT} ${VIEW}-bit $v1Key): $1 /S"
		ClearErrors
		${If} ${ROOT} == HKLM
			Call SplitUninstallString
			ExecShellWait "runas" "$1" "$2 /S"
			StrCpy $0 "elevated"
		${Else}
			ExecWait '$1 /S' $0
		${EndIf}
		${If} ${Errors}
			; ShellExecute fails with ERROR_CANCELLED when the user answers No on the UAC prompt.
			!insertmacro Log "v1 uninstaller did not start (UAC refused?)"
		${Else}
			; An NSIS uninstaller re-launches itself from %TEMP% and returns at once; wait for its entry to go (max 120 s).
			StrCpy $2 0
			${Do}
				ReadRegStr $3 ${ROOT} "$v1Key" "UninstallString"
				${If} $3 == ""
					${Break}
				${EndIf}
				Sleep 500
				IntOp $2 $2 + 1
			${LoopUntil} $2 >= 240
			!insertmacro Log "v1 uninstaller exit code: $0, entry still present: $3"
		${EndIf}
	${EndIf}
!macroend

Function FindV1
	!insertmacro FindV1In HKCU 64
	${IfThen} $v1Key != "" ${|} Return ${|}
	!insertmacro FindV1In HKLM 64
	${IfThen} $v1Key != "" ${|} Return ${|}
	!insertmacro FindV1In HKLM 32
FunctionEnd

; Splits $1, e.g. "C:\Program Files\Micup\Uninstall Micup.exe" /allusers, into $1 (program) and $2 (arguments).
; TEMPORARY: an unquoted program path with spaces is taken whole; electron-builder always quotes it.
Function SplitUninstallString
	StrCpy $2 ""
	StrCpy $3 $1 1
	${If} $3 == '"'
		StrCpy $4 1
		${Do}
			StrCpy $3 $1 1 $4
			${If} $3 == '"'
			${OrIf} $3 == ""
				${Break}
			${EndIf}
			IntOp $4 $4 + 1
		${Loop}
		IntOp $5 $4 + 1
		StrCpy $2 $1 "" $5
		IntOp $4 $4 - 1
		StrCpy $1 $1 $4 1
	${EndIf}
FunctionEnd

Section
	FileOpen $log "$TEMP\micup-bridge.log" a
	FileSeek $log 0 END
	${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
	${GetParameters} $7
	!insertmacro Log "$2-$1-$0 $4:$5:$6 bridge 1.0.0 args: $7"

	InitPluginsDir
	File "/oname=$PLUGINSDIR\Micup-win-Setup.exe" "${SETUP_EXE}"
	ClearErrors
	ExecWait '"$PLUGINSDIR\Micup-win-Setup.exe" --silent --log "$TEMP\micup-bridge-velopack.log"' $0
	${If} ${Errors}
		StrCpy $0 "not started"
	${EndIf}
	!insertmacro Log "v2 setup exit code: $0"
	${IfNot} ${FileExists} "${V2_ROOT}\current\Micup.exe"
		!insertmacro Log "v2 is not installed; v1 left untouched"
		FileClose $log
		SetErrorLevel 1
		Quit
	${EndIf}

	StrCpy $v1LeftNow 0
	Call FindV1
	${If} $v1Key == ""
		!insertmacro Log "no v1 uninstall entry found"
	${Else}
		StrCpy $1 ""
		ClearErrors
		FileOpen $0 "${V1_USER_DATA}\.updaterId" r
		${IfNot} ${Errors}
			FileRead $0 $1
			FileClose $0
		${EndIf}
		${If} $1 == "${V1_UPDATER_ID}"
			!insertmacro Log "v1 ($v1Name) was left installed by an earlier run, which already told the user; not asking again"
		${Else}
			StrCpy $hadDesktopLink 0
			${If} ${FileExists} "$DESKTOP\${LINK_NAME}"
				StrCpy $hadDesktopLink 1
			${EndIf}
			StrCpy $hadStartMenuLink 0
			${If} ${FileExists} "$SMPROGRAMS\${LINK_NAME}"
				StrCpy $hadStartMenuLink 1
			${EndIf}
			!insertmacro RemoveV1From HKCU 64
			!insertmacro RemoveV1From HKLM 64
			!insertmacro RemoveV1From HKLM 32
			; v1 and v2 shortcuts share a name, so v1's uninstaller may have taken v2's; v2 rewrites them on first start.
			${If} $hadDesktopLink == 1
			${AndIfNot} ${FileExists} "$DESKTOP\${LINK_NAME}"
				CreateShortCut "$DESKTOP\${LINK_NAME}" "${V2_ROOT}\Micup.exe"
				!insertmacro Log "restored desktop shortcut"
			${EndIf}
			${If} $hadStartMenuLink == 1
			${AndIfNot} ${FileExists} "$SMPROGRAMS\${LINK_NAME}"
				CreateShortCut "$SMPROGRAMS\${LINK_NAME}" "${V2_ROOT}\Micup.exe"
				!insertmacro Log "restored start menu shortcut"
			${EndIf}
			; v1 counts as gone only when no uninstall entry is left in any location.
			Call FindV1
			${If} $v1Key == ""
				!insertmacro Log "v1 removed"
			${Else}
				CreateDirectory "${V1_USER_DATA}"
				FileOpen $0 "${V1_USER_DATA}\.updaterId" w
				FileWrite $0 "${V1_UPDATER_ID}"
				FileClose $0
				!insertmacro Log "v1 ($v1Name) is still installed; closed its update channel"
				StrCpy $v1LeftNow 1
			${EndIf}
		${EndIf}
	${EndIf}

	; v2 registers micup:// again on its first start.
	Exec '"${V2_ROOT}\Micup.exe"'
	!insertmacro Log "started v2"
	${If} $v1LeftNow == 1
		${If} $v1Name == ""
			StrCpy $v1Name "Micup"
		${EndIf}
		MessageBox MB_OK|MB_ICONINFORMATION|MB_TOPMOST|MB_SETFOREGROUND "Yeni Micup kuruldu ve açılıyor.$\r$\n$\r$\nEski Micup ($v1Name) bu bilgisayardan kaldırılamadı. Bilgisayardaki tüm kullanıcılar için kurulduysa kaldırmak yönetici izni ister.$\r$\n$\r$\nEski sürümü Ayarlar > Uygulamalar > Yüklü uygulamalar bölümünden kaldırın."
	${EndIf}
	${If} $v1Key != ""
		SetErrorLevel 2
	${EndIf}
	FileClose $log
SectionEnd
