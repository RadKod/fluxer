// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

let stopCurrentPersistence: (() => void) | undefined;

// A fresh module graph each time, as after a reload: the store hydrates from what the last one wrote.
async function loadJamSettings() {
	stopCurrentPersistence?.();
	vi.resetModules();
	const storage = await import('@app/features/platform/state/PersistentStorage');
	await storage.initializeAppStorage();
	await storage.activateAppStorageScope(null);
	const settings = (await import('@app/features/activities/band/jam/JamSettings')).default;
	const {awaitHydration, flushPendingPersistWrites, stopPersistent} = await import(
		'@app/features/platform/utils/MobXPersistence'
	);
	await awaitHydration('BandJamSettings');
	stopCurrentPersistence = () => stopPersistent('BandJamSettings', settings);
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

describe('JamSettings', () => {
	it('opens with the key box open and power chords on the rhythm guitar', async () => {
		const {settings} = await loadJamSettings();
		expect(settings.infoCollapsed).toBe(false);
		expect(settings.rhythmTone).toBe('power');
	});

	it('remembers a folded key box and the rhythm tone across a reload', async () => {
		const first = await loadJamSettings();
		first.settings.setInfoCollapsed(true);
		first.settings.setRhythmTone('clean');
		first.flush();
		const second = await loadJamSettings();
		expect(second.settings.infoCollapsed).toBe(true);
		expect(second.settings.rhythmTone).toBe('clean');
		second.settings.setInfoCollapsed(false);
		second.flush();
		expect((await loadJamSettings()).settings.infoCollapsed).toBe(false);
	});
});
