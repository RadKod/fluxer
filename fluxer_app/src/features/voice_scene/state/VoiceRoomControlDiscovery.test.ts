// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const STORAGE_KEY = 'VoiceRoomControlDiscovery';
let stopCurrentPersistence: (() => void) | undefined;

async function loadSettings() {
	stopCurrentPersistence?.();
	vi.resetModules();
	const settings = (await import('./VoiceRoomControlDiscovery')).default;
	const {awaitHydration, stopPersistent} = await import('@app/features/platform/utils/MobXPersistence');
	await awaitHydration(STORAGE_KEY);
	stopCurrentPersistence = () => stopPersistent(STORAGE_KEY, settings);
	return settings;
}

describe('3D room control discovery persistence', () => {
	beforeEach(() => window.localStorage.clear());
	afterEach(() => {
		stopCurrentPersistence?.();
		stopCurrentPersistence = undefined;
		window.localStorage.clear();
	});

	it('starts with the badge and its first shimmer available for fresh or existing devices', async () => {
		window.localStorage.setItem('VoiceSceneSettings', JSON.stringify({preferRoom: false, __mps__: {version: 1}}));
		const settings = await loadSettings();
		expect(settings.dismissed).toBe(false);
		expect(settings.shimmerShown).toBe(false);
	});

	it('keeps the badge dismissed after device state is reloaded', async () => {
		const settings = await loadSettings();
		settings.dismiss();
		window.dispatchEvent(new Event('pagehide'));
		expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}').dismissed).toBe(true);
		const reloaded = await loadSettings();
		expect(reloaded.dismissed).toBe(true);
	});

	it('keeps the first shimmer consumed on reload while the unclicked badge remains available', async () => {
		const settings = await loadSettings();
		settings.markShimmerShown();
		window.dispatchEvent(new Event('pagehide'));
		const reloaded = await loadSettings();
		expect(reloaded.shimmerShown).toBe(true);
		expect(reloaded.dismissed).toBe(false);
	});

	it('keeps discovery flags over authentication storage resets', async () => {
		const settings = await loadSettings();
		settings.dismiss();
		settings.markShimmerShown();
		window.dispatchEvent(new Event('pagehide'));
		const {PRESERVED_RESET_STORAGE_KEYS, resetAppStorage} = await import(
			'@app/features/platform/state/PersistentStorage'
		);
		await resetAppStorage(PRESERVED_RESET_STORAGE_KEYS);
		const reloaded = await loadSettings();
		expect(reloaded.dismissed).toBe(true);
		expect(reloaded.shimmerShown).toBe(true);
	});

	it('receives another tab dismissal before a local shimmer write can roll it back', async () => {
		const settings = await loadSettings();
		const externalValue = JSON.stringify({dismissed: true, __mps__: {version: 1}});
		window.localStorage.setItem(STORAGE_KEY, externalValue);
		window.dispatchEvent(
			new StorageEvent('storage', {
				key: STORAGE_KEY,
				newValue: externalValue,
				storageArea: window.localStorage,
			}),
		);
		await expect.poll(() => settings.dismissed, {timeout: 1000}).toBe(true);
		settings.markShimmerShown();
		window.dispatchEvent(new Event('pagehide'));
		expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}').dismissed).toBe(true);
	});
});
