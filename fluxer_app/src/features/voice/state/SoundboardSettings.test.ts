// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const stored = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {
		getJSON: (key: string) => stored.get(key),
		setJSON: (key: string, value: unknown) => stored.set(key, value),
	},
}));

import {SoundboardSettings} from './SoundboardSettings';

describe('account scoped soundboard preferences', () => {
	beforeEach(() => stored.clear());

	it('isolates accounts and clears live preferences on logout', () => {
		const settings = new SoundboardSettings();
		settings.setAccount('account-a');
		settings.setDisabled(true);
		settings.commitVolume(0.4);
		settings.setAccount('account-b');
		expect(settings.disabled).toBe(false);
		expect(settings.volume).toBe(1);
		settings.setAccount('account-a');
		expect(settings.disabled).toBe(true);
		expect(settings.volume).toBe(0.4);
		settings.dispose();
		expect(settings.accountId).toBeNull();
		expect(settings.disabled).toBe(false);
		expect(settings.volume).toBe(1);
	});

	it('persists normalized volume and ignores nonfinite input', () => {
		const settings = new SoundboardSettings();
		settings.setAccount('account-a');
		settings.setVolume(5);
		expect(settings.volume).toBe(1);
		settings.commitVolume(-1);
		expect(settings.volume).toBe(0);
		settings.setVolume(Number.NaN);
		expect(settings.volume).toBe(0);
		const reloaded = new SoundboardSettings();
		reloaded.setAccount('account-a');
		expect(reloaded.volume).toBe(0);
	});

	it('does not persist changes without an active account', () => {
		const settings = new SoundboardSettings();
		settings.setDisabled(true);
		expect(stored.size).toBe(0);
	});

	it('updates live volume without writing storage until the change is committed', () => {
		const settings = new SoundboardSettings();
		settings.setAccount('account-a');
		settings.setVolume(0.6);
		settings.setVolume(0.4);
		expect(settings.volume).toBe(0.4);
		expect(stored.size).toBe(0);
		settings.commitVolume(0.3);
		expect(stored.get('SoundboardSettings:account-a')).toEqual({disabled: false, volume: 0.3});
	});
});
