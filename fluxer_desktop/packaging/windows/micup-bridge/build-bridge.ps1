# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the Micup 1.0.0 bridge around the Velopack Micup-win-Setup.exe and writes the
# electron-updater latest.yml that v1 clients read from EphaX/micup-releases. Publishing is a separate,
# approved step (O11); this script only produces files. stagingPercentage: 100 reaches every v1 user except those
# whose .updaterId the bridge set after it could not remove their v1 (see V1_UPDATER_ID in bridge.nsi).
param(
	[Parameter(Mandatory = $true)][string]$SetupExe,
	[string]$OutDir = (Join-Path $PSScriptRoot '..\..\..\dist-electron\micup-bridge'),
	[string]$MakeNsis
)
$ErrorActionPreference = 'Stop'
$version = '1.0.0'
$bridgeName = "Micup-Setup-$version-x64.exe"

if (-not $MakeNsis) {
	$candidates = @('E:\tools\nsis\makensis.exe') +
		@(Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\nsis-*\*\makensis.exe" -ErrorAction SilentlyContinue | ForEach-Object FullName)
	$MakeNsis = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $MakeNsis) { throw 'makensis.exe not found: pass -MakeNsis, or unpack NSIS to E:\tools\nsis' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$bridge = Join-Path (Resolve-Path $OutDir).Path $bridgeName
& $MakeNsis /V2 /INPUTCHARSET UTF8 "/DSETUP_EXE=$((Resolve-Path $SetupExe).Path)" "/DOUT_FILE=$bridge" (Join-Path $PSScriptRoot 'bridge.nsi')
if ($LASTEXITCODE -ne 0) { throw "makensis failed with exit code $LASTEXITCODE" }

$bytes = [IO.File]::ReadAllBytes($bridge)
$sha512 = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($bytes))
$releaseDate = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
$yml = @(
	"version: $version"
	'files:'
	"  - url: $bridgeName"
	"    sha512: $sha512"
	"    size: $($bytes.Length)"
	"path: $bridgeName"
	"sha512: $sha512"
	"releaseDate: '$releaseDate'"
	'stagingPercentage: 100'
	''
) -join "`n"
[IO.File]::WriteAllText((Join-Path $OutDir 'latest.yml'), $yml, (New-Object Text.UTF8Encoding $false))
Write-Output "Bridge: $bridge"
