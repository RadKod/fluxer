// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
// Only defaults and persistence run here; the plan limits need the served bootstrap.
vi.mock('@app/features/voice/utils/VideoQualityEntitlement', () => ({hasHigherVideoQuality: () => false}));

// Micup: screen shares start in the game mode. A display share without the motion hint keeps its resolution and drops
// frames when the uplink cannot carry it, so the screen share mode is a choice, not the default. Every saved
// 'screenshare' mode moves to 'gaming' a single time; a 'screenshare' picked after that stays.
const STORAGE_KEY = 'VoiceSettings';

function store(values: Record<string, unknown>): void {
	window.localStorage.setItem(STORAGE_KEY, JSON.stringify({...values, __mps__: {version: 1}}));
}

function readStored(): Record<string, unknown> {
	return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
}

async function loadVoiceSettings() {
	vi.resetModules();
	const settings = (await import('@app/features/voice/state/VoiceSettings')).default;
	const {awaitHydration} = await import('@app/features/platform/utils/MobXPersistence');
	await awaitHydration(STORAGE_KEY);
	return settings;
}

describe('game mode screen share default', () => {
	beforeEach(() => window.localStorage.clear());
	afterEach(() => window.localStorage.clear());

	it('starts a fresh install in the game mode', async () => {
		const settings = await loadVoiceSettings();

		expect(settings.getStreamingMode()).toBe('gaming');
	});

	it('moves a saved screen share mode to the game mode once and persists the flag', async () => {
		store({streamingMode: 'screenshare', streamingModeDefaultMigratedV1: true});

		const settings = await loadVoiceSettings();

		expect(settings.getStreamingMode()).toBe('gaming');
		expect(readStored().streamingMode).toBe('gaming');
		expect(readStored().streamingModeGamingDefaultMigratedV1).toBe(true);
	});

	it('keeps a saved custom mode', async () => {
		store({streamingMode: 'custom', streamingModeDefaultMigratedV1: true});

		const settings = await loadVoiceSettings();

		expect(settings.getStreamingMode()).toBe('custom');
	});

	it('gives a fresh install the motion hint for custom shares', async () => {
		const settings = await loadVoiceSettings();

		expect(settings.getScreenShareContentHint()).toBe('motion');
	});

	it('moves a saved text hint to the motion hint once and keeps the other hints', async () => {
		store({screenShareContentHintPrefV2: 'text', screenShareContentHintDefaultMigratedV1: true});
		expect((await loadVoiceSettings()).getScreenShareContentHint()).toBe('motion');
		expect(readStored().screenShareContentHintMotionDefaultMigratedV1).toBe(true);

		window.localStorage.clear();
		store({screenShareContentHintPrefV2: 'detail', screenShareContentHintDefaultMigratedV1: true});
		expect((await loadVoiceSettings()).getScreenShareContentHint()).toBe('detail');
	});

	it('keeps a text hint picked after the move', async () => {
		store({
			screenShareContentHintPrefV2: 'text',
			screenShareContentHintDefaultMigratedV1: true,
			screenShareContentHintMotionDefaultMigratedV1: true,
		});

		expect((await loadVoiceSettings()).getScreenShareContentHint()).toBe('text');
	});

	it('keeps a screen share mode picked after the move', async () => {
		store({
			streamingMode: 'screenshare',
			streamingModeDefaultMigratedV1: true,
			streamingModeGamingDefaultMigratedV1: true,
		});

		const settings = await loadVoiceSettings();

		expect(settings.getStreamingMode()).toBe('screenshare');
	});
});
