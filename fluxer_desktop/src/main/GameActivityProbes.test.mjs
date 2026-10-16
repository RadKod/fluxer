// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const plain = (value) => JSON.parse(JSON.stringify(value));

function compile(relative, requireFn, extra = {}) {
	const path = fileURLToPath(new URL(relative, import.meta.url));
	const module = {exports: {}};
	vm.runInNewContext(
		esbuild.transformSync(readFileSync(path, 'utf8'), {loader: 'ts', format: 'cjs', target: 'node20'}).code,
		{module, exports: module.exports, Buffer, TextEncoder, require: requireFn, ...extra},
		{filename: path},
	);
	return module.exports;
}

function loadProbes({env = {}} = {}) {
	const spawned = [];
	const types = compile('../common/GameActivityTypes.ts', require);
	const probes = compile(
		'./GameActivityProbes.ts',
		(name) => {
			if (name === 'node:child_process')
				return {
					execFile: () => {
						spawned.push('execFile');
						throw new Error('Unexpected child process');
					},
				};
			if (name === 'node:fs/promises')
				return {
					readdir: async () => {
						throw new Error('Unexpected file system access');
					},
					readFile: async () => {
						throw new Error('Unexpected file system access');
					},
				};
			if (name === '@electron/common/GameActivityTypes') return types;
			throw new Error(`Unexpected import: ${name}`);
		},
		{process: {env}},
	);
	return {probes, spawned};
}

const {probes} = loadProbes();

test('darwin_ps_rows_become_lowercase_basenames_with_wine_exe_names', () => {
	const comm = [
		'    1 /sbin/launchd',
		'  410 /Applications/Spotify.app/Contents/MacOS/Spotify',
		'  411 /Applications/Euro Truck Simulator 2.app/Contents/MacOS/eurotrucks2',
		'  412 /Applications/Whisky.app/Contents/Resources/Libraries/Wine/bin/wine64-preloader',
		'  413 /usr/bin/grep',
		'  414 (zombie)',
		'garbage line',
	].join('\n');
	const args = [
		'    1 /sbin/launchd',
		'  410 /Applications/Spotify.app/Contents/MacOS/Spotify --autostart',
		'  411 /Applications/Euro Truck Simulator 2.app/Contents/MacOS/eurotrucks2 -nointro',
		'  412 C:\\Program Files (x86)\\Steam\\steamapps\\common\\Among Us\\Among Us.exe -screen-fullscreen 0',
		'  413 grep cs2.exe',
	].join('\n');
	assert.deepEqual(plain(probes.parseDarwinProcesses(comm, args)), [
		{exe: 'launchd', pid: 1},
		{exe: 'spotify', pid: 410},
		{exe: 'eurotrucks2', pid: 411},
		{exe: 'among us.exe', pid: 412},
		{exe: 'grep', pid: 413},
		{exe: '(zombie)', pid: 414},
	]);
});

test('linux_names_prefer_argv0_checked_against_comm', () => {
	const name = (cmdline, comm) =>
		probes.linuxProcessName(cmdline === null ? null : Buffer.from(cmdline), comm === null ? null : Buffer.from(comm));
	assert.equal(name('/usr/share/spotify/spotify\0--no-zygote\0', 'spotify\n'), 'spotify');
	assert.equal(
		name('/home/u/.steam/steam/steamapps/common/Stardew Valley/StardewValley\0', 'StardewValley\n'),
		'stardewvalley',
	);
	assert.equal(
		name('/home/u/.steam/steam/steamapps/common/Hollow Knight/hollow_knight.x86_64\0', 'hollow_knight.x\n'),
		'hollow_knight.x86_64',
	);
	assert.equal(
		name('Z:\\home\\u\\Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe\0', 'Cyberpunk2077.e\n'),
		'cyberpunk2077.exe',
	);
	assert.equal(name('/opt/google/chrome/chrome --type=renderer --lang=tr', 'chrome\n'), 'chrome');
	assert.equal(name('renamed-by-itself', 'factorio\n'), 'factorio');
	assert.equal(name(null, 'spotify\n'), 'spotify');
});

test('linux_listing_reads_proc_in_batches_and_skips_kernel_threads_and_gone_processes', async () => {
	const files = new Map([
		['/proc/1/cmdline', Buffer.from('/sbin/init\0')],
		['/proc/1/comm', Buffer.from('systemd\n')],
		['/proc/2/cmdline', Buffer.alloc(0)],
		['/proc/2/comm', Buffer.from('kthreadd\n')],
		['/proc/300/cmdline', Buffer.from('/usr/share/spotify/spotify\0')],
		['/proc/300/comm', Buffer.from('spotify\n')],
	]);
	const fs = {
		readdir: async (path) => {
			assert.equal(path, '/proc');
			return ['1', '2', '300', '301', 'self', 'cpuinfo'];
		},
		readFile: async (path) => {
			if (!files.has(path)) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
			return files.get(path);
		},
	};
	assert.deepEqual(plain(await probes.listLinuxProcesses(fs)), [
		{exe: 'systemd', pid: 1},
		{exe: 'spotify', pid: 300},
	]);
});
