// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
// Only defaults and persistence run here; the plan limits need the served bootstrap.
vi.mock('@app/features/voice/utils/VideoQualityEntitlement', () => ({hasHigherVideoQuality: () => false}));

// DeepFilterNet stopped being the default once: a saved 'deep_filter' choice is cleared a single time, every other
// choice is kept, and a 'deep_filter' picked after that reset survives later loads.
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

describe('one-time DeepFilterNet preference reset', () => {
	beforeEach(() => window.localStorage.clear());
	afterEach(() => window.localStorage.clear());

	it('clears a saved deep_filter choice once and persists the flag', async () => {
		store({noiseSuppressionBackendPrefV1: 'deep_filter'});

		const settings = await loadVoiceSettings();

		expect(settings.noiseSuppressionBackend).toBeNull();
		expect(readStored().noiseSuppressionBackendPrefV1).toBeNull();
		expect(readStored().deepFilterDefaultRetiredMigratedV1).toBe(true);
	});

	it.each(['rnnoise', 'none', 'standard', 'gate', 'speex', 'gtcrn'] as const)(
		'keeps a saved %s choice',
		async (backend) => {
			store({noiseSuppressionBackendPrefV1: backend});

			const settings = await loadVoiceSettings();

			expect(settings.noiseSuppressionBackend).toBe(backend);
			expect(readStored().deepFilterDefaultRetiredMigratedV1).toBe(true);
		},
	);

	it('keeps deep_filter when it is saved after the reset already ran', async () => {
		store({noiseSuppressionBackendPrefV1: 'deep_filter', deepFilterDefaultRetiredMigratedV1: true});

		const settings = await loadVoiceSettings();

		expect(settings.noiseSuppressionBackend).toBe('deep_filter');
	});

	it('keeps deep_filter picked again after the reset across reloads', async () => {
		store({noiseSuppressionBackendPrefV1: 'deep_filter'});
		const settings = await loadVoiceSettings();
		expect(settings.noiseSuppressionBackend).toBeNull();

		settings.noiseSuppressionBackend = 'deep_filter';
		window.dispatchEvent(new Event('pagehide'));
		expect(readStored().noiseSuppressionBackendPrefV1).toBe('deep_filter');

		const reloaded = await loadVoiceSettings();

		expect(reloaded.noiseSuppressionBackend).toBe('deep_filter');
		expect(readStored().deepFilterDefaultRetiredMigratedV1).toBe(true);
	});

	it('runs together with the standard noise suppression default reset', async () => {
		store({
			noiseSuppression: false,
			deepFilterNoiseSuppressionPrefV2: true,
			noiseSuppressionBackendPrefV1: 'deep_filter',
		});

		const settings = await loadVoiceSettings();

		expect(settings.noiseSuppression).toBe(true);
		expect(settings.deepFilterNoiseSuppression).toBe(false);
		expect(settings.noiseSuppressionBackend).toBeNull();
		const stored = readStored();
		expect(stored.noiseSuppressionStandardDefaultMigratedV1).toBe(true);
		expect(stored.deepFilterDefaultRetiredMigratedV1).toBe(true);
		expect(stored.noiseSuppressionBackendPrefV1).toBeNull();
	});
});
