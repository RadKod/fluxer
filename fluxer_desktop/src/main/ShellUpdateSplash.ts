// SPDX-License-Identifier: AGPL-3.0-or-later

import {DESKTOP_APP_NAME} from '@electron/common/DesktopIdentity';
import {createChildLogger} from '@electron/common/Logger';
import {t} from '@electron/main/MainI18n';
import {openExternalDeduped} from '@electron/main/OpenExternal';
import {
	buildManualLatestDownloadUrl,
	SPLASH_LINUX_FORMAT_LABELS,
	SPLASH_LINUX_FORMAT_ORDER,
} from '@electron/main/ShellDownloadFormats';
import {ShellUpdateCapability, type ShellUpdatePlan} from '@electron/main/ShellUpdateCapability';
import {
	onSplashOpenDownload,
	SplashAction,
	type SplashActionDescriptor,
	SplashActionKind,
	type SplashDownloadOption,
	SplashLayout,
	SplashStatus,
	setSplashState,
} from '@electron/main/SplashWindow';
import {DOWNLOAD_PAGE_URL} from '@electron/main/UpdaterDownloads';
import {app} from 'electron';

export const SPLASH_MANUAL_UPDATE_MESSAGE = `A new version of ${DESKTOP_APP_NAME} is ready to install.`;
const SPLASH_REQUIRED_SECURITY_UPDATE_MESSAGE = `A required security update must be installed before ${DESKTOP_APP_NAME} can start.`;
const WINDOWS_STORE_PRODUCT_URL = 'ms-windows-store://pdp/?ProductId=9P1SNJ2H2W9H';
const SPLASH_DECLINE_OPTION_VALUE = 'nope';
const SPLASH_DECLINE_OPTION_LABEL = "I'll figure it out";
const SPLASH_DOWNLOAD_BUTTON_LABEL = 'Download';
const SPLASH_DECLINE_BUTTON_LABEL = 'Okay';

interface BlockedShellUpdate {
	readonly layout: SplashLayout;
	readonly status: SplashStatus;
	readonly action: SplashActionDescriptor | null;
	readonly message: string | null;
	readonly versionLabel: string | null;
	readonly options: ReadonlyArray<SplashDownloadOption> | null;
	readonly downloadUrl: string | null;
	readonly downloadUrls: ReadonlyMap<string, string>;
}

const logger = createChildLogger('ShellUpdateSplash');

let armedDownloadUrl: string | null = null;
const armedDownloadUrls = new Map<string, string>();
let disarmDownloadListener: (() => void) | null = null;

function buildLinuxDownloadOptions(): Array<SplashDownloadOption> {
	const options: Array<SplashDownloadOption> = SPLASH_LINUX_FORMAT_ORDER.map((format) => ({
		value: format,
		label: SPLASH_LINUX_FORMAT_LABELS[format],
		buttonLabel: SPLASH_DOWNLOAD_BUTTON_LABEL,
		kind: SplashActionKind.DOWNLOAD,
	}));
	options.push({
		value: SPLASH_DECLINE_OPTION_VALUE,
		label: SPLASH_DECLINE_OPTION_LABEL,
		buttonLabel: SPLASH_DECLINE_BUTTON_LABEL,
		kind: SplashActionKind.QUIT,
	});
	return options;
}

function buildLinuxDownloadUrls(): Map<string, string> {
	return new Map(SPLASH_LINUX_FORMAT_ORDER.map((format) => [format, buildManualLatestDownloadUrl(format)]));
}

function usesManualUpdatePicker(plan: ShellUpdatePlan, platform: NodeJS.Platform): boolean {
	return (
		plan.capability === ShellUpdateCapability.MANUAL_DOWNLOAD && plan.reason === 'platform' && platform === 'linux'
	);
}

export function getBlockedShellUpdate(
	plan: ShellUpdatePlan,
	latestVersion: string | null,
	requiredSecurityUpdate = false,
): BlockedShellUpdate {
	if (plan.capability === ShellUpdateCapability.MANAGED_PACKAGE) {
		const windowsStore = process.platform === 'win32' && process.windowsStore === true;
		return {
			layout: SplashLayout.SPLASH,
			status: requiredSecurityUpdate
				? SplashStatus.BLOCKED_SECURITY_UPDATE_MANAGED
				: SplashStatus.BLOCKED_SHELL_UPDATE_MANAGED,
			action: windowsStore
				? {kind: SplashActionKind.DOWNLOAD, label: t('desktop.shellUpdate.openMicrosoftStore')}
				: SplashAction.QUIT,
			message: windowsStore
				? t(requiredSecurityUpdate ? 'desktop.shellUpdate.storeSecurityRequired' : 'desktop.shellUpdate.storeRequired')
				: null,
			versionLabel: null,
			options: null,
			downloadUrl: windowsStore ? WINDOWS_STORE_PRODUCT_URL : null,
			downloadUrls: new Map(),
		};
	}
	if (usesManualUpdatePicker(plan, process.platform)) {
		return {
			layout: SplashLayout.MANUAL_UPDATE,
			status: requiredSecurityUpdate
				? SplashStatus.BLOCKED_SECURITY_UPDATE_REQUIRED
				: SplashStatus.BLOCKED_SHELL_UPDATE,
			action: null,
			message: requiredSecurityUpdate ? SPLASH_REQUIRED_SECURITY_UPDATE_MESSAGE : SPLASH_MANUAL_UPDATE_MESSAGE,
			versionLabel: latestVersion == null ? null : `Version ${latestVersion} available`,
			options: buildLinuxDownloadOptions(),
			downloadUrl: null,
			downloadUrls: buildLinuxDownloadUrls(),
		};
	}
	return {
		layout: SplashLayout.SPLASH,
		status: requiredSecurityUpdate ? SplashStatus.BLOCKED_SECURITY_UPDATE_REQUIRED : SplashStatus.BLOCKED_SHELL_UPDATE,
		action: SplashAction.DOWNLOAD,
		message: null,
		versionLabel: null,
		options: null,
		downloadUrl: DOWNLOAD_PAGE_URL,
		downloadUrls: new Map(),
	};
}

function openArmedDownload(value: string | null): void {
	const url = value == null ? armedDownloadUrl : (armedDownloadUrls.get(value) ?? null);
	if (url == null) {
		logger.warn('Ignoring a splash download request that matches no armed download', {value});
		return;
	}
	void openExternalDeduped(url).then(
		() => {
			logger.info('Opened the download for a required shell update, quitting', {url});
			app.quit();
		},
		(error: unknown) => {
			logger.error('Failed to open the download for a required shell update, quitting anyway', {url, error});
			app.quit();
		},
	);
}

export function armBlockedShellUpdate(
	plan: ShellUpdatePlan,
	latestVersion: string | null,
	requiredSecurityUpdate = false,
): BlockedShellUpdate {
	const blocked = getBlockedShellUpdate(plan, latestVersion, requiredSecurityUpdate);
	armedDownloadUrl = blocked.downloadUrl;
	armedDownloadUrls.clear();
	for (const [value, url] of blocked.downloadUrls) {
		armedDownloadUrls.set(value, url);
	}
	disarmDownloadListener?.();
	disarmDownloadListener = null;
	if (armedDownloadUrl != null || armedDownloadUrls.size > 0) {
		disarmDownloadListener = onSplashOpenDownload(openArmedDownload);
	}
	setSplashState({
		layout: blocked.layout,
		status: blocked.status,
		action: blocked.action,
		message: blocked.message,
		versionLabel: blocked.versionLabel,
		options: blocked.options,
	});
	return blocked;
}
