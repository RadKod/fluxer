// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/streamer_mode/state/StreamerMode', () => ({default: {shouldDisableSounds: false}}));
vi.mock('@app/features/user/state/SyncedField', () => ({makeSyncedField: vi.fn(async () => {})}));
vi.mock('@app/features/notification/utils/SoundUtils', async (importOriginal) => ({
	...(await importOriginal<object>()),
	playSound: vi.fn(async () => null),
}));

const SoundUtils = await import('@app/features/notification/utils/SoundUtils');
const {SoundType} = SoundUtils;
const {default: Sound} = await import('@app/features/ui/state/Sound');

// The player now hands back the same element for every play of a sound type.
class FakeElement {
	private readonly listeners = new Map<string, Map<EventListener, boolean>>();
	addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Map());
		this.listeners.get(type)!.set(listener, options?.once === true);
	}
	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener);
	}
	dispatch(type: string): void {
		for (const [listener, once] of [...(this.listeners.get(type) ?? [])]) {
			if (once) this.removeEventListener(type, listener);
			listener(new Event(type));
		}
	}
	count(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}
}

let element: FakeElement;

beforeEach(() => {
	element = new FakeElement();
	vi.mocked(SoundUtils.playSound).mockImplementation(async () => element as unknown as HTMLAudioElement);
	Sound.setSelfDeafenedResolver(() => false);
	Sound.updateSettings({allSoundsDisabled: false});
});

describe('one-shot listeners on the reused sound element', () => {
	it('plays that end leave no listeners behind', async () => {
		for (let i = 0; i < 20; i++) {
			expect(await Sound.playOneShotSoundImmediately(SoundType.UserJoin, {ignoreGroupCooldown: true})).toBe(true);
			element.dispatch('ended');
		}
		expect(element.count('ended') + element.count('error')).toBeLessThanOrEqual(1);
		expect(Sound.isPlayingSound(SoundType.UserJoin)).toBe(false);
	});

	it('aborted plays leave no listeners behind', async () => {
		for (let i = 0; i < 20; i++) {
			const controller = new AbortController();
			expect(
				await Sound.playOneShotSoundImmediately(SoundType.UserJoin, {ignoreGroupCooldown: true}, controller.signal),
			).toBe(true);
			controller.abort();
		}
		expect(element.count('ended') + element.count('error')).toBeLessThanOrEqual(1);
		expect(Sound.isPlayingSound(SoundType.UserJoin)).toBe(false);
	});
});
