// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const previousArch = process.env.ELECTRON_ARCH;
process.env.ELECTRON_ARCH = 'x64';
const config = require(join(desktopRoot, 'electron-builder.config.cjs'));
if (previousArch === undefined) delete process.env.ELECTRON_ARCH;
else process.env.ELECTRON_ARCH = previousArch;
const builderRequire = createRequire(require.resolve('electron-builder'));
const builderRoot = resolve(dirname(builderRequire.resolve('app-builder-lib')), '..');

test('borderless capture uses the MSIX template hook with no legacy AppX mutation', () => {
	assert.equal(config.msix.customManifestPath, 'packaging/windows/store/manifest.xml');
	assert.equal(config.appxManifestCreated, undefined);
	assert.equal(config.msix.capabilities, undefined);
});

test('custom manifest preserves upstream MSIX structure and adds only the required capability', () => {
	const upstream = readFileSync(join(builderRoot, 'templates/msix/appxmanifest.xml'), 'utf8');
	const custom = readFileSync(join(desktopRoot, config.msix.customManifestPath), 'utf8');
	const expected = upstream
		.replace(
			'   xmlns:uap10=',
			'   xmlns:uap11="http://schemas.microsoft.com/appx/manifest/uap/windows10/11"\n   xmlns:uap10=',
		)
		.replace('IgnorableNamespaces="uap10 desktop6"', 'IgnorableNamespaces="uap10 desktop6 uap11"')
		.replace(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder substitutes this literal macro.
			'${capabilities}',
			'<Capabilities>\n    <rescap:Capability Name="runFullTrust" />\n    <uap11:Capability Name="graphicsCaptureWithoutBorder" />\n  </Capabilities>',
		);
	assert.equal(custom.replaceAll('\r\n', '\n'), expected.replaceAll('\r\n', '\n'));
});

test('real MSIX expansion produces valid XML and preserves identity and extensions', {
	skip: process.platform !== 'win32',
}, async () => {
	const {default: MsixTarget} = await import(pathToFileURL(join(builderRoot, 'dist/targets/win/MsixTarget.js')).href);
	const {log} = await import(pathToFileURL(builderRequire.resolve('builder-util')).href);
	const previousLogStream = log.stream;
	const output = mkdtempSync(join(tmpdir(), 'sanalyer-manifest-'));
	try {
		log.stream = process.stderr;
		const packager = {
			getOptionsForTarget: () => config.msix,
			getResource: async (path) => join(desktopRoot, path),
			appDir: desktopRoot,
			config: {protocols: config.protocols},
			platformOptions: {},
			metadata: {dependencies: {}},
			appInfo: {
				productFilename: 'sanalyer',
				productName: 'sanalyer',
				name: 'sanalyer',
				description: 'sanalyer',
				getVersionInWeirdWindowsForm: () => '1.0.7.0',
			},
		};
		const manifest = join(output, 'AppxManifest.xml');
		await new MsixTarget(packager, output).writeManifest(manifest, 1, config.msix.publisher, []);
		const xml = readFileSync(manifest, 'utf8');
		assert.doesNotMatch(xml, /\$\{/);
		const result = JSON.parse(
			execFileSync(
				'powershell.exe',
				[
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					`$x = New-Object System.Xml.XmlDocument; $x.LoadXml([Console]::In.ReadToEnd()); $n = New-Object System.Xml.XmlNamespaceManager($x.NameTable); $n.AddNamespace('p', $x.DocumentElement.NamespaceURI); $n.AddNamespace('u11', 'http://schemas.microsoft.com/appx/manifest/uap/windows10/11'); $n.AddNamespace('d', 'http://schemas.microsoft.com/appx/manifest/desktop/windows10'); $n.AddNamespace('r', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities'); @{identity=$x.Package.Identity.Name; publisher=$x.Package.Identity.Publisher; min=$x.Package.Dependencies.TargetDeviceFamily.MinVersion; app=$x.Package.Applications.Application.Id; startup=$x.SelectSingleNode('//d:StartupTask',$n).TaskId; border=$x.SelectNodes('/p:Package/p:Capabilities/u11:Capability',$n).Count; fulltrust=$x.SelectNodes('/p:Package/p:Capabilities/r:Capability',$n).Count; ignorable=$x.Package.IgnorableNamespaces} | ConvertTo-Json -Compress`,
				],
				{input: xml, encoding: 'utf8'},
			),
		);
		assert.equal(result.identity, 'sanalyer.sanalyer');
		assert.equal(result.publisher, config.msix.publisher);
		assert.equal(result.min, '10.0.17763.0');
		assert.equal(result.app, 'sanalyer');
		assert.equal(result.startup, 'SanalyerStartup');
		assert.equal(result.border, 1);
		assert.equal(result.fulltrust, 1);
		assert.ok(result.ignorable.split(' ').includes('uap11'));
		assert.match(xml, /windows\.toastNotificationActivation/);
		assert.match(xml, /windows\.comServer/);
	} finally {
		log.stream = previousLogStream;
		rmSync(output, {recursive: true, force: true});
	}
});
