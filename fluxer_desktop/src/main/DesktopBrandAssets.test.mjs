// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const desktopRoot = fileURLToPath(new URL('../../', import.meta.url));
const resourceRoot = path.join(desktopRoot, 'build_resources');
const sourceHash = 'f80d9174a68dcdf418bb9f782c9f153da3eee3a2bd89597a13f3d282c19a51aa';
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const icnsSizes = {
	icp4: 16,
	icp5: 32,
	icp6: 64,
	ic07: 128,
	ic08: 256,
	ic09: 512,
	ic10: 1024,
	ic11: 32,
	ic12: 64,
	ic13: 256,
	ic14: 512,
};

function configFor(channel) {
	const module = {exports: {}};
	vm.runInNewContext(readFileSync(path.join(desktopRoot, 'electron-builder.config.cjs'), 'utf8'), {
		module,
		require,
		__dirname: desktopRoot,
		process: {
			env: {BUILD_CHANNEL: channel, ELECTRON_ARCH: 'x64'},
			argv: ['node', 'builder', '--linux'],
			platform: 'linux',
			arch: 'x64',
		},
	});
	return module.exports;
}

function identityFor(channel) {
	const module = {exports: {}};
	const code = require('esbuild').transformSync(
		readFileSync(path.join(desktopRoot, 'src/common/DesktopIdentity.ts'), 'utf8'),
		{loader: 'ts', format: 'cjs'},
	).code;
	vm.runInNewContext(code, {module, exports: module.exports, require: () => ({BUILD_CHANNEL: channel})});
	return module.exports;
}

for (const channel of ['stable', 'canary']) {
	const iconDir = `icons-${channel}`;
	const iconRoot = path.join(resourceRoot, iconDir);
	const id = channel === 'canary' ? 'sanalyer-canary' : 'sanalyer';
	test(`${channel} Flatpak wrapper launches the packaged Linux executable`, () => {
		const wrapperName = channel === 'canary' ? 'app.fluxer.FluxerCanary.sh' : 'app.fluxer.Fluxer.sh';
		const wrapper = readFileSync(path.join(desktopRoot, 'packaging/linux', wrapperName), 'utf8');
		assert.ok(wrapper.includes(`exec zypak-wrapper "/app/fluxer/${configFor(channel).extraMetadata.name}" "$@"`));
	});
	test(`${channel} Linux package, WM class, icon and protocol share sanalyer identity`, () => {
		const config = configFor(channel);
		assert.equal(config.extraMetadata.name, id);
		assert.equal(config.extraMetadata.desktopName, `${id}.desktop`);
		assert.equal(identityFor(channel).LINUX_DESKTOP_ENTRY_ID, id);
		for (const target of [config.linux, config.deb, config.rpm]) {
			assert.equal(target.desktop.entry.StartupWMClass, id);
			assert.equal(target.desktop.entry.Icon, id);
			assert.equal(target.desktop.entry.MimeType, 'x-scheme-handler/sanalyer;');
			assert.doesNotMatch(target.desktop.entry.Comment, /Fluxer/);
		}
		assert.equal(config.linux.icon, `build_resources/${iconDir}`);
		assert.equal(config.mac.icon, `build_resources/${iconDir}/_compiled/AppIcon.icns`);
		const icons = config.extraResources.find((resource) => resource.to === 'icons');
		for (const size of sizes.filter((size) => size <= 512)) assert.ok(icons.filter.includes(`${size}x${size}.png`));
		assert.ok(!icons.filter.some((file) => file.includes('Assets.car') || file.includes('.icon')));
	});

	test(`${channel} PNGs and complete ICNS use the approved sanalyer source`, () => {
		const source = readFileSync(path.join(iconRoot, '1024x1024.png'));
		assert.equal(createHash('sha256').update(source).digest('hex'), sourceHash);
		for (const size of sizes) {
			const png = readFileSync(path.join(iconRoot, `${size}x${size}.png`));
			assert.equal(png.readUInt32BE(16), size);
			assert.equal(png.readUInt32BE(20), size);
			assert.ok(
				png.equals(readFileSync(path.join(resourceRoot, 'icons-stable', `${size}x${size}.png`))),
				`${size}px differs from stable`,
			);
		}
		const icns = readFileSync(path.join(iconRoot, '_compiled/AppIcon.icns'));
		assert.equal(icns.toString('ascii', 0, 4), 'icns');
		assert.equal(icns.readUInt32BE(4), icns.length);
		const chunks = new Set();
		for (let offset = 8; offset < icns.length; ) {
			const type = icns.toString('ascii', offset, offset + 4);
			const length = icns.readUInt32BE(offset + 4);
			assert.ok(length > 8 && offset + length <= icns.length);
			assert.ok(type in icnsSizes, type);
			assert.ok(
				icns
					.subarray(offset + 8, offset + length)
					.equals(readFileSync(path.join(iconRoot, `${icnsSizes[type]}x${icnsSizes[type]}.png`))),
				`${type} differs from the sanalyer PNG`,
			);
			chunks.add(type);
			offset += length;
		}
		assert.deepEqual([...chunks].sort(), Object.keys(icnsSizes).sort());
		assert.equal(existsSync(path.join(iconRoot, '_compiled/Assets.car')), false);
		const svg = readFileSync(path.join(iconRoot, 'AppIcon.icon/Assets/Vector.svg'), 'utf8');
		const embedded = svg.match(/href="data:image\/png;base64,([^"]+)"/);
		assert.ok(embedded, 'the editable source must embed the actual sanalyer image');
		assert.ok(Buffer.from(embedded[1], 'base64').equals(source));
	});

	test(`${channel} runtime desktop entry installs sanalyer hicolor icons and sets the matching WM class`, () => {
		const writes = new Map();
		const copies = [];
		const protocols = [];
		const module = {exports: {}};
		const source = readFileSync(path.join(desktopRoot, 'src/main/LinuxDesktopEntry.ts'), 'utf8');
		const code = require('esbuild').transformSync(source, {loader: 'ts', format: 'cjs'}).code;
		const stubs = {
			'node:path': path.posix,
			'node:fs': {
				existsSync: (file) => file.startsWith('/resources/icons/') || writes.has(file),
				mkdirSync() {},
				copyFileSync: (from, to) => copies.push({from, to}),
				readFileSync(file) {
					if (writes.has(file)) return writes.get(file);
					throw new Error('ENOENT');
				},
				readdirSync: () => [],
				writeFileSync: (file, text) => writes.set(file, text),
				renameSync: (from, to) => {
					writes.set(to, writes.get(from));
					writes.delete(from);
				},
			},
			'node:child_process': {
				execFile(command, args, _options, callback) {
					if (command === 'xdg-mime') protocols.push(args[2].slice('x-scheme-handler/'.length));
					callback(null);
				},
			},
			'@electron/common/Constants': {APP_PROTOCOL: 'sanalyer'},
			'@electron/common/DesktopIdentity': identityFor(channel),
			'@electron/common/Logger': {createChildLogger: () => ({debug() {}, info() {}, warn() {}})},
			'@electron/main/JumpList': {TASK_ARG_PREFIX: '--fluxer-task='},
			'@electron/main/LinuxLaunchPath': {getStableLinuxLaunchPath: () => '/apps/sanalyer.AppImage'},
			'@electron/main/LinuxSandbox': {isFlatpakRuntime: () => false},
			'@electron/main/MainI18n': {getNativeLocale: () => 'en-US', t: (key) => key},
			electron: {
				app: {
					isPackaged: true,
					isDefaultProtocolClient: () => false,
					setAsDefaultProtocolClient: (scheme) => protocols.push(scheme),
				},
			},
		};
		vm.runInNewContext(code, {
			module,
			exports: module.exports,
			process: {
				platform: 'linux',
				resourcesPath: '/resources',
				pid: 1234,
				env: {XDG_DATA_HOME: '/data', CHROME_DESKTOP: `${id}.desktop`},
			},
			require: (specifier) => stubs[specifier] ?? require(specifier),
		});
		assert.equal(module.exports.ensureLinuxDesktopEntry(), true);
		const entry = writes.get(`/data/applications/${id}.desktop`);
		assert.ok(entry);
		assert.ok(entry.includes(`Icon=${id}\n`));
		assert.ok(entry.includes(`StartupWMClass=${id}\n`));
		assert.ok(entry.includes('MimeType=x-scheme-handler/sanalyer;\n'));
		assert.equal(copies.length, 8);
		for (const size of sizes.filter((size) => size <= 512)) {
			assert.ok(
				copies.some(
					({from, to}) =>
						from === `/resources/icons/${size}x${size}.png` &&
						to === `/data/icons/hicolor/${size}x${size}/apps/${id}.png`,
				),
			);
		}
		assert.deepEqual(protocols, ['sanalyer']);
	});
}
