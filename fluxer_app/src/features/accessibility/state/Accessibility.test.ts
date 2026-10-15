// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/user/state/SyncedField', () => ({makeSyncedField: vi.fn(async () => {})}));

const ZOOM_STORAGE_KEY = 'Accessibility:zoomLevel';
const ZOOM_95_MIGRATED_KEY = 'Accessibility:zoomLevelDefault95MigratedV1';
const ZOOM_100_MIGRATED_KEY = 'Accessibility:zoomLevelDefault100MigratedV1';
const ZOOM_95_RESTORED_KEY = 'Accessibility:zoomLevelDefault95RestoredV1';

const zoomVisibility = vi.hoisted(() => ({shown: true}));
vi.mock('@app/features/user/components/settings_utils/AppZoomLevelUtils', () => ({
	shouldShowAppZoomLevel: () => zoomVisibility.shown,
}));

async function loadAccessibilityModule() {
	vi.resetModules();
	return import('@app/features/accessibility/state/Accessibility');
}

async function loadAccessibility() {
	return (await loadAccessibilityModule()).default;
}

describe('Accessibility default app zoom', () => {
	beforeEach(() => {
		window.localStorage.clear();
		document.documentElement.removeAttribute('style');
		zoomVisibility.shown = true;
	});

	afterEach(() => {
		window.localStorage.clear();
		delete (window as {electron?: unknown}).electron;
	});

	it('matches the desktop preload first paint (95%) on a fresh desktop install', async () => {
		const setZoomFactor = vi.fn();
		(window as {electron?: unknown}).electron = {setZoomFactor};

		const accessibility = await loadAccessibility();

		expect(accessibility.zoomLevel).toBe(0.95);
		expect(document.documentElement.style.getPropertyValue('--custom-zoom')).toBe('95');
		expect(setZoomFactor).toHaveBeenCalledWith(1);
	});

	it('starts a fresh install at 95% and writes --custom-zoom on the web', async () => {
		const accessibility = await loadAccessibility();

		expect(accessibility.zoomLevel).toBe(0.95);
		expect(document.documentElement.style.getPropertyValue('--custom-zoom')).toBe('95');
		expect(window.localStorage.getItem(ZOOM_95_RESTORED_KEY)).toBe('true');
	});

	it('keeps phone browsers, which hide the zoom setting, at 100%', async () => {
		zoomVisibility.shown = false;
		window.localStorage.setItem(ZOOM_STORAGE_KEY, '1');
		window.localStorage.setItem(ZOOM_100_MIGRATED_KEY, 'true');

		const accessibility = await loadAccessibility();

		expect(accessibility.zoomLevel).toBe(1);
		expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1');
	});

	it('persists zoom under the unprefixed Accessibility:zoomLevel key the desktop preload reads', async () => {
		const accessibility = await loadAccessibility();

		accessibility.updateSettings({zoomLevel: 1.25});

		expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1.25');
		expect(window.localStorage.getItem('AccessibilityStore:zoomLevel')).toBeNull();
	});

	it('keeps 15px chat text and 16px message group spacing at the 95% default', async () => {
		const accessibility = await loadAccessibility();

		expect(accessibility.zoomLevel).toBe(0.95);
		expect(accessibility.fontSize).toBe(15);
		expect(accessibility.getMessageGroupSpacingValue(false)).toBe(16);
	});

	it.each([
		['100% given by the 100% build', '1', [ZOOM_100_MIGRATED_KEY]],
		['100% given by the 100% build after the 80% move', '1', [ZOOM_95_MIGRATED_KEY, ZOOM_100_MIGRATED_KEY]],
		['the old 80% default that never got a move', '0.8', []],
	])('moves a zoom saved at %s to 95% once', async (_label, stored, flags) => {
		window.localStorage.setItem(ZOOM_STORAGE_KEY, stored);
		for (const flag of flags) window.localStorage.setItem(flag, 'true');

		const accessibility = await loadAccessibility();

		expect(accessibility.zoomLevel).toBe(0.95);
		expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('0.95');
		expect(window.localStorage.getItem(ZOOM_95_RESTORED_KEY)).toBe('true');
		expect(document.documentElement.style.getPropertyValue('--custom-zoom')).toBe('95');
	});

	it.each([
		['a 100% chosen under the 95% build', '1', [ZOOM_95_MIGRATED_KEY]],
		['an 80% chosen under the 95% build', '0.8', [ZOOM_95_MIGRATED_KEY]],
		['an 80% chosen under the 100% build', '0.8', [ZOOM_95_MIGRATED_KEY, ZOOM_100_MIGRATED_KEY]],
		['a 125% chosen under the 100% build', '1.25', [ZOOM_100_MIGRATED_KEY]],
		['a 125% with no flag', '1.25', []],
		['the 95% default', '0.95', [ZOOM_95_MIGRATED_KEY]],
	])('keeps %s', async (_label, stored, flags) => {
		window.localStorage.setItem(ZOOM_STORAGE_KEY, stored);
		for (const flag of flags) window.localStorage.setItem(flag, 'true');

		const accessibility = await loadAccessibility();

		expect(accessibility.zoomLevel).toBe(Number(stored));
		expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe(stored);
	});

	it('keeps 100% when the user picks it again after the one-time move', async () => {
		window.localStorage.setItem(ZOOM_STORAGE_KEY, '1');
		window.localStorage.setItem(ZOOM_100_MIGRATED_KEY, 'true');
		const first = await loadAccessibility();
		first.updateSettings({zoomLevel: 1});

		const accessibility = await loadAccessibility();

		expect(accessibility.zoomLevel).toBe(1);
		expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1');
	});

	it('keeps a chosen 80% after an auth-failure storage reset and an in-page re-login', async () => {
		window.localStorage.setItem(ZOOM_STORAGE_KEY, '0.8');
		const accessibility = await loadAccessibility();
		accessibility.updateSettings({zoomLevel: 0.8});
		const {resetAppStorage, PRESERVED_RESET_STORAGE_KEYS} = await import(
			'@app/features/platform/state/PersistentStorage'
		);
		await resetAppStorage(PRESERVED_RESET_STORAGE_KEYS);
		accessibility.updateSettings({showFavorites: false});
		expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('0.8');

		const reopened = await loadAccessibility();

		expect(reopened.zoomLevel).toBe(0.8);
		expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('0.8');
	});

	it('keeps the upstream zoom slider markers and resets to 95%', async () => {
		const {DEFAULT_ZOOM_LEVEL, ZOOM_LEVEL_MARKERS} = await loadAccessibilityModule();

		expect(ZOOM_LEVEL_MARKERS).toEqual([0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]);
		expect(Math.round(DEFAULT_ZOOM_LEVEL * 100)).toBe(95);
	});

	it('paints 95% from the stylesheet before the app writes --custom-zoom', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../app/globals.css'), 'utf8');

		expect(css).toMatch(/html \{\s*--custom-zoom: 95;[^}]*font-size: calc\(var\(--custom-zoom, 95\) \* 0\.16px\);/);
	});
});

const MOTION_STORAGE_KEY = 'Accessibility:motion';
const MOTION_MIGRATED_KEY = 'Accessibility:motionSyncDefaultOffMigratedV1';

function storeMotion(syncReducedMotionWithSystem: boolean, reducedMotionOverride: boolean | null): void {
	window.localStorage.setItem(
		MOTION_STORAGE_KEY,
		JSON.stringify({
			syncReducedMotionWithSystem,
			reducedMotionOverride,
			enableSmoothScrolling: false,
			keepAnimatedEmojiUnderReducedMotion: false,
			keepGifAutoPlayUnderReducedMotion: false,
			keepStickerAnimationUnderReducedMotion: false,
		}),
	);
}

function readStoredMotion(): {syncReducedMotionWithSystem: boolean; reducedMotionOverride: boolean | null} {
	return JSON.parse(window.localStorage.getItem(MOTION_STORAGE_KEY) ?? 'null');
}

describe('Accessibility default motion', () => {
	beforeEach(() => {
		window.localStorage.clear();
		document.documentElement.classList.remove('reduced-motion');
		const matchMedia = window.matchMedia.bind(window);
		vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
			query === '(prefers-reduced-motion: reduce)'
				? ({
						matches: true,
						media: query,
						addEventListener: vi.fn(),
						removeEventListener: vi.fn(),
					} as unknown as MediaQueryList)
				: matchMedia(query),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		window.localStorage.clear();
	});

	it('plays animations on a fresh device even when the system asks for reduced motion', async () => {
		const accessibility = await loadAccessibility();

		expect(accessibility.systemReducedMotion).toBe(true);
		expect(accessibility.syncReducedMotionWithSystem).toBe(false);
		expect(accessibility.useReducedMotion).toBe(false);
		expect(document.documentElement.classList.contains('reduced-motion')).toBe(false);
		expect(window.localStorage.getItem(MOTION_MIGRATED_KEY)).toBe('true');
	});

	it('moves the untouched old default (sync on, no override) off once and keeps the other motion settings', async () => {
		storeMotion(true, null);

		const accessibility = await loadAccessibility();

		expect(accessibility.syncReducedMotionWithSystem).toBe(false);
		expect(accessibility.reducedMotionOverride).toBeNull();
		expect(accessibility.useReducedMotion).toBe(false);
		expect(accessibility.enableSmoothScrolling).toBe(false);
		expect(readStoredMotion()).toMatchObject({syncReducedMotionWithSystem: false, reducedMotionOverride: null});
		expect(window.localStorage.getItem(MOTION_MIGRATED_KEY)).toBe('true');
	});

	it('keeps sync on when the user turns it back on after the move', async () => {
		storeMotion(true, null);
		const first = await loadAccessibility();
		first.updateSettings({syncReducedMotionWithSystem: true});

		const accessibility = await loadAccessibility();

		expect(accessibility.syncReducedMotionWithSystem).toBe(true);
		expect(accessibility.useReducedMotion).toBe(true);
		expect(readStoredMotion().syncReducedMotionWithSystem).toBe(true);
	});

	it('keeps a native sync choice and migration marker through hydration, reset and restart', async () => {
		vi.resetModules();
		const backendModule = await import('@app/features/platform/state/PersistentStorageBackend');
		const backend = backendModule.createPersistentStorageBackend(null);
		Object.defineProperty(backend, 'kind', {value: backendModule.PersistentStorageBackendKind.DESKTOP});
		backendModule.installPersistentStorageBackend(backend);
		await backend.set('global', MOTION_STORAGE_KEY, JSON.stringify({syncReducedMotionWithSystem: true}));
		await backend.set('global', MOTION_MIGRATED_KEY, 'true');
		storeMotion(false, false);
		window.localStorage.removeItem(MOTION_MIGRATED_KEY);
		const storage = await import('@app/features/platform/state/PersistentStorage');
		await storage.initializeAppStorage();
		const {default: accessibility} = await import('@app/features/accessibility/state/Accessibility');
		expect(accessibility.syncReducedMotionWithSystem).toBe(true);
		accessibility.updateSettings({reducedMotionOverride: true});
		expect(readStoredMotion()).toMatchObject({syncReducedMotionWithSystem: true, reducedMotionOverride: true});
		await storage.resetAppStorage(storage.PRESERVED_RESET_STORAGE_KEYS);
		await storage.flushAppStorageWrites();

		vi.resetModules();
		const reopenedBackend = await import('@app/features/platform/state/PersistentStorageBackend');
		reopenedBackend.installPersistentStorageBackend(backend);
		const reopenedStorage = await import('@app/features/platform/state/PersistentStorage');
		await reopenedStorage.initializeAppStorage();
		const {default: reopened} = await import('@app/features/accessibility/state/Accessibility');
		expect(reopened.syncReducedMotionWithSystem).toBe(true);
		expect(reopened.reducedMotionOverride).toBe(true);
		expect(window.localStorage.getItem(MOTION_MIGRATED_KEY)).toBe('true');
		await reopenedStorage.flushAppStorageWrites();
	});

	it('keeps sync on chosen after the move over an auth-failure storage reset and an in-page re-login', async () => {
		const accessibility = await loadAccessibility();
		const {resetAppStorage, PRESERVED_RESET_STORAGE_KEYS} = await import(
			'@app/features/platform/state/PersistentStorage'
		);
		await resetAppStorage(PRESERVED_RESET_STORAGE_KEYS);
		accessibility.updateSettings({syncReducedMotionWithSystem: true});

		const reopened = await loadAccessibility();

		expect(reopened.syncReducedMotionWithSystem).toBe(true);
	});

	it('keeps a chosen reduced motion over logout and storage resets', async () => {
		const accessibility = await loadAccessibility();
		accessibility.updateSettings({reducedMotionOverride: true});
		const {resetAppStorage, PRESERVED_RESET_STORAGE_KEYS} = await import(
			'@app/features/platform/state/PersistentStorage'
		);
		await resetAppStorage(PRESERVED_RESET_STORAGE_KEYS);

		const reopened = await loadAccessibility();

		expect(reopened.useReducedMotion).toBe(true);
	});

	it('does not move a sync turned back on after the move again once a storage reset ran', async () => {
		storeMotion(true, null);
		const first = await loadAccessibility();
		first.updateSettings({syncReducedMotionWithSystem: true});
		const {resetAppStorage, PRESERVED_RESET_STORAGE_KEYS} = await import(
			'@app/features/platform/state/PersistentStorage'
		);
		await resetAppStorage(PRESERVED_RESET_STORAGE_KEYS);

		const reopened = await loadAccessibility();

		expect(reopened.syncReducedMotionWithSystem).toBe(true);
	});

	it.each([
		['sync on with reduced motion forced on', true, true],
		['sync on with reduced motion forced off', true, false],
		['sync off with reduced motion forced on', false, true],
		['sync off with no override', false, null],
	])('keeps %s', async (_label, sync, override) => {
		storeMotion(sync, override);

		const accessibility = await loadAccessibility();

		expect(accessibility.syncReducedMotionWithSystem).toBe(sync);
		expect(accessibility.reducedMotionOverride).toBe(override);
		expect(readStoredMotion()).toMatchObject({syncReducedMotionWithSystem: sync, reducedMotionOverride: override});
		expect(window.localStorage.getItem(MOTION_MIGRATED_KEY)).toBe('true');
	});
});

describe('Accessibility name styles', () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		window.localStorage.clear();
	});

	it('shows name styles by default', async () => {
		const accessibility = await loadAccessibility();

		expect(accessibility.showNameStyles).toBe(true);
	});

	it('keeps name styles hidden on this device once turned off', async () => {
		const accessibility = await loadAccessibility();
		accessibility.updateSettings({showNameStyles: false});

		const reopened = await loadAccessibility();

		expect(reopened.showNameStyles).toBe(false);
	});
});
