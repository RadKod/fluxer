// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

let stopCurrentPersistence: (() => void) | undefined;
let flushPreviousStorage: (() => Promise<void>) | undefined;
// Without IndexedDB the app storage keeps its data in memory; one backend shared across module reloads stands in
// for the browser's storage surviving a reload.
const sharedBackend = (
	await import('@app/features/platform/state/PersistentStorageBackend')
).createPersistentStorageBackend(null);

// A fresh module graph each time, as after a reload: the store hydrates from what the last one wrote.
async function loadBandSettings() {
	stopCurrentPersistence?.();
	await flushPreviousStorage?.();
	vi.resetModules();
	(await import('@app/features/platform/state/PersistentStorageBackend')).installPersistentStorageBackend(
		sharedBackend,
	);
	const storage = await import('@app/features/platform/state/PersistentStorage');
	flushPreviousStorage = storage.flushAppStorageWrites;
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
	flushPreviousStorage = undefined;
	await sharedBackend.clearAllExcept(new Set());
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

describe('BandSettings timing', () => {
	it('shifts the highway by what the visual test measured beyond the input latency, and keeps both', async () => {
		const first = await loadBandSettings();
		expect(first.settings.visualOffsetMs).toBe(0);
		first.settings.setVisualLatencyMs(70);
		expect(first.settings.visualOffsetMs).toBe(70);
		first.settings.setInputLatencyMs(30);
		expect(first.settings.visualOffsetMs).toBe(40);
		first.settings.dismissLatencyHint();
		first.flush();
		const second = await loadBandSettings();
		expect(second.settings.visualLatencyMs).toBe(70);
		expect(second.settings.inputLatencyMs).toBe(30);
		expect(second.settings.latencyHintDismissed).toBe(true);
	});

	it('clamps a measured offset to the supported range', async () => {
		const {settings} = await loadBandSettings();
		settings.setVisualLatencyMs(900);
		expect(settings.visualLatencyMs).toBe(300);
	});
});
