// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

let stopCurrentPersistence: (() => void) | undefined;

// A fresh module graph each time, as after a reload: the store hydrates from what the last one wrote.
async function loadBandSettings() {
	stopCurrentPersistence?.();
	vi.resetModules();
	const storage = await import('@app/features/platform/state/PersistentStorage');
	await storage.initializeAppStorage();
	await storage.activateAppStorageScope(null);
	const settings = (await import('@app/features/activities/band/game/BandSettings')).default;
	const {awaitHydration, flushPendingPersistWrites, stopPersistent} = await import(
		'@app/features/platform/utils/MobXPersistence'
	);
	await awaitHydration('BandSettings');
	stopCurrentPersistence = () => stopPersistent('BandSettings', settings);
	return {settings, flush: flushPendingPersistWrites};
}

beforeEach(async () => {
	const {resetAppStorage} = await import('@app/features/platform/state/PersistentStorage');
	await resetAppStorage([]);
	window.localStorage.clear();
});

afterEach(() => {
	stopCurrentPersistence?.();
	stopCurrentPersistence = undefined;
	window.localStorage.clear();
});

describe('BandSettings highway view', () => {
	it('opens on the focus view', async () => {
		const {settings} = await loadBandSettings();
		expect(settings.highwayView).toBe('focus');
	});

	it('keeps the band view across a reload, next to the other band settings', async () => {
		const first = await loadBandSettings();
		first.settings.setHighwayView('group');
		first.settings.setVolume(0.5);
		first.flush();
		const second = await loadBandSettings();
		expect(second.settings.highwayView).toBe('group');
		expect(second.settings.volume).toBe(0.5);
		second.settings.setHighwayView('focus');
		second.flush();
		expect((await loadBandSettings()).settings.highwayView).toBe('focus');
	});
});
