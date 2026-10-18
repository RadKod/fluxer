// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	COMFY_MESSAGE_GROUP_SPACING_DEFAULT,
	COMPACT_MESSAGE_GROUP_SPACING_DEFAULT,
	getMessageGroupSpacingForDisplayMode,
	migrateLegacyMessageGroupSpacing,
} from '@app/features/accessibility/state/MessageGroupSpacing';
import {DEFAULT_MESSAGE_GUTTER_PX} from '@app/features/accessibility/state/MessagePresentationDefaults';
import type {AnimatedMediaKind} from '@app/features/accessibility/state/MotionPreferencesMachine';
import {
	AuthSessionStorageKey,
	readStoredSessionUserId,
} from '@app/features/platform/state/auth_session/AuthSessionStorage';
import AppStorage, {
	ACCESSIBILITY_FONT_SIZE_DEFAULT_MIGRATED_V1_STORAGE_KEY,
	ACCESSIBILITY_MOTION_STORAGE_KEY,
	ACCESSIBILITY_MOTION_SYNC_DEFAULT_OFF_MIGRATED_V1_STORAGE_KEY,
} from '@app/features/platform/state/PersistentStorage';
import {
	readRawStorageItem,
	writeRawStorageItem,
	ZOOM_PREBOOT_MIRROR_STORAGE_KEY,
} from '@app/features/platform/state/PrebootMirror';
import {initializeStore} from '@app/features/platform/utils/StoreInitialization';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {applyAppZoomToDocument} from '@app/features/ui/utils/AppZoomUtils';
import {shouldShowAppZoomLevel} from '@app/features/user/components/settings_utils/AppZoomLevelUtils';
import {makeSyncedField} from '@app/features/user/state/SyncedField';
import {StickerAnimationOptions} from '@fluxer/constants/src/UserConstants';
import {isRecord} from '@fluxer/record_utils/src/RecordGuards';
import {decodeSyncedPreferencesLenient} from '@fluxer/schema/src/domains/user/SyncedPreferencesCodec';
import {
	AccessibilitySettingsSchema,
	ChannelTypingIndicatorMode as ProtoChannelTypingIndicatorMode,
	DmMessagePreviewMode as ProtoDmMessagePreviewMode,
	HdrDisplayMode as ProtoHdrDisplayMode,
} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/accessibility_pb';
import {makeAutoObservable, observable, reaction, runInAction} from 'mobx';

export const ZOOM_LEVEL_MIN = 0.5;
export const ZOOM_LEVEL_MAX = 2.0;
const ZOOM_KEYBOARD_STEP_PCT = 10;
export const DEFAULT_ZOOM_LEVEL = shouldShowAppZoomLevel() ? 0.95 : 1.0;
export const ZOOM_LEVEL_MARKERS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;
// Micup: earlier builds defaulted to 80%, then 95% (V1 flag), then 100% (V2 flag); the default is 95% again.
const MICUP_80_DEFAULT_ZOOM_LEVEL = 0.8;
const MICUP_100_DEFAULT_ZOOM_LEVEL = 1.0;
const ACCESSIBILITY_STORE_STORAGE_KEY = 'Accessibility';
const ACCESSIBILITY_ZOOM_STORAGE_KEY = 'Accessibility:zoomLevel';
const ACCESSIBILITY_ZOOM_DEFAULT_MIGRATED_V1_STORAGE_KEY = 'Accessibility:zoomLevelDefault95MigratedV1';
const ACCESSIBILITY_ZOOM_DEFAULT_MIGRATED_V2_STORAGE_KEY = 'Accessibility:zoomLevelDefault100MigratedV1';
const ACCESSIBILITY_ZOOM_DEFAULT_MIGRATED_V3_STORAGE_KEY = 'Accessibility:zoomLevelDefault95RestoredV1';
const ACCESSIBILITY_CUSTOM_THEME_STORAGE_KEY = 'Accessibility:customThemeCss';
const ACCESSIBILITY_CUSTOM_THEME_SYNC_STORAGE_KEY = 'Accessibility:customThemeCssSyncAcrossDevices';
const ACCESSIBILITY_SHOW_NEKO_STORAGE_KEY = 'Accessibility:showNeko';
const ACCESSIBILITY_KEEP_NEKO_STILL_STORAGE_KEY = 'Accessibility:keepNekoStill';
const ACCESSIBILITY_PIN_NEKO_TO_TEXTAREA_STORAGE_KEY = 'Accessibility:pinNekoToTextarea';
const ACCESSIBILITY_VIDEO_SEEK_PREVIEW_THUMBNAILS_STORAGE_KEY = 'Accessibility:videoSeekPreviewThumbnails';
const ACCESSIBILITY_SHOW_NAME_STYLES_STORAGE_KEY = 'Accessibility:showNameStyles';
const SYNCED_PREFERENCES_LOCAL_STORAGE_KEY = 'UserSettings:syncedPreferencesLocal';
const getShowNekoStorageKey = (userId: string): string => `${ACCESSIBILITY_SHOW_NEKO_STORAGE_KEY}:${userId}`;
const getKeepNekoStillStorageKey = (userId: string): string => `${ACCESSIBILITY_KEEP_NEKO_STILL_STORAGE_KEY}:${userId}`;
const getLegacyPinNekoToTextareaStorageKey = (userId: string): string =>
	`${ACCESSIBILITY_PIN_NEKO_TO_TEXTAREA_STORAGE_KEY}:${userId}`;

// Micup: UserSettings imports this store, so it hands itself over here (like LocalPresence) instead of being imported.
interface AccessibilityUserSettings {
	isHydrated(): boolean;
	getSubPreference(field: 'accessibility'): {fontSize?: number} | undefined;
}

const accessibilityUserSettings = observable.box<AccessibilityUserSettings | null>(null, {deep: false});

export function setAccessibilityUserSettings(settings: AccessibilityUserSettings): void {
	runInAction(() => accessibilityUserSettings.set(settings));
}

interface AccessibilityStartupSettings {
	zoomLevel: number;
	syncReducedMotionWithSystem: boolean;
	reducedMotionOverride: boolean | null;
	enableSmoothScrolling: boolean;
	keepAnimatedEmojiUnderReducedMotion: boolean;
	keepGifAutoPlayUnderReducedMotion: boolean;
	keepStickerAnimationUnderReducedMotion: boolean;
}

interface LegacyAccessibilityStartupSettings {
	zoomLevel: number;
	syncReducedMotionWithSystem?: boolean;
	reducedMotionOverride?: boolean | null;
	enableSmoothScrolling?: boolean;
}

interface AccessibilityStartupSettingsOptions {
	preserveLegacyZoomLevel?: boolean;
}

interface StartupSettingsStorage {
	getItem(key: string): string | null;
}

interface LocalMotionSettings {
	syncReducedMotionWithSystem: boolean;
	reducedMotionOverride: boolean | null;
	enableSmoothScrolling: boolean;
	keepAnimatedEmojiUnderReducedMotion: boolean;
	keepGifAutoPlayUnderReducedMotion: boolean;
	keepStickerAnimationUnderReducedMotion: boolean;
}

// Micup: animations play for everyone by default, even when the system asks for reduced motion; "Reduce motion" or
// "Sync reduced motion setting with system" in Settings > Motion turns them off.
const DEFAULT_LOCAL_MOTION_SETTINGS: LocalMotionSettings = {
	syncReducedMotionWithSystem: false,
	reducedMotionOverride: null,
	enableSmoothScrolling: true,
	keepAnimatedEmojiUnderReducedMotion: false,
	keepGifAutoPlayUnderReducedMotion: false,
	keepStickerAnimationUnderReducedMotion: false,
};

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 48;
// Micup: chat text defaults to 15px, 1px under upstream like the rest of the UI text (the build shrinks every other
// font-size by 1px).
const DEFAULT_FONT_SIZE_PX = 15;
const PREVIOUS_DEFAULT_FONT_SIZE_PX = 16;
const MESSAGE_GROUP_SPACING_MIN = 0;
const MESSAGE_GROUP_SPACING_MAX = 64;
const MESSAGE_GUTTER_MIN = 0;
const MESSAGE_GUTTER_MAX = 200;

function clampFontSize(size: number): number {
	if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE_PX;
	return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
}

function clampMessageGroupSpacing(spacing: number, fallback: number): number {
	if (!Number.isFinite(spacing)) return fallback;
	return Math.max(MESSAGE_GROUP_SPACING_MIN, Math.min(MESSAGE_GROUP_SPACING_MAX, spacing));
}

function clampMessageGutter(gutter: number): number {
	if (!Number.isFinite(gutter)) return DEFAULT_MESSAGE_GUTTER_PX;
	return Math.max(MESSAGE_GUTTER_MIN, Math.min(MESSAGE_GUTTER_MAX, gutter));
}

function clampZoomLevel(level: number): number {
	if (!Number.isFinite(level)) return DEFAULT_ZOOM_LEVEL;
	const pct = Math.round(level * 100);
	const clampedPct = Math.max(Math.round(ZOOM_LEVEL_MIN * 100), Math.min(Math.round(ZOOM_LEVEL_MAX * 100), pct));
	return clampedPct / 100;
}

function nextZoomLevel(current: number, direction: 1 | -1): number {
	const minPct = Math.round(ZOOM_LEVEL_MIN * 100);
	const maxPct = Math.round(ZOOM_LEVEL_MAX * 100);
	const step = ZOOM_KEYBOARD_STEP_PCT;
	const currentPct = Math.round(clampZoomLevel(current) * 100);
	const targetPct =
		direction > 0 ? Math.ceil((currentPct + 1) / step) * step : Math.floor((currentPct - 1) / step) * step;
	return Math.max(minPct, Math.min(maxPct, targetPct)) / 100;
}

function readLocalZoomLevel(storage: StartupSettingsStorage = AppStorage): number | null {
	let raw: string | null;
	try {
		raw = storage.getItem(ACCESSIBILITY_ZOOM_STORAGE_KEY);
	} catch {
		return null;
	}
	if (raw === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return typeof parsed === 'number' ? clampZoomLevel(parsed) : null;
}

function readPrebootZoomFactor(): number | null {
	if (window.electron == null) {
		return null;
	}
	const raw = readRawStorageItem(ZOOM_PREBOOT_MIRROR_STORAGE_KEY);
	if (raw === null) {
		return null;
	}
	const zoomPercent = Number.parseInt(raw, 10);
	return Number.isFinite(zoomPercent) ? clampZoomLevel(zoomPercent / 100) : null;
}

function readStoredBoolean(storage: StartupSettingsStorage, key: string): boolean | null {
	let raw: string | null;
	try {
		raw = storage.getItem(key);
	} catch {
		return null;
	}
	if (raw === null) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === 'boolean' ? parsed : null;
	} catch {
		return null;
	}
}

function normalizeLocalMotionSettings(value: unknown): LocalMotionSettings | null {
	if (!isRecord(value)) {
		return null;
	}
	const hasSync = typeof value.syncReducedMotionWithSystem === 'boolean';
	const hasOverride = typeof value.reducedMotionOverride === 'boolean' || value.reducedMotionOverride === null;
	const hasSmooth = typeof value.enableSmoothScrolling === 'boolean';
	const hasKeepEmoji = typeof value.keepAnimatedEmojiUnderReducedMotion === 'boolean';
	const hasKeepGif = typeof value.keepGifAutoPlayUnderReducedMotion === 'boolean';
	const hasKeepSticker = typeof value.keepStickerAnimationUnderReducedMotion === 'boolean';
	if (!hasSync && !hasOverride && !hasSmooth && !hasKeepEmoji && !hasKeepGif && !hasKeepSticker) {
		return null;
	}
	return {
		syncReducedMotionWithSystem: hasSync
			? (value.syncReducedMotionWithSystem as boolean)
			: DEFAULT_LOCAL_MOTION_SETTINGS.syncReducedMotionWithSystem,
		reducedMotionOverride: hasOverride
			? (value.reducedMotionOverride as boolean | null)
			: DEFAULT_LOCAL_MOTION_SETTINGS.reducedMotionOverride,
		enableSmoothScrolling: hasSmooth
			? (value.enableSmoothScrolling as boolean)
			: DEFAULT_LOCAL_MOTION_SETTINGS.enableSmoothScrolling,
		keepAnimatedEmojiUnderReducedMotion: hasKeepEmoji
			? (value.keepAnimatedEmojiUnderReducedMotion as boolean)
			: DEFAULT_LOCAL_MOTION_SETTINGS.keepAnimatedEmojiUnderReducedMotion,
		keepGifAutoPlayUnderReducedMotion: hasKeepGif
			? (value.keepGifAutoPlayUnderReducedMotion as boolean)
			: DEFAULT_LOCAL_MOTION_SETTINGS.keepGifAutoPlayUnderReducedMotion,
		keepStickerAnimationUnderReducedMotion: hasKeepSticker
			? (value.keepStickerAnimationUnderReducedMotion as boolean)
			: DEFAULT_LOCAL_MOTION_SETTINGS.keepStickerAnimationUnderReducedMotion,
	};
}

function readLocalMotionSettings(storage: StartupSettingsStorage = AppStorage): LocalMotionSettings | null {
	let raw: string | null;
	try {
		raw = storage.getItem(ACCESSIBILITY_MOTION_STORAGE_KEY);
	} catch {
		return null;
	}
	if (raw === null) {
		return null;
	}
	try {
		return normalizeLocalMotionSettings(JSON.parse(raw));
	} catch {
		return null;
	}
}

function readCachedSyncedMotionSettings(
	storage: StartupSettingsStorage,
): Pick<LocalMotionSettings, 'syncReducedMotionWithSystem' | 'reducedMotionOverride'> | null {
	let raw: string | null;
	try {
		raw = storage.getItem(SYNCED_PREFERENCES_LOCAL_STORAGE_KEY);
	} catch {
		return null;
	}
	if (raw === null || raw === '') {
		return null;
	}
	const accessibility = decodeSyncedPreferencesLenient(raw).accessibility;
	if (accessibility === undefined) {
		return null;
	}
	const hasSync = typeof accessibility.syncReducedMotionWithSystem === 'boolean';
	const hasOverride = typeof accessibility.reducedMotionOverride === 'boolean';
	if (!hasSync && !hasOverride) {
		return null;
	}
	return {
		syncReducedMotionWithSystem: hasSync
			? accessibility.syncReducedMotionWithSystem === true
			: DEFAULT_LOCAL_MOTION_SETTINGS.syncReducedMotionWithSystem,
		reducedMotionOverride: hasOverride
			? accessibility.reducedMotionOverride === true
			: DEFAULT_LOCAL_MOTION_SETTINGS.reducedMotionOverride,
	};
}

function readLocalShowNeko(
	storage: StartupSettingsStorage = AppStorage,
	userId: string | null = readStoredSessionUserId(storage),
): boolean {
	if (userId !== null) {
		const userValue = readStoredBoolean(storage, getShowNekoStorageKey(userId));
		if (userValue !== null) {
			return userValue;
		}
	}
	return readStoredBoolean(storage, ACCESSIBILITY_SHOW_NEKO_STORAGE_KEY) ?? false;
}

function readLocalKeepNekoStill(
	storage: StartupSettingsStorage = AppStorage,
	userId: string | null = readStoredSessionUserId(storage),
): boolean {
	if (userId !== null) {
		const userValue = readStoredBoolean(storage, getKeepNekoStillStorageKey(userId));
		if (userValue !== null) {
			return userValue;
		}
		const legacyUserValue = readStoredBoolean(storage, getLegacyPinNekoToTextareaStorageKey(userId));
		if (legacyUserValue !== null) {
			return legacyUserValue;
		}
	}
	return (
		readStoredBoolean(storage, ACCESSIBILITY_KEEP_NEKO_STILL_STORAGE_KEY) ??
		readStoredBoolean(storage, ACCESSIBILITY_PIN_NEKO_TO_TEXTAREA_STORAGE_KEY) ??
		false
	);
}

function readLocalVideoSeekPreviewThumbnails(storage: StartupSettingsStorage = AppStorage): boolean {
	return readStoredBoolean(storage, ACCESSIBILITY_VIDEO_SEEK_PREVIEW_THUMBNAILS_STORAGE_KEY) ?? false;
}

function readLocalShowNameStyles(storage: StartupSettingsStorage = AppStorage): boolean {
	return readStoredBoolean(storage, ACCESSIBILITY_SHOW_NAME_STYLES_STORAGE_KEY) ?? true;
}

function readAndMigrateLocalShowNeko(userId: string | null = readStoredSessionUserId(AppStorage)): boolean {
	const value = readLocalShowNeko(AppStorage, userId);
	if (userId === null) {
		return value;
	}
	try {
		const userKey = getShowNekoStorageKey(userId);
		const legacyValue = AppStorage.getItem(ACCESSIBILITY_SHOW_NEKO_STORAGE_KEY);
		if (legacyValue !== null) {
			if (AppStorage.getItem(userKey) === null) {
				AppStorage.setItem(userKey, JSON.stringify(value));
			}
			AppStorage.removeItem(ACCESSIBILITY_SHOW_NEKO_STORAGE_KEY);
		}
	} catch {}
	return value;
}

function readAndMigrateLocalKeepNekoStill(userId: string | null = readStoredSessionUserId(AppStorage)): boolean {
	const value = readLocalKeepNekoStill(AppStorage, userId);
	if (userId === null) {
		return value;
	}
	try {
		const userKey = getKeepNekoStillStorageKey(userId);
		const legacyUserKey = getLegacyPinNekoToTextareaStorageKey(userId);
		const hasMigratableValue =
			AppStorage.getItem(ACCESSIBILITY_KEEP_NEKO_STILL_STORAGE_KEY) !== null ||
			AppStorage.getItem(ACCESSIBILITY_PIN_NEKO_TO_TEXTAREA_STORAGE_KEY) !== null ||
			AppStorage.getItem(legacyUserKey) !== null;
		if (hasMigratableValue) {
			if (AppStorage.getItem(userKey) === null) {
				AppStorage.setItem(userKey, JSON.stringify(value));
			}
			AppStorage.removeItem(ACCESSIBILITY_KEEP_NEKO_STILL_STORAGE_KEY);
			AppStorage.removeItem(ACCESSIBILITY_PIN_NEKO_TO_TEXTAREA_STORAGE_KEY);
			AppStorage.removeItem(legacyUserKey);
		}
	} catch {}
	return value;
}

function persistLocalShowNeko(value: boolean, userId: string | null = readStoredSessionUserId(AppStorage)): void {
	try {
		AppStorage.setItem(
			userId === null ? ACCESSIBILITY_SHOW_NEKO_STORAGE_KEY : getShowNekoStorageKey(userId),
			JSON.stringify(value),
		);
		if (userId !== null) {
			AppStorage.removeItem(ACCESSIBILITY_SHOW_NEKO_STORAGE_KEY);
		}
	} catch {}
}

function persistLocalKeepNekoStill(value: boolean, userId: string | null = readStoredSessionUserId(AppStorage)): void {
	try {
		AppStorage.setItem(
			userId === null ? ACCESSIBILITY_KEEP_NEKO_STILL_STORAGE_KEY : getKeepNekoStillStorageKey(userId),
			JSON.stringify(value),
		);
		if (userId !== null) {
			AppStorage.removeItem(ACCESSIBILITY_KEEP_NEKO_STILL_STORAGE_KEY);
			AppStorage.removeItem(ACCESSIBILITY_PIN_NEKO_TO_TEXTAREA_STORAGE_KEY);
			AppStorage.removeItem(getLegacyPinNekoToTextareaStorageKey(userId));
		}
	} catch {}
}

function persistLocalVideoSeekPreviewThumbnails(value: boolean): void {
	try {
		AppStorage.setItem(ACCESSIBILITY_VIDEO_SEEK_PREVIEW_THUMBNAILS_STORAGE_KEY, JSON.stringify(value));
	} catch {}
}

function persistLocalShowNameStyles(value: boolean): void {
	try {
		AppStorage.setItem(ACCESSIBILITY_SHOW_NAME_STYLES_STORAGE_KEY, JSON.stringify(value));
	} catch {}
}

function readLocalCustomThemeCss(storage: StartupSettingsStorage = AppStorage): string | null {
	let raw: string | null;
	try {
		raw = storage.getItem(ACCESSIBILITY_CUSTOM_THEME_STORAGE_KEY);
	} catch {
		return null;
	}
	if (raw !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		return typeof parsed === 'string' ? parsed : null;
	}
	try {
		raw = storage.getItem(ACCESSIBILITY_STORE_STORAGE_KEY);
	} catch {
		return null;
	}
	if (raw === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}
	const metadata = parsed.__mps__;
	if (isRecord(metadata) && metadata.version !== 1) {
		return null;
	}
	return typeof parsed.customThemeCss === 'string' ? parsed.customThemeCss : null;
}

function readLegacyAccessibilityStartupSettings(
	storage: StartupSettingsStorage,
): LegacyAccessibilityStartupSettings | null {
	let raw: string | null;
	try {
		raw = storage.getItem(ACCESSIBILITY_STORE_STORAGE_KEY);
	} catch {
		return null;
	}
	if (raw === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}
	const metadata = parsed.__mps__;
	if (isRecord(metadata) && metadata.version !== 1) {
		return null;
	}
	const zoomLevel = typeof parsed.zoomLevel === 'number' ? clampZoomLevel(parsed.zoomLevel) : DEFAULT_ZOOM_LEVEL;
	const syncReducedMotionWithSystem =
		typeof parsed.syncReducedMotionWithSystem === 'boolean' ? parsed.syncReducedMotionWithSystem : undefined;
	const reducedMotionOverride =
		typeof parsed.reducedMotionOverride === 'boolean' ? parsed.reducedMotionOverride : undefined;
	return {
		zoomLevel,
		syncReducedMotionWithSystem,
		reducedMotionOverride,
	};
}

function shouldPreserveLegacyZoomLevel(): boolean {
	return (
		typeof window !== 'undefined' &&
		Boolean(
			(
				window as {
					electron?: unknown;
				}
			).electron,
		)
	);
}

function readAccessibilityStartupSettings(
	storage: StartupSettingsStorage = AppStorage,
	options: AccessibilityStartupSettingsOptions = {},
): AccessibilityStartupSettings | null {
	const localZoomLevel = readPrebootZoomFactor() ?? readLocalZoomLevel(storage);
	const localMotionSettings = readLocalMotionSettings(storage);
	const legacySettings = readLegacyAccessibilityStartupSettings(storage);
	const cachedSyncedMotionSettings = localMotionSettings === null ? readCachedSyncedMotionSettings(storage) : null;
	if (
		localZoomLevel === null &&
		localMotionSettings === null &&
		legacySettings === null &&
		cachedSyncedMotionSettings === null
	) {
		return null;
	}
	const preserveLegacyZoomLevel = options.preserveLegacyZoomLevel ?? shouldPreserveLegacyZoomLevel();
	return {
		zoomLevel:
			localZoomLevel ??
			(preserveLegacyZoomLevel ? (legacySettings?.zoomLevel ?? DEFAULT_ZOOM_LEVEL) : DEFAULT_ZOOM_LEVEL),
		syncReducedMotionWithSystem:
			localMotionSettings?.syncReducedMotionWithSystem ??
			legacySettings?.syncReducedMotionWithSystem ??
			cachedSyncedMotionSettings?.syncReducedMotionWithSystem ??
			DEFAULT_LOCAL_MOTION_SETTINGS.syncReducedMotionWithSystem,
		reducedMotionOverride:
			localMotionSettings !== null
				? localMotionSettings.reducedMotionOverride
				: (legacySettings?.reducedMotionOverride ??
					cachedSyncedMotionSettings?.reducedMotionOverride ??
					DEFAULT_LOCAL_MOTION_SETTINGS.reducedMotionOverride),
		enableSmoothScrolling:
			localMotionSettings?.enableSmoothScrolling ?? DEFAULT_LOCAL_MOTION_SETTINGS.enableSmoothScrolling,
		keepAnimatedEmojiUnderReducedMotion:
			localMotionSettings?.keepAnimatedEmojiUnderReducedMotion ??
			DEFAULT_LOCAL_MOTION_SETTINGS.keepAnimatedEmojiUnderReducedMotion,
		keepGifAutoPlayUnderReducedMotion:
			localMotionSettings?.keepGifAutoPlayUnderReducedMotion ??
			DEFAULT_LOCAL_MOTION_SETTINGS.keepGifAutoPlayUnderReducedMotion,
		keepStickerAnimationUnderReducedMotion:
			localMotionSettings?.keepStickerAnimationUnderReducedMotion ??
			DEFAULT_LOCAL_MOTION_SETTINGS.keepStickerAnimationUnderReducedMotion,
	};
}

// Micup: a zoom written by this build is never a stale old default, so the migration flag travels with it;
// otherwise a storage reset (auth failure) followed by an in-page re-login rewrites the zoom without the flag.
function persistLocalZoomLevel(level: number): void {
	try {
		AppStorage.setItem(ACCESSIBILITY_ZOOM_STORAGE_KEY, JSON.stringify(clampZoomLevel(level)));
		AppStorage.setItem(ACCESSIBILITY_ZOOM_DEFAULT_MIGRATED_V3_STORAGE_KEY, 'true');
	} catch {}
}

// Micup: the app persists the zoom level even when the user never touched it, so an old default sits in storage for
// everyone who opened the app. Once, move to the 95% default an exact 100% that the 100% build wrote (V2 flag: its
// migration or its default), or an exact 80% that no later build ever wrote (no V1 or V2 flag); keep every other value,
// including a 100% chosen under the 95% build and an 80% chosen after a move. A 100% chosen under the 100% build cannot
// be told apart from its default and moves too. The desktop preload paints the stored value before this runs, so a
// moved zoom shows one frame at the old size on the first launch.
function applyZoomLevelDefaultMigrationV3(): void {
	try {
		if (AppStorage.getItem(ACCESSIBILITY_ZOOM_DEFAULT_MIGRATED_V3_STORAGE_KEY) !== null) {
			return;
		}
		const stored = readLocalZoomLevel();
		const movedTo95 = AppStorage.getItem(ACCESSIBILITY_ZOOM_DEFAULT_MIGRATED_V1_STORAGE_KEY) !== null;
		const movedTo100 = AppStorage.getItem(ACCESSIBILITY_ZOOM_DEFAULT_MIGRATED_V2_STORAGE_KEY) !== null;
		if (
			(stored === MICUP_100_DEFAULT_ZOOM_LEVEL && movedTo100) ||
			(stored === MICUP_80_DEFAULT_ZOOM_LEVEL && !movedTo95 && !movedTo100)
		) {
			persistLocalZoomLevel(DEFAULT_ZOOM_LEVEL);
		}
		AppStorage.setItem(ACCESSIBILITY_ZOOM_DEFAULT_MIGRATED_V3_STORAGE_KEY, 'true');
	} catch {}
}

// Micup: motion settings written by this build are never the stale old default, so the move flag travels with them
// (as with the zoom).
function writeZoomPrebootMirror(level: number, isDesktop: boolean): void {
	if (!isDesktop) {
		writeRawStorageItem(ZOOM_PREBOOT_MIRROR_STORAGE_KEY, null);
		return;
	}
	const zoomPercent = Math.max(50, Math.min(200, Math.round(clampZoomLevel(level) * 100)));
	writeRawStorageItem(ZOOM_PREBOOT_MIRROR_STORAGE_KEY, String(zoomPercent));
}

function persistLocalMotionSettings(settings: LocalMotionSettings): void {
	try {
		AppStorage.setItem(ACCESSIBILITY_MOTION_STORAGE_KEY, JSON.stringify(settings));
		AppStorage.setItem(ACCESSIBILITY_MOTION_SYNC_DEFAULT_OFF_MIGRATED_V1_STORAGE_KEY, 'true');
	} catch {}
}

// Micup: the app persists the motion settings even when the user never touched them, so the old default (sync with the
// system on, no override) sits in storage on every device that opened the app. Once per device, turn exactly that
// value's sync off; an override or a sync already off is the user's and stays. A sync left on deliberately cannot be
// told apart from the old default and moves too.
function applyMotionSyncDefaultOffMigrationV1(): void {
	try {
		if (AppStorage.getItem(ACCESSIBILITY_MOTION_SYNC_DEFAULT_OFF_MIGRATED_V1_STORAGE_KEY) !== null) {
			return;
		}
		const stored = readLocalMotionSettings();
		if (stored?.syncReducedMotionWithSystem === true && stored.reducedMotionOverride === null) {
			persistLocalMotionSettings({...stored, syncReducedMotionWithSystem: false});
		}
		AppStorage.setItem(ACCESSIBILITY_MOTION_SYNC_DEFAULT_OFF_MIGRATED_V1_STORAGE_KEY, 'true');
	} catch {}
}

function persistLocalCustomThemeCss(css: string | null): void {
	try {
		AppStorage.setItem(ACCESSIBILITY_CUSTOM_THEME_STORAGE_KEY, JSON.stringify(css));
	} catch {}
}

function persistLocalCustomThemeCssSyncAcrossDevices(value: boolean): void {
	try {
		AppStorage.setItem(ACCESSIBILITY_CUSTOM_THEME_SYNC_STORAGE_KEY, JSON.stringify(value));
	} catch {}
}

function readLocalCustomThemeCssSyncAcrossDevices(): boolean {
	try {
		const raw = AppStorage.getItem(ACCESSIBILITY_CUSTOM_THEME_SYNC_STORAGE_KEY);
		return raw === null ? false : JSON.parse(raw) === true;
	} catch {
		return false;
	}
}

function normalizeCustomThemeCss(css: string | null | undefined): string | null {
	if (typeof css !== 'string') {
		return null;
	}
	return css.trim().length > 0 ? css : null;
}

function resolveStartupReducedMotion(
	settings: Pick<AccessibilityStartupSettings, 'syncReducedMotionWithSystem' | 'reducedMotionOverride'>,
	systemReducedMotion: boolean,
): boolean {
	return settings.syncReducedMotionWithSystem ? systemReducedMotion : (settings.reducedMotionOverride ?? false);
}

export enum DMMessagePreviewMode {
	ALL = 0,
	UNREAD_ONLY = 1,
	NONE = 2,
}

export enum ChannelTypingIndicatorMode {
	AVATARS = 0,
	INDICATOR_ONLY = 1,
	HIDDEN = 2,
}

export enum HdrDisplayMode {
	FULL = 'full',
	STANDARD = 'standard',
}

export interface AccessibilitySettings {
	saturationFactor: number;
	alwaysUnderlineLinks: boolean;
	dimStrikethroughText: boolean;
	enableTextSelection: boolean;
	showMessageSendButton: boolean;
	showTextareaFocusRing: boolean;
	hideKeyboardHints: boolean;
	escapeExitsKeyboardMode: boolean;
	syncReducedMotionWithSystem: boolean;
	reducedMotionOverride: boolean | null;
	enableSmoothScrolling: boolean;
	keepAnimatedEmojiUnderReducedMotion: boolean;
	keepGifAutoPlayUnderReducedMotion: boolean;
	keepStickerAnimationUnderReducedMotion: boolean;
	messageGroupSpacing: number;
	compactMessageGroupSpacing: number;
	messageGutter: number;
	fontSize: number;
	showUserAvatarsInCompactMode: boolean;
	mobileStickerAnimationOverridden: boolean;
	mobileGifAutoPlayOverridden: boolean;
	mobileAnimateEmojiOverridden: boolean;
	mobileStickerAnimationValue: number;
	mobileGifAutoPlayValue: boolean;
	mobileAnimateEmojiValue: boolean;
	autoSendKlipyGifs: boolean;
	showGifButton: boolean;
	showMemesButton: boolean;
	showStickersButton: boolean;
	showEmojiButton: boolean;
	showMediaFavoriteButton: boolean;
	showMediaDownloadButton: boolean;
	showMediaDeleteButton: boolean;
	showSuppressEmbedsButton: boolean;
	showGifIndicator: boolean;
	showAttachmentExpiryIndicator: boolean;
	useBrowserLocaleForTimeFormat: boolean;
	channelTypingIndicatorMode: ChannelTypingIndicatorMode;
	showMessageActionBar: boolean;
	showMessageActionBarQuickReactions: boolean;
	showMessageActionBarShiftExpand: boolean;
	showMessageActionBarOnlyMoreButton: boolean;
	showDefaultEmojisInExpressionAutocomplete: boolean;
	showCustomEmojisInExpressionAutocomplete: boolean;
	showStickersInExpressionAutocomplete: boolean;
	showMemesInExpressionAutocomplete: boolean;
	voiceChannelJoinRequiresDoubleClick: boolean;
	customThemeCss: string | null;
	customThemeCssSyncAcrossDevices: boolean;
	showFavorites: boolean;
	zoomLevel: number;
	dmMessagePreviewMode: DMMessagePreviewMode;
	enableTTSCommand: boolean;
	ttsRate: number;
	screenReaderAnnounceNewMessages: boolean;
	showFadedUnreadOnMutedChannels: boolean;
	showContextMenuShortcuts: boolean;
	confirmBeforeStartingCalls: boolean;
	confirmBeforeJoiningVoiceChannels: boolean;
	hdrDisplayMode: HdrDisplayMode;
	preserveEditDraft: boolean;
	stayInteractiveWhenUnfocused: boolean;
	scrollToBottomOnMessageSend: boolean;
	messageDoubleClickActions: boolean;
	sequentialFileSend: boolean;
	showNeko: boolean;
	keepNekoStill: boolean;
	showVideoSeekPreviewThumbnails: boolean;
	showNameStyles: boolean;
}

const getDefaultDmMessagePreviewMode = (): DMMessagePreviewMode =>
	MobileLayout.isMobileLayout() ? DMMessagePreviewMode.ALL : DMMessagePreviewMode.NONE;
const CHANNEL_TYPING_INDICATOR_TO_PROTO: Record<ChannelTypingIndicatorMode, ProtoChannelTypingIndicatorMode> = {
	[ChannelTypingIndicatorMode.AVATARS]: ProtoChannelTypingIndicatorMode.AVATARS,
	[ChannelTypingIndicatorMode.INDICATOR_ONLY]: ProtoChannelTypingIndicatorMode.INDICATOR_ONLY,
	[ChannelTypingIndicatorMode.HIDDEN]: ProtoChannelTypingIndicatorMode.HIDDEN,
};
const CHANNEL_TYPING_INDICATOR_FROM_PROTO: Record<ProtoChannelTypingIndicatorMode, ChannelTypingIndicatorMode> = {
	[ProtoChannelTypingIndicatorMode.UNSPECIFIED]: ChannelTypingIndicatorMode.AVATARS,
	[ProtoChannelTypingIndicatorMode.AVATARS]: ChannelTypingIndicatorMode.AVATARS,
	[ProtoChannelTypingIndicatorMode.INDICATOR_ONLY]: ChannelTypingIndicatorMode.INDICATOR_ONLY,
	[ProtoChannelTypingIndicatorMode.HIDDEN]: ChannelTypingIndicatorMode.HIDDEN,
};
const DM_PREVIEW_TO_PROTO: Record<DMMessagePreviewMode, ProtoDmMessagePreviewMode> = {
	[DMMessagePreviewMode.ALL]: ProtoDmMessagePreviewMode.ALL,
	[DMMessagePreviewMode.UNREAD_ONLY]: ProtoDmMessagePreviewMode.UNREAD_ONLY,
	[DMMessagePreviewMode.NONE]: ProtoDmMessagePreviewMode.NONE,
};
const DM_PREVIEW_FROM_PROTO: Record<ProtoDmMessagePreviewMode, DMMessagePreviewMode> = {
	[ProtoDmMessagePreviewMode.UNSPECIFIED]: DMMessagePreviewMode.ALL,
	[ProtoDmMessagePreviewMode.ALL]: DMMessagePreviewMode.ALL,
	[ProtoDmMessagePreviewMode.UNREAD_ONLY]: DMMessagePreviewMode.UNREAD_ONLY,
	[ProtoDmMessagePreviewMode.NONE]: DMMessagePreviewMode.NONE,
};
const HDR_TO_PROTO: Record<HdrDisplayMode, ProtoHdrDisplayMode> = {
	[HdrDisplayMode.FULL]: ProtoHdrDisplayMode.FULL,
	[HdrDisplayMode.STANDARD]: ProtoHdrDisplayMode.STANDARD,
};
const HDR_FROM_PROTO: Record<ProtoHdrDisplayMode, HdrDisplayMode> = {
	[ProtoHdrDisplayMode.UNSPECIFIED]: HdrDisplayMode.FULL,
	[ProtoHdrDisplayMode.FULL]: HdrDisplayMode.FULL,
	[ProtoHdrDisplayMode.STANDARD]: HdrDisplayMode.STANDARD,
};

class Accessibility {
	saturationFactor = 1;
	alwaysUnderlineLinks = false;
	dimStrikethroughText = true;
	enableTextSelection = false;
	showMessageSendButton = false;
	showTextareaFocusRing = true;
	hideKeyboardHints = false;
	escapeExitsKeyboardMode = false;
	syncReducedMotionWithSystem = DEFAULT_LOCAL_MOTION_SETTINGS.syncReducedMotionWithSystem;
	reducedMotionOverride: boolean | null = null;
	enableSmoothScrolling = true;
	keepAnimatedEmojiUnderReducedMotion = false;
	keepGifAutoPlayUnderReducedMotion = false;
	keepStickerAnimationUnderReducedMotion = false;
	messageGroupSpacing = COMFY_MESSAGE_GROUP_SPACING_DEFAULT;
	compactMessageGroupSpacing = COMPACT_MESSAGE_GROUP_SPACING_DEFAULT;
	messageGutter = DEFAULT_MESSAGE_GUTTER_PX;
	fontSize = DEFAULT_FONT_SIZE_PX;
	showUserAvatarsInCompactMode = false;
	mobileStickerAnimationOverridden = false;
	mobileGifAutoPlayOverridden = false;
	mobileAnimateEmojiOverridden = false;
	mobileStickerAnimationValue: number = StickerAnimationOptions.ANIMATE_ON_INTERACTION;
	mobileGifAutoPlayValue = false;
	mobileAnimateEmojiValue = true;
	autoSendKlipyGifs = true;
	showGifButton = true;
	showMemesButton = true;
	showStickersButton = true;
	showEmojiButton = true;
	showMediaFavoriteButton = true;
	showMediaDownloadButton = true;
	showMediaDeleteButton = true;
	showSuppressEmbedsButton = true;
	showGifIndicator = true;
	showAttachmentExpiryIndicator = true;
	useBrowserLocaleForTimeFormat = false;
	channelTypingIndicatorMode: ChannelTypingIndicatorMode = ChannelTypingIndicatorMode.AVATARS;
	showMessageActionBar = true;
	showMessageActionBarQuickReactions = true;
	showMessageActionBarShiftExpand = true;
	showMessageActionBarOnlyMoreButton = false;
	showDefaultEmojisInExpressionAutocomplete = true;
	showCustomEmojisInExpressionAutocomplete = true;
	showStickersInExpressionAutocomplete = true;
	showMemesInExpressionAutocomplete = true;
	voiceChannelJoinRequiresDoubleClick = false;
	systemReducedMotion = false;
	customThemeCss: string | null = null;
	customThemeCssSyncAcrossDevices = false;
	private serverCustomThemeCss: string | null = null;
	showFavorites = true;
	zoomLevel = DEFAULT_ZOOM_LEVEL;
	dmMessagePreviewMode: DMMessagePreviewMode = getDefaultDmMessagePreviewMode();
	enableTTSCommand = true;
	ttsRate = 1.0;
	screenReaderAnnounceNewMessages = false;
	showFadedUnreadOnMutedChannels = false;
	showContextMenuShortcuts = false;
	confirmBeforeStartingCalls = true;
	confirmBeforeJoiningVoiceChannels = false;
	hdrDisplayMode = HdrDisplayMode.FULL;
	preserveEditDraft = false;
	stayInteractiveWhenUnfocused = false;
	scrollToBottomOnMessageSend = true;
	messageDoubleClickActions = false;
	sequentialFileSend = false;
	showNeko = false;
	keepNekoStill = false;
	showVideoSeekPreviewThumbnails = false;
	// Micup: fonts and colours Plus members pick for their names; local to this device.
	showNameStyles = true;
	mediaQuery: MediaQueryList | null = null;
	private _hydrated = false;
	private unsubscribeZoomStorage: (() => void) | null = null;
	private unsubscribeMotionStorage: (() => void) | null = null;
	private unsubscribeShowNekoSession: (() => void) | null = null;
	private unsubscribeShowNekoStorage: (() => void) | null = null;
	private unsubscribeVideoSeekPreviewThumbnailsStorage: (() => void) | null = null;
	private unsubscribeShowNameStylesStorage: (() => void) | null = null;

	constructor() {
		applyZoomLevelDefaultMigrationV3();
		applyMotionSyncDefaultOffMigrationV1();
		const startupSettings = readAccessibilityStartupSettings();
		if (startupSettings !== null) {
			this.zoomLevel = startupSettings.zoomLevel;
			this.syncReducedMotionWithSystem = startupSettings.syncReducedMotionWithSystem;
			this.reducedMotionOverride = startupSettings.reducedMotionOverride;
			this.enableSmoothScrolling = startupSettings.enableSmoothScrolling;
			this.keepAnimatedEmojiUnderReducedMotion = startupSettings.keepAnimatedEmojiUnderReducedMotion;
			this.keepGifAutoPlayUnderReducedMotion = startupSettings.keepGifAutoPlayUnderReducedMotion;
			this.keepStickerAnimationUnderReducedMotion = startupSettings.keepStickerAnimationUnderReducedMotion;
			persistLocalZoomLevel(this.zoomLevel);
			persistLocalMotionSettings(this.localMotionSettingsSnapshot);
		}
		this.customThemeCss = readLocalCustomThemeCss();
		this.customThemeCssSyncAcrossDevices = readLocalCustomThemeCssSyncAcrossDevices();
		this.showNeko = readAndMigrateLocalShowNeko();
		this.keepNekoStill = readAndMigrateLocalKeepNekoStill();
		this.showVideoSeekPreviewThumbnails = readLocalVideoSeekPreviewThumbnails();
		this.showNameStyles = readLocalShowNameStyles();
		makeAutoObservable(this, {mediaQuery: false}, {autoBind: true});
		this.initializeMotionDetection();
		this.initializeZoomStorageSync();
		this.initializeMotionStorageSync();
		this.initializeShowNekoSessionSync();
		this.initializeShowNekoStorageSync();
		this.initializeVideoSeekPreviewThumbnailsStorageSync();
		this.initializeCustomThemeCssStorageSync();
		this.initializeShowNameStylesStorageSync();
		this.applyStartupPresentationSettings();
		initializeStore(this, () => this.initPersistence());
	}

	get isHydrated(): boolean {
		return this._hydrated;
	}

	private async initPersistence(): Promise<void> {
		await makeSyncedField(this, {
			field: 'accessibility',
			schema: AccessibilitySettingsSchema,
			syncAcrossTabs: true,
			persist: [
				'saturationFactor',
				'alwaysUnderlineLinks',
				'dimStrikethroughText',
				'enableTextSelection',
				'showMessageSendButton',
				'showTextareaFocusRing',
				'hideKeyboardHints',
				'escapeExitsKeyboardMode',
				'messageGroupSpacing',
				'compactMessageGroupSpacing',
				'messageGutter',
				'fontSize',
				'showUserAvatarsInCompactMode',
				'mobileStickerAnimationOverridden',
				'mobileGifAutoPlayOverridden',
				'mobileAnimateEmojiOverridden',
				'mobileStickerAnimationValue',
				'mobileGifAutoPlayValue',
				'mobileAnimateEmojiValue',
				'autoSendKlipyGifs',
				'showGifButton',
				'showMemesButton',
				'showStickersButton',
				'showEmojiButton',
				'showMediaFavoriteButton',
				'showMediaDownloadButton',
				'showMediaDeleteButton',
				'showSuppressEmbedsButton',
				'showGifIndicator',
				'showAttachmentExpiryIndicator',
				'useBrowserLocaleForTimeFormat',
				'channelTypingIndicatorMode',
				'showMessageActionBar',
				'showMessageActionBarQuickReactions',
				'showMessageActionBarShiftExpand',
				'showMessageActionBarOnlyMoreButton',
				'showDefaultEmojisInExpressionAutocomplete',
				'showCustomEmojisInExpressionAutocomplete',
				'showStickersInExpressionAutocomplete',
				'showMemesInExpressionAutocomplete',
				'voiceChannelJoinRequiresDoubleClick',
				'customThemeCssSyncAcrossDevices',
				'showFavorites',
				'dmMessagePreviewMode',
				'enableTTSCommand',
				'ttsRate',
				'screenReaderAnnounceNewMessages',
				'showFadedUnreadOnMutedChannels',
				'showContextMenuShortcuts',
				'confirmBeforeStartingCalls',
				'confirmBeforeJoiningVoiceChannels',
				'hdrDisplayMode',
				'preserveEditDraft',
				'stayInteractiveWhenUnfocused',
				'scrollToBottomOnMessageSend',
				'messageDoubleClickActions',
				'sequentialFileSend',
			],
			toMessage: (s) => ({
				saturationFactor: s.saturationFactor,
				alwaysUnderlineLinks: s.alwaysUnderlineLinks,
				dimStrikethroughText: s.dimStrikethroughText,
				enableTextSelection: s.enableTextSelection,
				showMessageSendButton: s.showMessageSendButton,
				showTextareaFocusRing: s.showTextareaFocusRing,
				hideKeyboardHints: s.hideKeyboardHints,
				escapeExitsKeyboardMode: s.escapeExitsKeyboardMode,
				messageGroupSpacing: s.messageGroupSpacing,
				compactMessageGroupSpacing: s.compactMessageGroupSpacing,
				messageGutter: s.messageGutter,
				fontSize: s.fontSize,
				showUserAvatarsInCompactMode: s.showUserAvatarsInCompactMode,
				mobileStickerAnimationOverridden: s.mobileStickerAnimationOverridden,
				mobileGifAutoplayOverridden: s.mobileGifAutoPlayOverridden,
				mobileAnimateEmojiOverridden: s.mobileAnimateEmojiOverridden,
				mobileStickerAnimationValue: s.mobileStickerAnimationValue,
				mobileGifAutoplayValue: s.mobileGifAutoPlayValue,
				mobileAnimateEmojiValue: s.mobileAnimateEmojiValue,
				autoSendKlipyGifs: s.autoSendKlipyGifs,
				showGifButton: s.showGifButton,
				showMemesButton: s.showMemesButton,
				showStickersButton: s.showStickersButton,
				showEmojiButton: s.showEmojiButton,
				showMediaFavoriteButton: s.showMediaFavoriteButton,
				showMediaDownloadButton: s.showMediaDownloadButton,
				showMediaDeleteButton: s.showMediaDeleteButton,
				showSuppressEmbedsButton: s.showSuppressEmbedsButton,
				showGifIndicator: s.showGifIndicator,
				showAttachmentExpiryIndicator: s.showAttachmentExpiryIndicator,
				useBrowserLocaleForTimeFormat: s.useBrowserLocaleForTimeFormat,
				channelTypingIndicatorMode: CHANNEL_TYPING_INDICATOR_TO_PROTO[s.channelTypingIndicatorMode],
				showMessageActionBar: s.showMessageActionBar,
				showMessageActionBarQuickReactions: s.showMessageActionBarQuickReactions,
				showMessageActionBarShiftExpand: s.showMessageActionBarShiftExpand,
				showMessageActionBarOnlyMoreButton: s.showMessageActionBarOnlyMoreButton,
				showDefaultEmojisInAutocomplete: s.showDefaultEmojisInExpressionAutocomplete,
				showCustomEmojisInAutocomplete: s.showCustomEmojisInExpressionAutocomplete,
				showStickersInAutocomplete: s.showStickersInExpressionAutocomplete,
				showMemesInAutocomplete: s.showMemesInExpressionAutocomplete,
				voiceChannelJoinRequiresDoubleClick: s.voiceChannelJoinRequiresDoubleClick,
				customThemeCss: ((): string | undefined => {
					const local = s.customThemeCss;
					const server = s.serverCustomThemeCss;
					return (s.customThemeCssSyncAcrossDevices ? local : server) ?? undefined;
				})(),
				showFavorites: s.showFavorites,
				dmMessagePreviewMode: DM_PREVIEW_TO_PROTO[s.dmMessagePreviewMode],
				enableTtsCommand: s.enableTTSCommand,
				ttsRate: s.ttsRate,
				screenReaderAnnounceNewMessages: s.screenReaderAnnounceNewMessages,
				showFadedUnreadOnMutedChannels: s.showFadedUnreadOnMutedChannels,
				showContextMenuShortcuts: s.showContextMenuShortcuts,
				confirmBeforeStartingCalls: s.confirmBeforeStartingCalls,
				confirmBeforeJoiningVoiceChannels: s.confirmBeforeJoiningVoiceChannels,
				hdrDisplayMode: HDR_TO_PROTO[s.hdrDisplayMode],
				preserveEditDraft: s.preserveEditDraft,
				stayInteractiveWhenUnfocused: s.stayInteractiveWhenUnfocused,
				scrollToBottomOnMessageSend: s.scrollToBottomOnMessageSend,
				messageDoubleClickActions: s.messageDoubleClickActions,
				sequentialFileSend: s.sequentialFileSend,
			}),
			applyMessage: (s, m) => {
				if (m.saturationFactor !== undefined) s.saturationFactor = m.saturationFactor;
				s.alwaysUnderlineLinks = m.alwaysUnderlineLinks;
				if (m.dimStrikethroughText !== undefined) s.dimStrikethroughText = m.dimStrikethroughText;
				if (m.enableTextSelection !== undefined) s.enableTextSelection = m.enableTextSelection;
				if (m.showMessageSendButton !== undefined) s.showMessageSendButton = m.showMessageSendButton;
				if (m.showTextareaFocusRing !== undefined) s.showTextareaFocusRing = m.showTextareaFocusRing;
				s.hideKeyboardHints = m.hideKeyboardHints;
				if (m.escapeExitsKeyboardMode !== undefined) s.escapeExitsKeyboardMode = m.escapeExitsKeyboardMode;
				if (m.messageGroupSpacing !== undefined) {
					const messageGroupSpacing = clampMessageGroupSpacing(m.messageGroupSpacing, s.messageGroupSpacing);
					if (m.compactMessageGroupSpacing === undefined) {
						const spacing = migrateLegacyMessageGroupSpacing(messageGroupSpacing, false);
						s.messageGroupSpacing = spacing.messageGroupSpacing;
						s.compactMessageGroupSpacing = spacing.compactMessageGroupSpacing;
					} else {
						s.messageGroupSpacing = messageGroupSpacing;
					}
				}
				if (m.compactMessageGroupSpacing !== undefined)
					s.compactMessageGroupSpacing = clampMessageGroupSpacing(
						m.compactMessageGroupSpacing,
						s.compactMessageGroupSpacing,
					);
				if (m.messageGutter !== undefined) s.messageGutter = clampMessageGutter(m.messageGutter);
				if (m.fontSize !== undefined) s.fontSize = clampFontSize(m.fontSize);
				if (m.showUserAvatarsInCompactMode !== undefined)
					s.showUserAvatarsInCompactMode = m.showUserAvatarsInCompactMode;
				s.mobileStickerAnimationOverridden = m.mobileStickerAnimationOverridden;
				s.mobileGifAutoPlayOverridden = m.mobileGifAutoplayOverridden;
				s.mobileAnimateEmojiOverridden = m.mobileAnimateEmojiOverridden;
				if (m.mobileStickerAnimationValue !== undefined) s.mobileStickerAnimationValue = m.mobileStickerAnimationValue;
				if (m.mobileGifAutoplayValue !== undefined) s.mobileGifAutoPlayValue = m.mobileGifAutoplayValue;
				if (m.mobileAnimateEmojiValue !== undefined) s.mobileAnimateEmojiValue = m.mobileAnimateEmojiValue;
				s.autoSendKlipyGifs = m.autoSendKlipyGifs;
				if (m.showGifButton !== undefined) s.showGifButton = m.showGifButton;
				if (m.showMemesButton !== undefined) s.showMemesButton = m.showMemesButton;
				if (m.showStickersButton !== undefined) s.showStickersButton = m.showStickersButton;
				if (m.showEmojiButton !== undefined) s.showEmojiButton = m.showEmojiButton;
				if (m.showMediaFavoriteButton !== undefined) s.showMediaFavoriteButton = m.showMediaFavoriteButton;
				if (m.showMediaDownloadButton !== undefined) s.showMediaDownloadButton = m.showMediaDownloadButton;
				if (m.showMediaDeleteButton !== undefined) s.showMediaDeleteButton = m.showMediaDeleteButton;
				if (m.showSuppressEmbedsButton !== undefined) s.showSuppressEmbedsButton = m.showSuppressEmbedsButton;
				if (m.showGifIndicator !== undefined) s.showGifIndicator = m.showGifIndicator;
				if (m.showAttachmentExpiryIndicator !== undefined)
					s.showAttachmentExpiryIndicator = m.showAttachmentExpiryIndicator;
				if (m.useBrowserLocaleForTimeFormat !== undefined)
					s.useBrowserLocaleForTimeFormat = m.useBrowserLocaleForTimeFormat;
				s.channelTypingIndicatorMode = CHANNEL_TYPING_INDICATOR_FROM_PROTO[m.channelTypingIndicatorMode];
				if (m.showMessageActionBar !== undefined) s.showMessageActionBar = m.showMessageActionBar;
				if (m.showMessageActionBarQuickReactions !== undefined)
					s.showMessageActionBarQuickReactions = m.showMessageActionBarQuickReactions;
				if (m.showMessageActionBarShiftExpand !== undefined)
					s.showMessageActionBarShiftExpand = m.showMessageActionBarShiftExpand;
				if (m.showMessageActionBarOnlyMoreButton !== undefined)
					s.showMessageActionBarOnlyMoreButton = m.showMessageActionBarOnlyMoreButton;
				if (m.showDefaultEmojisInAutocomplete !== undefined)
					s.showDefaultEmojisInExpressionAutocomplete = m.showDefaultEmojisInAutocomplete;
				if (m.showCustomEmojisInAutocomplete !== undefined)
					s.showCustomEmojisInExpressionAutocomplete = m.showCustomEmojisInAutocomplete;
				if (m.showStickersInAutocomplete !== undefined)
					s.showStickersInExpressionAutocomplete = m.showStickersInAutocomplete;
				if (m.showMemesInAutocomplete !== undefined) s.showMemesInExpressionAutocomplete = m.showMemesInAutocomplete;
				if (m.voiceChannelJoinRequiresDoubleClick !== undefined)
					s.voiceChannelJoinRequiresDoubleClick = m.voiceChannelJoinRequiresDoubleClick;
				if (m.customThemeCss !== undefined) {
					const customThemeCss = normalizeCustomThemeCss(m.customThemeCss);
					s.serverCustomThemeCss = customThemeCss;
					if (s.customThemeCssSyncAcrossDevices) {
						s.customThemeCss = customThemeCss;
						persistLocalCustomThemeCss(customThemeCss);
					}
				}
				if (m.showFavorites !== undefined) s.showFavorites = m.showFavorites;
				s.dmMessagePreviewMode = DM_PREVIEW_FROM_PROTO[m.dmMessagePreviewMode];
				if (m.enableTtsCommand !== undefined) s.enableTTSCommand = m.enableTtsCommand;
				if (m.ttsRate !== undefined) s.ttsRate = m.ttsRate;
				if (m.screenReaderAnnounceNewMessages !== undefined)
					s.screenReaderAnnounceNewMessages = m.screenReaderAnnounceNewMessages;
				if (m.showFadedUnreadOnMutedChannels !== undefined)
					s.showFadedUnreadOnMutedChannels = m.showFadedUnreadOnMutedChannels;
				if (m.showContextMenuShortcuts !== undefined) s.showContextMenuShortcuts = m.showContextMenuShortcuts;
				if (m.confirmBeforeStartingCalls !== undefined) s.confirmBeforeStartingCalls = m.confirmBeforeStartingCalls;
				if (m.confirmBeforeJoiningVoiceChannels !== undefined)
					s.confirmBeforeJoiningVoiceChannels = m.confirmBeforeJoiningVoiceChannels;
				s.hdrDisplayMode = HDR_FROM_PROTO[m.hdrDisplayMode];
				if (m.preserveEditDraft !== undefined) s.preserveEditDraft = m.preserveEditDraft;
				if (m.stayInteractiveWhenUnfocused !== undefined)
					s.stayInteractiveWhenUnfocused = m.stayInteractiveWhenUnfocused;
				if (m.scrollToBottomOnMessageSend !== undefined) s.scrollToBottomOnMessageSend = m.scrollToBottomOnMessageSend;
				if (m.messageDoubleClickActions !== undefined) s.messageDoubleClickActions = m.messageDoubleClickActions;
				if (m.sequentialFileSend !== undefined) s.sequentialFileSend = m.sequentialFileSend;
			},
		});
		await this.applyStoredZoom();
		runInAction(() => {
			this._hydrated = true;
		});
		this.applyFontSizeDefaultMigrationV1();
	}

	// Micup: the synced accessibility preferences carry font_size 16 for everyone whose client ever synced, chosen or not.
	// Once per device, after that synced value has reached this store, move exactly 16 to the 15px default through the
	// normal settings path (which syncs it back); any other synced size, or none, only records that the check ran.
	private applyFontSizeDefaultMigrationV1(): void {
		try {
			if (AppStorage.getItem(ACCESSIBILITY_FONT_SIZE_DEFAULT_MIGRATED_V1_STORAGE_KEY) !== null) return;
		} catch {
			return;
		}
		const settle = (): boolean => {
			const UserSettings = accessibilityUserSettings.get();
			if (!UserSettings?.isHydrated()) return false;
			const synced = UserSettings.getSubPreference('accessibility')?.fontSize;
			if (synced === PREVIOUS_DEFAULT_FONT_SIZE_PX) {
				if (this.fontSize !== PREVIOUS_DEFAULT_FONT_SIZE_PX) return false;
				this.updateSettings({fontSize: DEFAULT_FONT_SIZE_PX});
			}
			try {
				AppStorage.setItem(ACCESSIBILITY_FONT_SIZE_DEFAULT_MIGRATED_V1_STORAGE_KEY, 'true');
			} catch {}
			return true;
		};
		if (settle()) return;
		const dispose = reaction(
			() => {
				const UserSettings = accessibilityUserSettings.get();
				return [UserSettings?.isHydrated(), UserSettings?.getSubPreference('accessibility')?.fontSize, this.fontSize];
			},
			() => {
				if (settle()) dispose();
			},
		);
	}

	private initializeMotionDetection() {
		if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
			this.mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
			this.systemReducedMotion = this.mediaQuery.matches;
			this.mediaQuery.addEventListener('change', this.handleSystemMotionChange);
		}
	}

	private handleSystemMotionChange = (event: MediaQueryListEvent) => {
		this.systemReducedMotion = event.matches;
	};

	private applyStoredShowNeko(userId: string | null = readStoredSessionUserId(AppStorage)): void {
		const showNeko = readAndMigrateLocalShowNeko(userId);
		if (showNeko === this.showNeko) {
			return;
		}
		runInAction(() => {
			this.showNeko = showNeko;
		});
	}

	private applyStoredKeepNekoStill(userId: string | null = readStoredSessionUserId(AppStorage)): void {
		const keepNekoStill = readAndMigrateLocalKeepNekoStill(userId);
		if (keepNekoStill === this.keepNekoStill) {
			return;
		}
		runInAction(() => {
			this.keepNekoStill = keepNekoStill;
		});
	}

	private initializeZoomStorageSync(): void {
		this.unsubscribeZoomStorage = AppStorage.subscribe(
			() => {
				const zoomLevel = readLocalZoomLevel() ?? DEFAULT_ZOOM_LEVEL;
				if (zoomLevel === this.zoomLevel) {
					return;
				}
				runInAction(() => {
					this.zoomLevel = zoomLevel;
				});
				void this.applyZoom(zoomLevel);
			},
			{
				key: ACCESSIBILITY_ZOOM_STORAGE_KEY,
				source: 'external',
			},
		);
	}

	private get localMotionSettingsSnapshot(): LocalMotionSettings {
		return {
			syncReducedMotionWithSystem: this.syncReducedMotionWithSystem,
			reducedMotionOverride: this.reducedMotionOverride,
			enableSmoothScrolling: this.enableSmoothScrolling,
			keepAnimatedEmojiUnderReducedMotion: this.keepAnimatedEmojiUnderReducedMotion,
			keepGifAutoPlayUnderReducedMotion: this.keepGifAutoPlayUnderReducedMotion,
			keepStickerAnimationUnderReducedMotion: this.keepStickerAnimationUnderReducedMotion,
		};
	}

	private applyStoredMotionSettings(): void {
		const settings = readLocalMotionSettings() ?? DEFAULT_LOCAL_MOTION_SETTINGS;
		if (
			settings.syncReducedMotionWithSystem === this.syncReducedMotionWithSystem &&
			settings.reducedMotionOverride === this.reducedMotionOverride &&
			settings.enableSmoothScrolling === this.enableSmoothScrolling &&
			settings.keepAnimatedEmojiUnderReducedMotion === this.keepAnimatedEmojiUnderReducedMotion &&
			settings.keepGifAutoPlayUnderReducedMotion === this.keepGifAutoPlayUnderReducedMotion &&
			settings.keepStickerAnimationUnderReducedMotion === this.keepStickerAnimationUnderReducedMotion
		) {
			return;
		}
		runInAction(() => {
			this.syncReducedMotionWithSystem = settings.syncReducedMotionWithSystem;
			this.reducedMotionOverride = settings.reducedMotionOverride;
			this.enableSmoothScrolling = settings.enableSmoothScrolling;
			this.keepAnimatedEmojiUnderReducedMotion = settings.keepAnimatedEmojiUnderReducedMotion;
			this.keepGifAutoPlayUnderReducedMotion = settings.keepGifAutoPlayUnderReducedMotion;
			this.keepStickerAnimationUnderReducedMotion = settings.keepStickerAnimationUnderReducedMotion;
		});
	}

	private initializeMotionStorageSync(): void {
		this.unsubscribeMotionStorage = AppStorage.subscribe(
			() => {
				this.applyStoredMotionSettings();
			},
			{
				key: ACCESSIBILITY_MOTION_STORAGE_KEY,
				source: 'external',
			},
		);
	}

	private initializeShowNekoSessionSync(): void {
		this.unsubscribeShowNekoSession = AppStorage.subscribe(
			() => {
				this.applyStoredShowNeko();
				this.applyStoredKeepNekoStill();
			},
			{
				key: AuthSessionStorageKey.UserId,
				source: 'any',
			},
		);
	}

	private initializeShowNekoStorageSync(): void {
		this.unsubscribeShowNekoStorage = AppStorage.subscribe(
			(event) => {
				if (
					event.key !== null &&
					event.key !== ACCESSIBILITY_SHOW_NEKO_STORAGE_KEY &&
					event.key !== ACCESSIBILITY_KEEP_NEKO_STILL_STORAGE_KEY &&
					event.key !== ACCESSIBILITY_PIN_NEKO_TO_TEXTAREA_STORAGE_KEY
				) {
					const userId = readStoredSessionUserId(AppStorage);
					if (
						userId === null ||
						(event.key !== getShowNekoStorageKey(userId) &&
							event.key !== getKeepNekoStillStorageKey(userId) &&
							event.key !== getLegacyPinNekoToTextareaStorageKey(userId))
					) {
						return;
					}
				}
				this.applyStoredShowNeko();
				this.applyStoredKeepNekoStill();
			},
			{source: 'external'},
		);
	}

	private applyStoredVideoSeekPreviewThumbnails(): void {
		const showVideoSeekPreviewThumbnails = readLocalVideoSeekPreviewThumbnails();
		if (showVideoSeekPreviewThumbnails === this.showVideoSeekPreviewThumbnails) {
			return;
		}
		runInAction(() => {
			this.showVideoSeekPreviewThumbnails = showVideoSeekPreviewThumbnails;
		});
	}

	private initializeVideoSeekPreviewThumbnailsStorageSync(): void {
		this.unsubscribeVideoSeekPreviewThumbnailsStorage = AppStorage.subscribe(
			() => {
				this.applyStoredVideoSeekPreviewThumbnails();
			},
			{
				key: ACCESSIBILITY_VIDEO_SEEK_PREVIEW_THUMBNAILS_STORAGE_KEY,
				source: 'external',
			},
		);
	}

	private applyStoredShowNameStyles(): void {
		const showNameStyles = readLocalShowNameStyles();
		if (showNameStyles === this.showNameStyles) {
			return;
		}
		runInAction(() => {
			this.showNameStyles = showNameStyles;
		});
	}

	private initializeShowNameStylesStorageSync(): void {
		this.unsubscribeShowNameStylesStorage = AppStorage.subscribe(
			() => {
				this.applyStoredShowNameStyles();
			},
			{
				key: ACCESSIBILITY_SHOW_NAME_STYLES_STORAGE_KEY,
				source: 'external',
			},
		);
	}

	dispose() {
		if (this.mediaQuery) {
			this.mediaQuery.removeEventListener('change', this.handleSystemMotionChange);
			this.mediaQuery = null;
		}
		this.unsubscribeZoomStorage?.();
		this.unsubscribeZoomStorage = null;
		this.unsubscribeMotionStorage?.();
		this.unsubscribeMotionStorage = null;
		this.unsubscribeShowNekoSession?.();
		this.unsubscribeShowNekoSession = null;
		this.unsubscribeShowNekoStorage?.();
		this.unsubscribeShowNekoStorage = null;
		this.unsubscribeVideoSeekPreviewThumbnailsStorage?.();
		this.unsubscribeVideoSeekPreviewThumbnailsStorage = null;
		this.unsubscribeShowNameStylesStorage?.();
		this.unsubscribeShowNameStylesStorage = null;
	}

	get textSelectionEnabled(): boolean {
		return MobileLayout.isMobileLayout() ? false : this.enableTextSelection;
	}

	get useReducedMotion(): boolean {
		return resolveStartupReducedMotion(this, this.systemReducedMotion);
	}

	get useSmoothScrolling(): boolean {
		return !this.useReducedMotion;
	}

	isAnimationKeptUnderReducedMotion(kind: AnimatedMediaKind): boolean {
		switch (kind) {
			case 'emoji':
				return this.keepAnimatedEmojiUnderReducedMotion;
			case 'gif':
				return this.keepGifAutoPlayUnderReducedMotion;
			case 'sticker':
				return this.keepStickerAnimationUnderReducedMotion;
		}
	}

	getMessageGroupSpacingValue(messageDisplayCompact: boolean): number {
		return MobileLayout.isMobileLayout()
			? COMFY_MESSAGE_GROUP_SPACING_DEFAULT
			: getMessageGroupSpacingForDisplayMode(this, messageDisplayCompact);
	}

	updateSettings(data: Readonly<Partial<AccessibilitySettings>>): void {
		const validated = this.validateSettings(data);
		const hasCustomThemeCssUpdate = Object.hasOwn(data, 'customThemeCss');
		const hasMotionSettingsUpdate =
			Object.hasOwn(data, 'syncReducedMotionWithSystem') ||
			Object.hasOwn(data, 'reducedMotionOverride') ||
			Object.hasOwn(data, 'enableSmoothScrolling') ||
			Object.hasOwn(data, 'keepAnimatedEmojiUnderReducedMotion') ||
			Object.hasOwn(data, 'keepGifAutoPlayUnderReducedMotion') ||
			Object.hasOwn(data, 'keepStickerAnimationUnderReducedMotion');
		if (validated.saturationFactor !== undefined) this.saturationFactor = validated.saturationFactor;
		if (validated.alwaysUnderlineLinks !== undefined) this.alwaysUnderlineLinks = validated.alwaysUnderlineLinks;
		if (validated.dimStrikethroughText !== undefined) this.dimStrikethroughText = validated.dimStrikethroughText;
		if (validated.enableTextSelection !== undefined) this.enableTextSelection = validated.enableTextSelection;
		if (validated.showMessageSendButton !== undefined) this.showMessageSendButton = validated.showMessageSendButton;
		if (validated.showTextareaFocusRing !== undefined) this.showTextareaFocusRing = validated.showTextareaFocusRing;
		if (validated.hideKeyboardHints !== undefined) this.hideKeyboardHints = validated.hideKeyboardHints;
		if (validated.escapeExitsKeyboardMode !== undefined)
			this.escapeExitsKeyboardMode = validated.escapeExitsKeyboardMode;
		if (validated.syncReducedMotionWithSystem !== undefined)
			this.syncReducedMotionWithSystem = validated.syncReducedMotionWithSystem;
		if (validated.reducedMotionOverride !== undefined) this.reducedMotionOverride = validated.reducedMotionOverride;
		if (validated.enableSmoothScrolling !== undefined) this.enableSmoothScrolling = validated.enableSmoothScrolling;
		if (validated.keepAnimatedEmojiUnderReducedMotion !== undefined)
			this.keepAnimatedEmojiUnderReducedMotion = validated.keepAnimatedEmojiUnderReducedMotion;
		if (validated.keepGifAutoPlayUnderReducedMotion !== undefined)
			this.keepGifAutoPlayUnderReducedMotion = validated.keepGifAutoPlayUnderReducedMotion;
		if (validated.keepStickerAnimationUnderReducedMotion !== undefined)
			this.keepStickerAnimationUnderReducedMotion = validated.keepStickerAnimationUnderReducedMotion;
		if (hasMotionSettingsUpdate) {
			persistLocalMotionSettings(this.localMotionSettingsSnapshot);
		}
		if (validated.messageGroupSpacing !== undefined) this.messageGroupSpacing = validated.messageGroupSpacing;
		if (validated.compactMessageGroupSpacing !== undefined)
			this.compactMessageGroupSpacing = validated.compactMessageGroupSpacing;
		if (validated.messageGutter !== undefined) this.messageGutter = validated.messageGutter;
		if (validated.fontSize !== undefined) this.fontSize = validated.fontSize;
		if (validated.showUserAvatarsInCompactMode !== undefined)
			this.showUserAvatarsInCompactMode = validated.showUserAvatarsInCompactMode;
		if (validated.mobileStickerAnimationOverridden !== undefined)
			this.mobileStickerAnimationOverridden = validated.mobileStickerAnimationOverridden;
		if (validated.mobileGifAutoPlayOverridden !== undefined)
			this.mobileGifAutoPlayOverridden = validated.mobileGifAutoPlayOverridden;
		if (validated.mobileAnimateEmojiOverridden !== undefined)
			this.mobileAnimateEmojiOverridden = validated.mobileAnimateEmojiOverridden;
		if (validated.mobileStickerAnimationValue !== undefined)
			this.mobileStickerAnimationValue = validated.mobileStickerAnimationValue;
		if (validated.mobileGifAutoPlayValue !== undefined) this.mobileGifAutoPlayValue = validated.mobileGifAutoPlayValue;
		if (validated.mobileAnimateEmojiValue !== undefined)
			this.mobileAnimateEmojiValue = validated.mobileAnimateEmojiValue;
		if (validated.autoSendKlipyGifs !== undefined) this.autoSendKlipyGifs = validated.autoSendKlipyGifs;
		if (validated.showGifButton !== undefined) this.showGifButton = validated.showGifButton;
		if (validated.showMemesButton !== undefined) this.showMemesButton = validated.showMemesButton;
		if (validated.showStickersButton !== undefined) this.showStickersButton = validated.showStickersButton;
		if (validated.showEmojiButton !== undefined) this.showEmojiButton = validated.showEmojiButton;
		if (validated.showMediaFavoriteButton !== undefined)
			this.showMediaFavoriteButton = validated.showMediaFavoriteButton;
		if (validated.showMediaDownloadButton !== undefined)
			this.showMediaDownloadButton = validated.showMediaDownloadButton;
		if (validated.showMediaDeleteButton !== undefined) this.showMediaDeleteButton = validated.showMediaDeleteButton;
		if (validated.showSuppressEmbedsButton !== undefined)
			this.showSuppressEmbedsButton = validated.showSuppressEmbedsButton;
		if (validated.showGifIndicator !== undefined) this.showGifIndicator = validated.showGifIndicator;
		if (validated.showAttachmentExpiryIndicator !== undefined)
			this.showAttachmentExpiryIndicator = validated.showAttachmentExpiryIndicator;
		if (validated.useBrowserLocaleForTimeFormat !== undefined)
			this.useBrowserLocaleForTimeFormat = validated.useBrowserLocaleForTimeFormat;
		if (validated.channelTypingIndicatorMode !== undefined)
			this.channelTypingIndicatorMode = validated.channelTypingIndicatorMode;
		if (validated.showMessageActionBar !== undefined) this.showMessageActionBar = validated.showMessageActionBar;
		if (validated.showMessageActionBarQuickReactions !== undefined)
			this.showMessageActionBarQuickReactions = validated.showMessageActionBarQuickReactions;
		if (validated.showMessageActionBarShiftExpand !== undefined)
			this.showMessageActionBarShiftExpand = validated.showMessageActionBarShiftExpand;
		if (validated.showMessageActionBarOnlyMoreButton !== undefined)
			this.showMessageActionBarOnlyMoreButton = validated.showMessageActionBarOnlyMoreButton;
		if (validated.showDefaultEmojisInExpressionAutocomplete !== undefined)
			this.showDefaultEmojisInExpressionAutocomplete = validated.showDefaultEmojisInExpressionAutocomplete;
		if (validated.showCustomEmojisInExpressionAutocomplete !== undefined)
			this.showCustomEmojisInExpressionAutocomplete = validated.showCustomEmojisInExpressionAutocomplete;
		if (validated.showStickersInExpressionAutocomplete !== undefined)
			this.showStickersInExpressionAutocomplete = validated.showStickersInExpressionAutocomplete;
		if (validated.showMemesInExpressionAutocomplete !== undefined)
			this.showMemesInExpressionAutocomplete = validated.showMemesInExpressionAutocomplete;
		if (validated.voiceChannelJoinRequiresDoubleClick !== undefined)
			this.voiceChannelJoinRequiresDoubleClick = validated.voiceChannelJoinRequiresDoubleClick;
		if (hasCustomThemeCssUpdate) {
			const customThemeCss = normalizeCustomThemeCss(data.customThemeCss);
			this.customThemeCss = customThemeCss;
			persistLocalCustomThemeCss(customThemeCss);
		}
		if (validated.customThemeCssSyncAcrossDevices !== undefined)
			this.setCustomThemeCssSyncAcrossDevices(validated.customThemeCssSyncAcrossDevices);
		if (validated.showFavorites !== undefined) this.showFavorites = validated.showFavorites;
		if (validated.zoomLevel !== undefined) this.setZoomLevel(validated.zoomLevel);
		if (validated.dmMessagePreviewMode !== undefined) this.dmMessagePreviewMode = validated.dmMessagePreviewMode;
		if (validated.enableTTSCommand !== undefined) this.enableTTSCommand = validated.enableTTSCommand;
		if (validated.ttsRate !== undefined) this.ttsRate = validated.ttsRate;
		if (validated.screenReaderAnnounceNewMessages !== undefined)
			this.screenReaderAnnounceNewMessages = validated.screenReaderAnnounceNewMessages;
		if (validated.showFadedUnreadOnMutedChannels !== undefined)
			this.showFadedUnreadOnMutedChannels = validated.showFadedUnreadOnMutedChannels;
		if (validated.showContextMenuShortcuts !== undefined)
			this.showContextMenuShortcuts = validated.showContextMenuShortcuts;
		if (validated.confirmBeforeStartingCalls !== undefined)
			this.confirmBeforeStartingCalls = validated.confirmBeforeStartingCalls;
		if (validated.confirmBeforeJoiningVoiceChannels !== undefined)
			this.confirmBeforeJoiningVoiceChannels = validated.confirmBeforeJoiningVoiceChannels;
		if (validated.hdrDisplayMode !== undefined) this.hdrDisplayMode = validated.hdrDisplayMode;
		if (validated.preserveEditDraft !== undefined) this.preserveEditDraft = validated.preserveEditDraft;
		if (validated.stayInteractiveWhenUnfocused !== undefined)
			this.stayInteractiveWhenUnfocused = validated.stayInteractiveWhenUnfocused;
		if (validated.scrollToBottomOnMessageSend !== undefined)
			this.scrollToBottomOnMessageSend = validated.scrollToBottomOnMessageSend;
		if (validated.messageDoubleClickActions !== undefined)
			this.messageDoubleClickActions = validated.messageDoubleClickActions;
		if (validated.sequentialFileSend !== undefined) this.sequentialFileSend = validated.sequentialFileSend;
		if (validated.showNeko !== undefined && validated.showNeko !== this.showNeko) {
			this.showNeko = validated.showNeko;
			persistLocalShowNeko(validated.showNeko);
		}
		if (validated.keepNekoStill !== undefined && validated.keepNekoStill !== this.keepNekoStill) {
			this.keepNekoStill = validated.keepNekoStill;
			persistLocalKeepNekoStill(validated.keepNekoStill);
		}
		if (
			validated.showVideoSeekPreviewThumbnails !== undefined &&
			validated.showVideoSeekPreviewThumbnails !== this.showVideoSeekPreviewThumbnails
		) {
			this.showVideoSeekPreviewThumbnails = validated.showVideoSeekPreviewThumbnails;
			persistLocalVideoSeekPreviewThumbnails(validated.showVideoSeekPreviewThumbnails);
		}
		if (validated.showNameStyles !== undefined && validated.showNameStyles !== this.showNameStyles) {
			this.showNameStyles = validated.showNameStyles;
			persistLocalShowNameStyles(validated.showNameStyles);
		}
	}

	private validateSettings(data: Readonly<Partial<AccessibilitySettings>>): Partial<AccessibilitySettings> {
		return {
			saturationFactor: Math.max(0, Math.min(1, data.saturationFactor ?? this.saturationFactor)),
			alwaysUnderlineLinks: data.alwaysUnderlineLinks ?? this.alwaysUnderlineLinks,
			dimStrikethroughText: data.dimStrikethroughText ?? this.dimStrikethroughText,
			enableTextSelection: data.enableTextSelection ?? this.enableTextSelection,
			showMessageSendButton: data.showMessageSendButton ?? this.showMessageSendButton,
			showTextareaFocusRing: data.showTextareaFocusRing ?? this.showTextareaFocusRing,
			hideKeyboardHints: data.hideKeyboardHints ?? this.hideKeyboardHints,
			escapeExitsKeyboardMode: data.escapeExitsKeyboardMode ?? this.escapeExitsKeyboardMode,
			syncReducedMotionWithSystem: data.syncReducedMotionWithSystem ?? this.syncReducedMotionWithSystem,
			reducedMotionOverride: data.reducedMotionOverride ?? this.reducedMotionOverride,
			enableSmoothScrolling: data.enableSmoothScrolling ?? this.enableSmoothScrolling,
			keepAnimatedEmojiUnderReducedMotion:
				data.keepAnimatedEmojiUnderReducedMotion ?? this.keepAnimatedEmojiUnderReducedMotion,
			keepGifAutoPlayUnderReducedMotion:
				data.keepGifAutoPlayUnderReducedMotion ?? this.keepGifAutoPlayUnderReducedMotion,
			keepStickerAnimationUnderReducedMotion:
				data.keepStickerAnimationUnderReducedMotion ?? this.keepStickerAnimationUnderReducedMotion,
			messageGroupSpacing: clampMessageGroupSpacing(
				data.messageGroupSpacing ?? this.messageGroupSpacing,
				this.messageGroupSpacing,
			),
			compactMessageGroupSpacing: clampMessageGroupSpacing(
				data.compactMessageGroupSpacing ?? this.compactMessageGroupSpacing,
				this.compactMessageGroupSpacing,
			),
			messageGutter: clampMessageGutter(data.messageGutter ?? this.messageGutter),
			fontSize: clampFontSize(data.fontSize ?? this.fontSize),
			showUserAvatarsInCompactMode: data.showUserAvatarsInCompactMode ?? this.showUserAvatarsInCompactMode,
			mobileStickerAnimationOverridden: data.mobileStickerAnimationOverridden ?? this.mobileStickerAnimationOverridden,
			mobileGifAutoPlayOverridden: data.mobileGifAutoPlayOverridden ?? this.mobileGifAutoPlayOverridden,
			mobileAnimateEmojiOverridden: data.mobileAnimateEmojiOverridden ?? this.mobileAnimateEmojiOverridden,
			mobileStickerAnimationValue: data.mobileStickerAnimationValue ?? this.mobileStickerAnimationValue,
			mobileGifAutoPlayValue: data.mobileGifAutoPlayValue ?? this.mobileGifAutoPlayValue,
			mobileAnimateEmojiValue: data.mobileAnimateEmojiValue ?? this.mobileAnimateEmojiValue,
			autoSendKlipyGifs: data.autoSendKlipyGifs ?? this.autoSendKlipyGifs,
			showGifButton: data.showGifButton ?? this.showGifButton,
			showMemesButton: data.showMemesButton ?? this.showMemesButton,
			showStickersButton: data.showStickersButton ?? this.showStickersButton,
			showEmojiButton: data.showEmojiButton ?? this.showEmojiButton,
			showMediaFavoriteButton: data.showMediaFavoriteButton ?? this.showMediaFavoriteButton,
			showMediaDownloadButton: data.showMediaDownloadButton ?? this.showMediaDownloadButton,
			showMediaDeleteButton: data.showMediaDeleteButton ?? this.showMediaDeleteButton,
			showSuppressEmbedsButton: data.showSuppressEmbedsButton ?? this.showSuppressEmbedsButton,
			showGifIndicator: data.showGifIndicator ?? this.showGifIndicator,
			showAttachmentExpiryIndicator:
				typeof data.showAttachmentExpiryIndicator === 'boolean'
					? data.showAttachmentExpiryIndicator
					: this.showAttachmentExpiryIndicator,
			useBrowserLocaleForTimeFormat: data.useBrowserLocaleForTimeFormat ?? this.useBrowserLocaleForTimeFormat,
			channelTypingIndicatorMode: data.channelTypingIndicatorMode ?? this.channelTypingIndicatorMode,
			showMessageActionBar: data.showMessageActionBar ?? this.showMessageActionBar,
			showMessageActionBarQuickReactions:
				data.showMessageActionBarQuickReactions ?? this.showMessageActionBarQuickReactions,
			showMessageActionBarShiftExpand: data.showMessageActionBarShiftExpand ?? this.showMessageActionBarShiftExpand,
			showMessageActionBarOnlyMoreButton:
				data.showMessageActionBarOnlyMoreButton ?? this.showMessageActionBarOnlyMoreButton,
			showDefaultEmojisInExpressionAutocomplete:
				data.showDefaultEmojisInExpressionAutocomplete ?? this.showDefaultEmojisInExpressionAutocomplete,
			showCustomEmojisInExpressionAutocomplete:
				data.showCustomEmojisInExpressionAutocomplete ?? this.showCustomEmojisInExpressionAutocomplete,
			showStickersInExpressionAutocomplete:
				data.showStickersInExpressionAutocomplete ?? this.showStickersInExpressionAutocomplete,
			showMemesInExpressionAutocomplete:
				data.showMemesInExpressionAutocomplete ?? this.showMemesInExpressionAutocomplete,
			voiceChannelJoinRequiresDoubleClick:
				data.voiceChannelJoinRequiresDoubleClick ?? this.voiceChannelJoinRequiresDoubleClick,
			customThemeCss: data.customThemeCss !== undefined ? data.customThemeCss : this.customThemeCss,
			customThemeCssSyncAcrossDevices: data.customThemeCssSyncAcrossDevices ?? this.customThemeCssSyncAcrossDevices,
			showFavorites: data.showFavorites ?? this.showFavorites,
			zoomLevel: clampZoomLevel(data.zoomLevel ?? this.zoomLevel),
			dmMessagePreviewMode: data.dmMessagePreviewMode ?? this.dmMessagePreviewMode,
			enableTTSCommand: data.enableTTSCommand ?? this.enableTTSCommand,
			ttsRate: Math.max(0.1, Math.min(2.0, data.ttsRate ?? this.ttsRate)),
			screenReaderAnnounceNewMessages: data.screenReaderAnnounceNewMessages ?? this.screenReaderAnnounceNewMessages,
			showFadedUnreadOnMutedChannels: data.showFadedUnreadOnMutedChannels ?? this.showFadedUnreadOnMutedChannels,
			showContextMenuShortcuts: data.showContextMenuShortcuts ?? this.showContextMenuShortcuts,
			confirmBeforeStartingCalls: data.confirmBeforeStartingCalls ?? this.confirmBeforeStartingCalls,
			confirmBeforeJoiningVoiceChannels:
				data.confirmBeforeJoiningVoiceChannels ?? this.confirmBeforeJoiningVoiceChannels,
			hdrDisplayMode: data.hdrDisplayMode ?? this.hdrDisplayMode,
			preserveEditDraft: data.preserveEditDraft ?? this.preserveEditDraft,
			stayInteractiveWhenUnfocused: data.stayInteractiveWhenUnfocused ?? this.stayInteractiveWhenUnfocused,
			scrollToBottomOnMessageSend: data.scrollToBottomOnMessageSend ?? this.scrollToBottomOnMessageSend,
			messageDoubleClickActions: data.messageDoubleClickActions ?? this.messageDoubleClickActions,
			sequentialFileSend: data.sequentialFileSend ?? this.sequentialFileSend,
			showNeko: data.showNeko ?? this.showNeko,
			keepNekoStill: data.keepNekoStill ?? this.keepNekoStill,
			showVideoSeekPreviewThumbnails: data.showVideoSeekPreviewThumbnails ?? this.showVideoSeekPreviewThumbnails,
			showNameStyles: data.showNameStyles ?? this.showNameStyles,
		};
	}

	setCustomThemeCssSyncAcrossDevices(syncAcrossDevices: boolean): void {
		if (syncAcrossDevices === this.customThemeCssSyncAcrossDevices) {
			return;
		}
		if (syncAcrossDevices && !this.customThemeCss?.trim() && this.serverCustomThemeCss?.trim()) {
			this.customThemeCss = this.serverCustomThemeCss;
			persistLocalCustomThemeCss(this.customThemeCss);
		}
		this.customThemeCssSyncAcrossDevices = syncAcrossDevices;
		persistLocalCustomThemeCssSyncAcrossDevices(syncAcrossDevices);
	}

	subscribe(callback: () => void): () => void {
		return reaction(
			() => ({
				messageGroupSpacing: this.messageGroupSpacing,
				compactMessageGroupSpacing: this.compactMessageGroupSpacing,
			}),
			() => callback(),
			{fireImmediately: true},
		);
	}

	async adjustZoom(direction: 1 | -1): Promise<void> {
		this.updateSettings({zoomLevel: nextZoomLevel(this.zoomLevel, direction)});
	}

	private setZoomLevel(level: number): void {
		const zoomLevel = clampZoomLevel(level);
		this.zoomLevel = zoomLevel;
		persistLocalZoomLevel(zoomLevel);
		void this.applyZoom(zoomLevel);
	}

	async applyZoom(level: number): Promise<void> {
		const zoomLevel = clampZoomLevel(level);
		applyAppZoomToDocument(zoomLevel * 100, window.electron);
		writeZoomPrebootMirror(zoomLevel, window.electron != null);
	}

	async applyStoredZoom(): Promise<void> {
		const zoomLevel = clampZoomLevel(readLocalZoomLevel() ?? this.zoomLevel);
		this.zoomLevel = zoomLevel;
		persistLocalZoomLevel(zoomLevel);
		await this.applyZoom(zoomLevel);
	}

	private initializeCustomThemeCssStorageSync(): void {
		AppStorage.subscribe(
			(event) => {
				if (
					event.key !== null &&
					event.key !== ACCESSIBILITY_CUSTOM_THEME_STORAGE_KEY &&
					event.key !== ACCESSIBILITY_CUSTOM_THEME_SYNC_STORAGE_KEY
				) {
					return;
				}
				runInAction(() => {
					this.customThemeCss = readLocalCustomThemeCss();
					this.customThemeCssSyncAcrossDevices = readLocalCustomThemeCssSyncAcrossDevices();
				});
			},
			{source: 'external'},
		);
	}

	private applyStartupPresentationSettings(): void {
		document.documentElement.classList.toggle('reduced-motion', this.useReducedMotion);
		void this.applyZoom(this.zoomLevel);
	}
}

export default new Accessibility();
