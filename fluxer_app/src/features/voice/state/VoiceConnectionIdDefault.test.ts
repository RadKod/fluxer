// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
// Only defaults and persistence run here; the plan limits need the served bootstrap.
vi.mock('@app/features/voice/utils/VideoQualityEntitlement', () => ({hasHigherVideoQuality: () => false}));

// Micup: the voice panel's connection ID line is off by default and stays on only for users who turn it on from the
// panel's context menu. The value moved to a V3 key, so the `true` every install saved under upstream's V2 default is
// not read back.
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

describe('voice connection ID line', () => {
	beforeEach(() => window.localStorage.clear());
	afterEach(() => window.localStorage.clear());

	it('is hidden on a fresh install', async () => {
		const settings = await loadVoiceSettings();

		expect(settings.showVoiceConnectionId).toBe(false);
		expect(settings.getShowVoiceConnectionId()).toBe(false);
	});

	it('ignores the value saved under the old V2 key', async () => {
		window.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({showVoiceConnectionIdPrefV2: true, __mps__: {version: 1}}),
		);

		const settings = await loadVoiceSettings();

		expect(settings.showVoiceConnectionId).toBe(false);
	});

	it('keeps it on once the user turns it on', async () => {
		const settings = await loadVoiceSettings();
		settings.updateSettings({showVoiceConnectionId: true});
		window.dispatchEvent(new Event('pagehide'));
		expect(readStored().showVoiceConnectionIdPrefV3).toBe(true);

		const reloaded = await loadVoiceSettings();

		expect(reloaded.showVoiceConnectionId).toBe(true);
	});
});
