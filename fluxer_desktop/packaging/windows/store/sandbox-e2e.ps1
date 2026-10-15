# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs inside Windows Sandbox (sandbox-e2e.wsb). Installs the self-signed sanalyer MSIX and records each check
# in C:\sanalyer\sandbox-sonuc.txt. Toast click and the absence of an update prompt are checked by hand.
$ErrorActionPreference = 'Stop'
$dir = 'C:\sanalyer'
$report = Join-Path $dir 'sandbox-sonuc.txt'
Remove-Item $report -ErrorAction SilentlyContinue

function Step([string]$name, [scriptblock]$check) {
	try {
		$line = if (& $check) { "PASS $name" } else { "FAIL $name" }
	} catch {
		$line = "FAIL $name : $_"
	}
	$line | Tee-Object -FilePath $report -Append
}

Import-Certificate -FilePath (Join-Path $dir 'sanalyer-msix-test.cer') -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
$msix = Get-ChildItem $dir -Filter '*.msix' | Select-Object -First 1

Step 'install' { Add-AppxPackage -Path $msix.FullName; $true }
$package = Get-AppxPackage | Where-Object { $_.InstallLocation -and (Test-Path (Join-Path $_.InstallLocation 'app\sanalyer.exe')) }
$manifest = Get-AppxPackageManifest $package
$appId = $manifest.Package.Applications.Application.Id
Step 'store version ends in .0' { $package.Version -match '^\d+\.\d+\.\d+\.0$' }
Step 'manifest declares sanalyer://' { $manifest.OuterXml -match '<uap:Protocol Name="sanalyer"' }
Step 'manifest startup task is off by default' { $manifest.OuterXml -match 'TaskId="SanalyerStartup" Enabled="false"' }

Start-Process "shell:AppsFolder\$($package.PackageFamilyName)!$appId"
$deadline = (Get-Date).AddSeconds(60)
do {
	Start-Sleep -Seconds 2
	$running = Get-Process -Name 'sanalyer' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$($package.InstallLocation)*" }
} until ($running -or (Get-Date) -gt $deadline)
Step 'app starts from the package' { [bool]$running }

Start-Process 'sanalyer://invite/x'
Start-Sleep -Seconds 5
Step 'sanalyer://invite/x keeps the packaged app as the handler' {
	@(Get-Process -Name 'sanalyer' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$($package.InstallLocation)*" }).Count -ge 1
}

# Velopack, Run-key autostart and protocol registration being off in the package is covered by
# src/main/WindowsStore.test.mjs; MSIX virtualizes those writes, so the sandbox cannot observe them.
'MANUAL sanalyer://invite/x opened the invite screen' | Tee-Object -FilePath $report -Append
'MANUAL clicking a notification brings sanalyer to the front' | Tee-Object -FilePath $report -Append
'MANUAL Settings > check for updates shows no in-app update prompt' | Tee-Object -FilePath $report -Append

$appcert = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\App Certification Kit\appcert.exe'
if (Test-Path $appcert) {
	& $appcert test -appxpackagepath $msix.FullName -reportoutputpath (Join-Path $dir 'wack.xml')
	Step 'WACK' { (Select-String -Path (Join-Path $dir 'wack.xml') -Pattern 'OVERALL_RESULT="PASS"' -Quiet) }
} else {
	"SKIP WACK: appcert.exe not in the sandbox; on the host (admin): appcert.exe test -appxpackagepath <msix> -reportoutputpath wack.xml" |
		Tee-Object -FilePath $report -Append
}
