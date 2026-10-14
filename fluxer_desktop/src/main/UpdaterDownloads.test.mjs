// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

function transform(name) {
	const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
	return {
		path,
		code: esbuild.transformSync(readFileSync(path, 'utf8'), {
			loader: 'ts',
			format: 'cjs',
			platform: 'node',
			target: 'node20',
		}).code,
	};
}

const {path: sourcePath, code: transformedSource} = transform('UpdaterDownloads.ts');
const shellDownloadFormatsSource = transform('ShellDownloadFormats.ts');

const APPIMAGE_SHA256 = 'a'.repeat(64);
const DEB_SHA256 = 'b'.repeat(64);
const TAR_GZ_SHA256 = 'c'.repeat(64);

function loadUpdaterDownloads({channel = 'stable', platform = 'linux', arch = 'x64'} = {}) {
	const stubs = {};
	function requireStub(specifier) {
		if (specifier in stubs) return stubs[specifier];
		if (specifier === '@electron/common/BuildChannel') return {BUILD_CHANNEL: channel};
		if (specifier === '@electron/common/Constants') {
			return {
				DOWNLOAD_PAGE_URLS: {
					stable: 'https://micup.gg/indir',
					canary: 'https://canary.micup.gg/indir',
					development: 'http://localhost:8088/download',
				},
			};
		}
		if (specifier === '@electron/common/DesktopIdentity') {
			const names = {stable: 'Micup', canary: 'Micup-Canary', development: 'Micup-Development'};
			return {DESKTOP_ARTIFACT_PRODUCT_NAME: names[channel]};
		}
		throw new Error(`Unexpected import: ${specifier}`);
	}

	function evaluate({path, code}) {
		const module = {exports: {}};
		const context = vm.createContext({
			require: requireStub,
			module,
			exports: module.exports,
			process: {platform, arch},
		});
		vm.runInContext(code, context, {filename: path});
		return module.exports;
	}

	const shellDownloadFormats = evaluate(shellDownloadFormatsSource);
	stubs['@electron/main/ShellDownloadFormats'] = shellDownloadFormats;
	return evaluate({path: sourcePath, code: transformedSource});
}

function latestInfo(version, files = {}) {
	return {version, pubDate: null, files};
}

describe('UpdaterDownloads platform feeds', () => {
	for (const channel of ['stable', 'canary']) {
		for (const [platform, arch, format] of [
			['darwin', 'arm64', 'dmg'],
			['darwin', 'x64', 'zip'],
			['linux', 'x64', 'appimage'],
		]) {
			test(`uses the Micup ${channel} feed for ${platform}/${arch}`, () => {
				const downloads = loadUpdaterDownloads({channel, platform, arch});
				const baseUrl = `https://dl.micup.gg/desktop/${channel}/${platform}/${arch}`;
				assert.equal(downloads.UPDATE_BASE_URL, baseUrl);
				assert.equal(downloads.buildManualVersionDownloadUrl('1.0.1', format), `${baseUrl}/1.0.1/${format}`);
			});
		}
	}
});

describe('UpdaterDownloads Linux manual update options', () => {
	test('pins every format to the version its name and checksum describe', () => {
		const {getManualDownloadOptions} = loadUpdaterDownloads();
		const info = latestInfo('2026.910.101500', {
			appimage: {
				url: 'https://web.fluxer.app/api/dl/desktop/stable/linux/x64/2026.910.101500/appimage',
				sha256: APPIMAGE_SHA256,
			},
			deb: {url: 'https://web.fluxer.app/api/dl/desktop/stable/linux/x64/2026.910.101500/deb', sha256: DEB_SHA256},
			tar_gz: {
				url: 'https://web.fluxer.app/api/dl/desktop/stable/linux/x64/2026.910.101500/tar_gz',
				sha256: TAR_GZ_SHA256,
			},
		});

		assert.deepEqual(structuredClone(getManualDownloadOptions(info)), [
			{
				format: 'appimage',
				label: 'AppImage',
				url: 'https://dl.micup.gg/desktop/stable/linux/x64/2026.910.101500/appimage',
				suggestedName: 'Micup-2026.910.101500-linux-x86_64.AppImage',
				sha256: APPIMAGE_SHA256,
			},
			{
				format: 'deb',
				label: 'DEB package',
				url: 'https://dl.micup.gg/desktop/stable/linux/x64/2026.910.101500/deb',
				suggestedName: 'Micup-2026.910.101500-linux-amd64.deb',
				sha256: DEB_SHA256,
			},
			{
				format: 'rpm',
				label: 'RPM package',
				url: 'https://dl.micup.gg/desktop/stable/linux/x64/2026.910.101500/rpm',
				suggestedName: 'Micup-2026.910.101500-linux-x86_64.rpm',
				sha256: null,
			},
			{
				format: 'tar_gz',
				label: 'tar.gz archive',
				url: 'https://dl.micup.gg/desktop/stable/linux/x64/2026.910.101500/tar_gz',
				suggestedName: 'Micup-2026.910.101500-linux-x64.tar.gz',
				sha256: TAR_GZ_SHA256,
			},
		]);
	});

	test('uses arm64 architecture tokens in every url and name', () => {
		const {getManualDownloadOptions} = loadUpdaterDownloads({arch: 'arm64'});
		const options = structuredClone(getManualDownloadOptions(latestInfo('2026.910.101500')));

		assert.deepEqual(
			options.map((option) => [option.url, option.suggestedName]),
			[
				[
					'https://dl.micup.gg/desktop/stable/linux/arm64/2026.910.101500/appimage',
					'Micup-2026.910.101500-linux-arm64.AppImage',
				],
				['https://dl.micup.gg/desktop/stable/linux/arm64/2026.910.101500/deb', 'Micup-2026.910.101500-linux-arm64.deb'],
				[
					'https://dl.micup.gg/desktop/stable/linux/arm64/2026.910.101500/rpm',
					'Micup-2026.910.101500-linux-aarch64.rpm',
				],
				[
					'https://dl.micup.gg/desktop/stable/linux/arm64/2026.910.101500/tar_gz',
					'Micup-2026.910.101500-linux-arm64.tar.gz',
				],
			],
		);
	});

	test('names canary and stable artefacts after their own product and origin', () => {
		const info = latestInfo('2026.910.101500');
		const stableDeb = structuredClone(loadUpdaterDownloads({channel: 'stable'}).getManualDownloadOptions(info)).find(
			(option) => option.format === 'deb',
		);
		const canaryDeb = structuredClone(loadUpdaterDownloads({channel: 'canary'}).getManualDownloadOptions(info)).find(
			(option) => option.format === 'deb',
		);

		assert.equal(stableDeb.url, 'https://dl.micup.gg/desktop/stable/linux/x64/2026.910.101500/deb');
		assert.equal(stableDeb.suggestedName, 'Micup-2026.910.101500-linux-amd64.deb');
		assert.equal(canaryDeb.url, 'https://dl.micup.gg/desktop/canary/linux/x64/2026.910.101500/deb');
		assert.equal(canaryDeb.suggestedName, 'Micup-Canary-2026.910.101500-linux-amd64.deb');
	});

	test('only ever fetches 2026.908.173325 for a prompt built from that release', () => {
		const {getManualDownloadOptions, getManualDownloadUrl} = loadUpdaterDownloads({channel: 'canary'});
		const info = latestInfo('2026.908.173325', {
			deb: {
				url: 'https://web.canary.fluxer.app/api/dl/desktop/canary/linux/x64/2026.908.173325/deb',
				sha256: DEB_SHA256,
			},
		});
		const options = structuredClone(getManualDownloadOptions(info));
		const deb = options.find((option) => option.format === 'deb');

		assert.equal(deb.suggestedName, 'Micup-Canary-2026.908.173325-linux-amd64.deb');
		assert.equal(deb.url, 'https://dl.micup.gg/desktop/canary/linux/x64/2026.908.173325/deb');
		assert.equal(deb.sha256, DEB_SHA256);
		assert.equal(options.length, 4);
		for (const option of options) {
			const [format, version] = new URL(option.url).pathname.split('/').reverse();
			assert.equal(format, option.format);
			assert.equal(version, '2026.908.173325');
			assert.match(option.suggestedName, /^Micup-Canary-2026\.908\.173325-linux-/);
		}
		assert.equal(getManualDownloadUrl(info), 'https://dl.micup.gg/desktop/canary/linux/x64/2026.908.173325/appimage');
	});
});

describe('UpdaterDownloads manual download url', () => {
	test('prefers the pinned Linux option over the response file urls', () => {
		const {getManualDownloadUrl} = loadUpdaterDownloads();
		const info = latestInfo('2026.910.101500', {
			appimage: {
				url: 'https://web.fluxer.app/api/dl/desktop/stable/linux/x64/2026.910.101500/appimage',
				sha256: null,
			},
		});

		assert.equal(getManualDownloadUrl(info), 'https://dl.micup.gg/desktop/stable/linux/x64/2026.910.101500/appimage');
	});

	test('falls back to the response file urls in format order on macOS', () => {
		const {getManualDownloadOptions, getManualDownloadUrl} = loadUpdaterDownloads({platform: 'darwin', arch: 'arm64'});
		const dmg = {url: 'https://web.fluxer.app/api/dl/desktop/stable/darwin/arm64/2026.910.101500/dmg', sha256: null};
		const zip = {url: 'https://web.fluxer.app/api/dl/desktop/stable/darwin/arm64/2026.910.101500/zip', sha256: null};

		assert.equal(getManualDownloadOptions(latestInfo('2026.910.101500', {dmg, zip})).length, 0);
		assert.equal(getManualDownloadUrl(latestInfo('2026.910.101500', {zip, dmg})), dmg.url);
		assert.equal(getManualDownloadUrl(latestInfo('2026.910.101500', {zip})), zip.url);
	});

	test('falls back to the setup file url on Windows', () => {
		const {getManualDownloadOptions, getManualDownloadUrl} = loadUpdaterDownloads({platform: 'win32'});
		const setup = {url: 'https://web.fluxer.app/api/dl/desktop/stable/win32/x64/2026.910.101500/setup', sha256: null};

		assert.equal(getManualDownloadOptions(latestInfo('2026.910.101500', {setup})).length, 0);
		assert.equal(getManualDownloadUrl(latestInfo('2026.910.101500', {setup})), setup.url);
	});

	test('falls back to the download page when no file resolves', () => {
		const stable = loadUpdaterDownloads({channel: 'stable', platform: 'darwin'});
		const canary = loadUpdaterDownloads({channel: 'canary', platform: 'win32'});

		assert.equal(stable.getManualDownloadUrl(latestInfo('2026.910.101500')), 'https://micup.gg/indir');
		assert.equal(canary.getManualDownloadUrl(latestInfo('2026.910.101500')), 'https://canary.micup.gg/indir');
	});
});
