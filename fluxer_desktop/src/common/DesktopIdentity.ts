// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL, type BuildChannel} from '@electron/common/BuildChannel';

const DESKTOP_APP_NAMES: Record<BuildChannel, string> = {
	stable: 'sanalyer',
	canary: 'sanalyer Canary',
	development: 'sanalyer Development',
};
const DESKTOP_ARTIFACT_PRODUCT_NAMES: Record<BuildChannel, string> = {
	stable: 'sanalyer',
	canary: 'sanalyer-Canary',
	development: 'sanalyer-Development',
};
const MACOS_BUNDLE_IDS: Record<BuildChannel, string> = {
	stable: 'com.sanalyer.desktop',
	canary: 'com.sanalyer.desktop.canary',
	development: 'com.sanalyer.desktop.development',
};
const LINUX_DESKTOP_ENTRY_IDS: Record<BuildChannel, string> = {
	stable: 'sanalyer',
	canary: 'sanalyer-canary',
	development: 'sanalyer-development',
};
const LEGACY_LINUX_DESKTOP_ENTRY_IDS: Record<BuildChannel, string> = {
	stable: 'sanalyer',
	canary: 'sanalyer-canary',
	development: 'sanalyer-development',
};
const LINUX_PORTAL_SESSION_TOKENS: Record<BuildChannel, string> = {
	stable: 'sanalyer_global_shortcuts',
	canary: 'sanalyer_canary_global_shortcuts',
	development: 'sanalyer_development_global_shortcuts',
};
const WINDOWS_VELOPACK_IDS: Record<BuildChannel, string> = {
	stable: 'sanalyer_desktop',
	canary: 'sanalyer_desktop_canary',
	development: 'sanalyer_desktop_development',
};
const WINDOWS_APP_USER_MODEL_IDS: Record<BuildChannel, string> = {
	stable: 'com.sanalyer.desktop',
	canary: 'com.sanalyer.desktop.canary',
	development: 'com.sanalyer.desktop.development',
};
const WINDOWS_TOAST_ACTIVATOR_CLSIDS: Record<BuildChannel, string> = {
	stable: '{978334C3-2A4E-47B0-AA72-05256D289C5E}',
	canary: '{80CA80CC-AEAA-4ABC-8432-F25027C1E885}',
	development: '{D3DC6BCE-9CB0-4A56-8E44-13C3A745F782}',
};

export const DESKTOP_APP_NAME = DESKTOP_APP_NAMES[BUILD_CHANNEL];
export const DESKTOP_ARTIFACT_PRODUCT_NAME = DESKTOP_ARTIFACT_PRODUCT_NAMES[BUILD_CHANNEL];
export const MACOS_BUNDLE_ID = MACOS_BUNDLE_IDS[BUILD_CHANNEL];
export const LINUX_DESKTOP_ENTRY_ID = LINUX_DESKTOP_ENTRY_IDS[BUILD_CHANNEL];
export const LINUX_PORTAL_SESSION_TOKEN = LINUX_PORTAL_SESSION_TOKENS[BUILD_CHANNEL];
export const LEGACY_LINUX_DESKTOP_ENTRY_ID = LEGACY_LINUX_DESKTOP_ENTRY_IDS[BUILD_CHANNEL];
export const LINUX_ICON_NAME = LEGACY_LINUX_DESKTOP_ENTRY_IDS[BUILD_CHANNEL];
export const WINDOWS_SHORTCUT_AUTHOR = 'sanalyer';
export const WINDOWS_VELOPACK_ID = WINDOWS_VELOPACK_IDS[BUILD_CHANNEL];
export const WINDOWS_LEGACY_SQUIRREL_ID = 'fluxer_app';
export const WINDOWS_APP_USER_MODEL_ID = WINDOWS_APP_USER_MODEL_IDS[BUILD_CHANNEL];
export const WINDOWS_LEGACY_APP_USER_MODEL_IDS = [`velopack.${WINDOWS_VELOPACK_ID}`];
export const WINDOWS_TOAST_ACTIVATOR_CLSID = WINDOWS_TOAST_ACTIVATOR_CLSIDS[BUILD_CHANNEL];
export const WINDOWS_STORE_IDENTITY_NAME = 'sanalyer.sanalyer';
