// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL, type BuildChannel} from '@electron/common/BuildChannel';

type DesktopDownloadArch = 'x64' | 'arm64';

function getDesktopDownloadArch(arch: NodeJS.Architecture): DesktopDownloadArch {
	return arch === 'arm64' ? 'arm64' : 'x64';
}

export const DESKTOP_DOWNLOAD_ARCH = getDesktopDownloadArch(process.arch);
const PACKAGE_ORIGIN_ENV = 'FLUXER_DESKTOP_PACKAGE_ORIGIN';
const CHANNEL_PACKAGE_ORIGINS: Record<BuildChannel, string> = {
	stable: 'https://dl.sanalyer.com',
	canary: 'https://dl.sanalyer.com',
	development: 'http://127.0.0.1:48780',
};

export const DESKTOP_PACKAGE_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isUsablePackageOrigin(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return url.protocol === 'https:' || (url.protocol === 'http:' && DESKTOP_PACKAGE_LOOPBACK_HOSTS.has(url.hostname));
}

export function resolveDesktopPackageOrigin(): string {
	const override = process.env?.[PACKAGE_ORIGIN_ENV];
	const trimmed = override?.trim() ?? '';
	if (trimmed.length === 0 || !isUsablePackageOrigin(trimmed)) {
		return CHANNEL_PACKAGE_ORIGINS[BUILD_CHANNEL];
	}
	return trimmed.replace(/\/+$/u, '');
}

export function getUpdateBaseUrl(platform: NodeJS.Platform = process.platform): string {
	return `${resolveDesktopPackageOrigin()}/desktop/${BUILD_CHANNEL}/${platform}/${DESKTOP_DOWNLOAD_ARCH}`;
}

export const MANUAL_DESKTOP_FORMATS = ['setup', 'dmg', 'zip', 'appimage', 'deb', 'rpm', 'tar_gz'] as const;

export type ManualDesktopFormat = (typeof MANUAL_DESKTOP_FORMATS)[number];
export type LinuxManualDesktopFormat = Extract<ManualDesktopFormat, 'appimage' | 'deb' | 'rpm' | 'tar_gz'>;

export const LINUX_MANUAL_FORMAT_EXTENSIONS: Record<LinuxManualDesktopFormat, string> = {
	appimage: '.AppImage',
	deb: '.deb',
	rpm: '.rpm',
	tar_gz: '.tar.gz',
};

export const LINUX_MANUAL_ARCH_TOKENS: Record<LinuxManualDesktopFormat, Record<DesktopDownloadArch, string>> = {
	appimage: {x64: 'x86_64', arm64: 'arm64'},
	deb: {x64: 'amd64', arm64: 'arm64'},
	rpm: {x64: 'x86_64', arm64: 'aarch64'},
	tar_gz: {x64: 'x64', arm64: 'arm64'},
};

export const SPLASH_LINUX_FORMAT_ORDER: ReadonlyArray<LinuxManualDesktopFormat> = ['deb', 'rpm', 'appimage', 'tar_gz'];

export const SPLASH_LINUX_FORMAT_LABELS: Record<LinuxManualDesktopFormat, string> = {
	deb: 'Debian (deb)',
	rpm: 'Fedora (rpm)',
	appimage: 'Linux (AppImage)',
	tar_gz: 'Linux (tar.gz)',
};

export function isLinuxManualDesktopFormat(format: ManualDesktopFormat): format is LinuxManualDesktopFormat {
	return format === 'appimage' || format === 'deb' || format === 'rpm' || format === 'tar_gz';
}

export function buildManualLatestDownloadUrl(format: ManualDesktopFormat): string {
	return `${getUpdateBaseUrl()}/latest/${format}`;
}
