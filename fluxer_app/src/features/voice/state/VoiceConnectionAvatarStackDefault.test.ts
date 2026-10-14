// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
// Only defaults and persistence run here; the plan limits need the served bootstrap.
vi.mock('@app/features/voice/utils/VideoQualityEntitlement', () => ({hasHigherVideoQuality: () => false}));

// Micup: the voice panel's participant avatar stack is off by default and stays on only for users who turn it on from
// the panel's context menu. The value moved to a PrefV2 key, so the `true` every install saved under upstream's
// default is not read back.
const STORAGE_KEY = 'VoiceSettings';

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

describe('voice panel avatar stack', () => {
	beforeEach(() => window.localStorage.clear());
	afterEach(() => window.localStorage.clear());

	it('is hidden on a fresh install', async () => {
		const settings = await loadVoiceSettings();

		expect(settings.showVoiceConnectionAvatarStack).toBe(false);
		expect(settings.getShowVoiceConnectionAvatarStack()).toBe(false);
	});

	it('ignores the value saved under the old key', async () => {
		window.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({showVoiceConnectionAvatarStack: true, __mps__: {version: 1}}),
		);

		const settings = await loadVoiceSettings();

		expect(settings.showVoiceConnectionAvatarStack).toBe(false);
	});

	it('keeps it on once the user turns it on', async () => {
		const settings = await loadVoiceSettings();
		settings.updateSettings({showVoiceConnectionAvatarStack: true});
		window.dispatchEvent(new Event('pagehide'));
		const stored = readStored();
		expect(stored.showVoiceConnectionAvatarStackPrefV2).toBe(true);
		expect(stored).not.toHaveProperty('showVoiceConnectionAvatarStack');

		const reloaded = await loadVoiceSettings();

		expect(reloaded.showVoiceConnectionAvatarStack).toBe(true);
		expect(reloaded.getShowVoiceConnectionAvatarStack()).toBe(true);
	});
});
