// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const BRIDGE_NAME = 'Micup-Setup-1.0.0-x64.exe';
const buildScript = fileURLToPath(new URL('./build-bridge.ps1', import.meta.url));
const bridgeScript = readFileSync(new URL('./bridge.nsi', import.meta.url), 'utf8');

function field(yml, key) {
	return yml.match(new RegExp(`^${key}: ?(.*)$`, 'm'))?.[1];
}

test('latest.yml announces the 1.0.0 bridge to v1 electron-updater clients', {
	skip: process.platform !== 'win32' && 'the bridge is an NSIS installer built on Windows',
}, () => {
	const work = mkdtempSync(path.join(tmpdir(), 'micup-bridge-test-'));
	const fakeSetup = path.join(work, 'Micup-win-Setup.exe');
	writeFileSync(fakeSetup, randomBytes(4096));
	const outDir = path.join(work, 'out');

	execFileSync(
		'powershell.exe',
		['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', buildScript, '-SetupExe', fakeSetup, '-OutDir', outDir],
		{stdio: 'pipe'},
	);

	const bridge = path.join(outDir, BRIDGE_NAME);
	const sha512 = createHash('sha512').update(readFileSync(bridge)).digest('base64');
	const size = statSync(bridge).size;
	const yml = readFileSync(path.join(outDir, 'latest.yml'), 'utf8');

	assert.equal(yml.charCodeAt(0) === 0xfeff, false);
	assert.equal(field(yml, 'version'), '1.0.0');
	assert.equal(field(yml, 'path'), BRIDGE_NAME);
	assert.equal(field(yml, 'sha512'), sha512);
	assert.equal(field(yml, 'stagingPercentage'), '100');
	assert.match(
		yml,
		new RegExp(
			`^files:\\n {2}- url: ${BRIDGE_NAME}\\n {4}sha512: ${sha512.replace(/[+/]/g, '\\$&')}\\n {4}size: ${size}$`,
			'm',
		),
	);
	assert.equal(Number.isNaN(Date.parse(field(yml, 'releaseDate').replace(/'/g, ''))), false);
});

test('a v1 the bridge could not remove stops offering the bridge again', () => {
	const updaterId = bridgeScript.match(/^!define V1_UPDATER_ID "(.*)"$/m)?.[1];
	// electron-updater: <userData>\.updaterId must pass UUID.check, then the user is inside a staged rollout only when
	// readUInt32BE(12) / 0xffffffff < stagingPercentage / 100.
	assert.match(updaterId, /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-([a-f0-9]{12})$/);
	assert.notEqual(updaterId, '00000000-0000-0000-0000-000000000000');
	assert.equal(Number.parseInt(updaterId.slice(-8), 16) / 0xffffffff < 100 / 100, false);
	assert.match(bridgeScript, /^!define V1_USER_DATA "\$APPDATA\\Micup"$/m);
});

test('the bridge looks for v1 per user and per machine in both registry views', () => {
	for (const location of ['HKCU 64', 'HKLM 64', 'HKLM 32']) {
		assert.match(bridgeScript, new RegExp(`^\\s*!insertmacro FindV1In ${location}$`, 'm'));
		assert.match(bridgeScript, new RegExp(`^\\s*!insertmacro RemoveV1From ${location}$`, 'm'));
	}
	assert.match(bridgeScript, /ExecShellWait "runas"/);
});
