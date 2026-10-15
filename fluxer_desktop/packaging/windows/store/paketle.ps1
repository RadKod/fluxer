# SPDX-License-Identifier: AGPL-3.0-or-later
# Micup Microsoft Store (MSIX) package, built with the native modules (screen capture, passkeys).
# Needs the S20 toolchain (rustup + Visual Studio Build Tools C++) or Actions windows-latest.
#   Store build:  .\paketle.ps1 -Version 1.0.1            -> unsigned .msix for Partner Center (Store signs it)
#   Sandbox test: .\paketle.ps1 -Version 1.0.1 -TestSign  -> self-signed .msix + .cer copied next to sandbox-e2e.wsb's folder
param(
	[Parameter(Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
	[switch]$TestSign,
	[string]$SandboxDir = 'E:\sanalyer-sandbox\store'
)
$ErrorActionPreference = 'Stop'

if ($env:FLUXER_SKIP_NATIVE) {
	throw 'FLUXER_SKIP_NATIVE is forbidden: a package without screen capture and passkey modules must not ship.'
}

$desktop = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Push-Location $desktop
try {
	$env:ELECTRON_ARCH = 'x64'
	$msix = node -e "console.log(JSON.stringify(require('./electron-builder.config.cjs').msix))" | ConvertFrom-Json
	if (-not $TestSign -and "$($msix.identityName)$($msix.publisher)$($msix.publisherDisplayName)" -match 'DOLDUR') {
		throw 'Partner Center identity is still a placeholder (S17): fill msix.* in electron-builder.config.cjs and WINDOWS_STORE_IDENTITY_NAME in src/common/DesktopIdentity.ts.'
	}

	# pnpm runs with ignoreScripts, so the Electron binary is fetched explicitly for this build only.
	node node_modules/electron/install.js
	if ($LASTEXITCODE -ne 0) { throw 'electron install failed' }
	pnpm build
	if ($LASTEXITCODE -ne 0) { throw 'desktop build failed' }

	if ($TestSign) {
		$cert = New-SelfSignedCertificate -Type Custom -Subject $msix.publisher -KeyUsage DigitalSignature `
			-FriendlyName 'sanalyer MSIX sandbox test' -CertStoreLocation 'Cert:\CurrentUser\My' `
			-TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
		$pfx = Join-Path $env:TEMP 'sanalyer-msix-test.pfx'
		$password = [guid]::NewGuid().ToString()
		Export-PfxCertificate -Cert $cert -FilePath $pfx -Password (ConvertTo-SecureString $password -AsPlainText -Force) | Out-Null
		$env:CSC_LINK = $pfx
		$env:CSC_KEY_PASSWORD = $password
	}

	$env:VERSION = $Version
	pnpm exec electron-builder --config electron-builder.config.cjs --win msix --x64
	if ($LASTEXITCODE -ne 0) { throw 'electron-builder msix failed' }

	$unpacked = Join-Path $desktop 'dist-electron\win-unpacked\resources\app.asar.unpacked'
	$natives = Get-ChildItem -Path $unpacked -Recurse -Filter '*.node' | ForEach-Object FullName
	foreach ($module in 'webauthn', 'win-game-capture', 'win-process-loopback', 'win-toast', 'win-shell') {
		if (-not ($natives -match [regex]::Escape("@fluxer\$module\"))) { throw "native module missing from the package: @fluxer/$module" }
	}

	$package = Get-ChildItem (Join-Path $desktop 'dist-electron') -Filter "sanalyer-$Version-win-x64.msix" | Select-Object -First 1
	if (-not $package) { throw 'no .msix produced' }
	Write-Output "MSIX: $($package.FullName) ($Version.0)"

	if ($TestSign) {
		New-Item -ItemType Directory -Force -Path $SandboxDir | Out-Null
		Copy-Item $package.FullName, (Join-Path $PSScriptRoot 'sandbox-e2e.ps1') -Destination $SandboxDir -Force
		Export-Certificate -Cert $cert -FilePath (Join-Path $SandboxDir 'sanalyer-msix-test.cer') | Out-Null
		Write-Output "Sandbox folder ready: $SandboxDir (open sandbox-e2e.wsb)"
	}
} finally {
	if ($TestSign) {
		Remove-Item Env:CSC_LINK, Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
		Remove-Item (Join-Path $env:TEMP 'sanalyer-msix-test.pfx') -ErrorAction SilentlyContinue
		# The sandbox needs only the exported .cer; the signing key must not stay in the user's store.
		if ($cert) { Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -ErrorAction SilentlyContinue }
	}
	Pop-Location
}
