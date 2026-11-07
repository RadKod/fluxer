// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/user/state/SyncedField', () => ({makeSyncedField: vi.fn(async () => {})}));

const ZOOM_STORAGE_KEY = 'Accessibility:zoomLevel';

async function loadAccessibility() {
	vi.resetModules();
	return (await import('@app/features/accessibility/state/Accessibility')).default;
}

describe('Accessibility app zoom', () => {
	beforeEach(() => {
		window.localStorage.clear();
		document.documentElement.removeAttribute('style');
	});

	afterEach(() => {
		window.localStorage.clear();
	});

	it('starts a fresh install at 100%', async () => {
		const accessibility = await loadAccessibility();
		expect(accessibility.zoomLevel).toBe(1);
		expect(accessibility.fontSize).toBe(16);
	});

	it('persists zoom under the unprefixed Accessibility:zoomLevel key the desktop preload reads', async () => {
		const accessibility = await loadAccessibility();
		accessibility.updateSettings({zoomLevel: 1.25});
		expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1.25');
		expect(window.localStorage.getItem('AccessibilityStore:zoomLevel')).toBeNull();
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
