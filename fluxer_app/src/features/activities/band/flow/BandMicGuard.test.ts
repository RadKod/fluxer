// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BandMicGuard,
	type BandMicHoldStorage,
	type BandMicPort,
	recoverBandMicHold,
} from '@app/features/activities/band/flow/BandMicGuard';
import type {TransmitMode} from '@app/features/input/state/input_keybind/KeybindSyncCodec';
import {describe, expect, it, vi} from 'vitest';

class FakePort implements BandMicPort {
	mode: TransmitMode;
	muted: boolean;
	deafened: boolean;
	readonly setTransmitMode = vi.fn((next: TransmitMode) => {
		this.mode = next;
	});
	readonly toggleMute = vi.fn(async () => {
		this.muted = !this.muted;
	});
	readonly setMuted = vi.fn((next: boolean) => {
		this.muted = next;
	});
	constructor({
		mode = 'voice_activity',
		muted = false,
		deafened = false,
	}: {mode?: TransmitMode; muted?: boolean; deafened?: boolean}) {
		this.mode = mode;
		this.muted = muted;
		this.deafened = deafened;
	}

	transmitMode(): TransmitMode {
		return this.mode;
	}

	isMuted(): boolean {
		return this.muted;
	}

	isDeafened(): boolean {
		return this.deafened;
	}
}

class MemoryStorage implements BandMicHoldStorage {
	readonly items = new Map<string, string>();

	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}

	removeItem(key: string): void {
		this.items.delete(key);
	}
}

const HOLD_KEY = 'sanalyer:band-mic-hold';

function guardWithMemory(port: FakePort): BandMicGuard {
	const storage = new MemoryStorage();
	return new BandMicGuard(port, () => storage);
}

describe('BandMicGuard', () => {
	it('mutes a push-to-talk user too, so the mute button can open the mic', () => {
		const port = new FakePort({mode: 'voice_push_to_talk'});
		const guard = guardWithMemory(port);
		guard.update('guitar');
		expect(port).toMatchObject({mode: 'voice_push_to_talk', muted: true});
		port.muted = false;
		guard.update('guitar');
		guard.update(null);
		expect(port.setTransmitMode).not.toHaveBeenCalled();
		expect(port.toggleMute).toHaveBeenCalledTimes(1);
		expect(port.muted).toBe(false);
	});

	it('mutes while playing and unmutes after', () => {
		const port = new FakePort({});
		const guard = guardWithMemory(port);
		guard.update('guitar');
		expect(port.muted).toBe(true);
		guard.update(null);
		expect(port.muted).toBe(false);
		expect(port.toggleMute).toHaveBeenCalledTimes(2);
	});

	it('does not mute me again after I unmuted mid-song, and does not touch it after', () => {
		const port = new FakePort({});
		const guard = guardWithMemory(port);
		guard.update('guitar');
		port.muted = false;
		guard.update('guitar');
		guard.update(null);
		expect(port.toggleMute).toHaveBeenCalledTimes(1);
		expect(port.muted).toBe(false);
	});

	it('leaves an already muted or deafened mic as it is', () => {
		for (const state of [{muted: true}, {deafened: true}]) {
			const port = new FakePort(state);
			const guard = guardWithMemory(port);
			guard.update('guitar');
			guard.update(null);
			expect(port.toggleMute).not.toHaveBeenCalled();
		}
	});

	it('does not unmute when I deafened during the song', () => {
		const port = new FakePort({});
		const guard = guardWithMemory(port);
		guard.update('guitar');
		port.deafened = true;
		guard.update(null);
		expect(port.toggleMute).toHaveBeenCalledTimes(1);
	});

	describe('singer', () => {
		it('opens a muted push-to-talk mic for the song and puts both back after', () => {
			const port = new FakePort({mode: 'voice_push_to_talk', muted: true});
			const guard = guardWithMemory(port);
			guard.update('vocals');
			expect(port).toMatchObject({mode: 'voice_activity', muted: false});
			guard.update(null);
			expect(port).toMatchObject({mode: 'voice_push_to_talk', muted: true});
		});

		it('leaves an open mic open and touches nothing after', () => {
			const port = new FakePort({});
			const guard = guardWithMemory(port);
			guard.update('vocals');
			guard.update(null);
			expect(port.toggleMute).not.toHaveBeenCalled();
			expect(port.setTransmitMode).not.toHaveBeenCalled();
		});

		it('does not mute again a singer who muted themselves mid-song', () => {
			const port = new FakePort({muted: true});
			const guard = guardWithMemory(port);
			guard.update('vocals');
			port.muted = true;
			guard.update(null);
			expect(port.toggleMute).toHaveBeenCalledTimes(1);
			expect(port.muted).toBe(true);
		});

		it('leaves a deafened singer alone', () => {
			const port = new FakePort({muted: true, deafened: true});
			const guard = guardWithMemory(port);
			guard.update('vocals');
			guard.update(null);
			expect(port.toggleMute).not.toHaveBeenCalled();
		});

		it('swaps cleanly when I move from an instrument to the mic mid-song', () => {
			const port = new FakePort({});
			const guard = guardWithMemory(port);
			guard.update('drums');
			expect(port.muted).toBe(true);
			guard.update('vocals');
			expect(port.muted).toBe(false);
			guard.update(null);
			expect(port.muted).toBe(false);
			expect(port.toggleMute).toHaveBeenCalledTimes(2);
		});
	});

	describe('written hold', () => {
		it('writes what it changed while a song plays and clears it after', () => {
			const port = new FakePort({mode: 'voice_push_to_talk', muted: true});
			const storage = new MemoryStorage();
			const guard = new BandMicGuard(port, () => storage);
			guard.update('vocals');
			expect(JSON.parse(storage.getItem(HOLD_KEY) ?? 'null')).toEqual({
				previousMode: 'voice_push_to_talk',
				changedMode: 'voice_activity',
				toggledMute: true,
				role: 'singer',
			});
			guard.update(null);
			expect(storage.getItem(HOLD_KEY)).toBeNull();
		});

		it('writes nothing when it changed nothing', () => {
			const port = new FakePort({muted: true});
			const storage = new MemoryStorage();
			new BandMicGuard(port, () => storage).update('guitar');
			expect(storage.items.size).toBe(0);
		});

		it('leaves a hold from an earlier run for the start-up repair', () => {
			const storage = new MemoryStorage();
			new BandMicGuard(new FakePort({}), () => storage).update('guitar');
			const left = storage.getItem(HOLD_KEY);
			const guard = new BandMicGuard(new FakePort({}), () => storage);
			guard.update('vocals');
			guard.update(null);
			expect(storage.getItem(HOLD_KEY)).toBe(left);
		});

		it('puts the mic back on unload but keeps the hold for the next start', () => {
			const port = new FakePort({});
			const storage = new MemoryStorage();
			const guard = new BandMicGuard(port, () => storage);
			guard.update('guitar');
			guard.releaseForUnload();
			expect(port.muted).toBe(false);
			expect(storage.getItem(HOLD_KEY)).not.toBeNull();
			guard.update(null);
			expect(port.toggleMute).toHaveBeenCalledTimes(2);
		});

		it('keeps working when storage throws', () => {
			const port = new FakePort({});
			const broken = (): BandMicHoldStorage => {
				throw new Error('storage disabled');
			};
			const guard = new BandMicGuard(port, broken);
			guard.update('guitar');
			expect(port.muted).toBe(true);
			guard.update(null);
			expect(port.muted).toBe(false);
			expect(() => recoverBandMicHold(port, broken)).not.toThrow();
		});
	});

	describe('start-up repair', () => {
		function leftBehind(port: FakePort, part: 'guitar' | 'vocals'): MemoryStorage {
			const storage = new MemoryStorage();
			new BandMicGuard(port, () => storage).update(part);
			return storage;
		}

		// What an older guard wrote when it switched a player to push-to-talk.
		function olderPlayerHold(): MemoryStorage {
			const storage = new MemoryStorage();
			storage.setItem(
				HOLD_KEY,
				JSON.stringify({
					previousMode: 'voice_activity',
					changedMode: 'voice_push_to_talk',
					toggledMute: false,
					role: 'player',
				}),
			);
			return storage;
		}

		it('puts back the mode a crashed older run left on', () => {
			const storage = olderPlayerHold();
			const port = new FakePort({mode: 'voice_push_to_talk'});
			recoverBandMicHold(port, () => storage);
			expect(port.mode).toBe('voice_activity');
			expect(storage.items.size).toBe(0);
		});

		it('keeps a mode I changed since, and still clears the hold', () => {
			const storage = olderPlayerHold();
			const port = new FakePort({mode: 'voice_activity'});
			recoverBandMicHold(port, () => storage);
			expect(port.setTransmitMode).not.toHaveBeenCalled();
			expect(storage.items.size).toBe(0);
		});

		it('unmutes a player the guard muted, quietly, and only if still muted', () => {
			const storage = leftBehind(new FakePort({}), 'guitar');
			const stillMuted = new FakePort({muted: true});
			recoverBandMicHold(stillMuted, () => storage);
			expect(stillMuted.setMuted).toHaveBeenCalledWith(false);
			expect(stillMuted.toggleMute).not.toHaveBeenCalled();

			const unmutedSince = new FakePort({});
			recoverBandMicHold(unmutedSince, () => leftBehind(new FakePort({}), 'guitar'));
			expect(unmutedSince.setMuted).not.toHaveBeenCalled();
		});

		it('mutes again a singer the guard opened, unless they are deafened', () => {
			const singer = () => new FakePort({mode: 'voice_push_to_talk', muted: true});
			const port = new FakePort({});
			recoverBandMicHold(port, () => leftBehind(singer(), 'vocals'));
			expect(port).toMatchObject({mode: 'voice_push_to_talk', muted: true});

			const deafened = new FakePort({deafened: true});
			recoverBandMicHold(deafened, () => leftBehind(singer(), 'vocals'));
			expect(deafened.setMuted).not.toHaveBeenCalled();
		});

		it('ignores a hold it cannot read', () => {
			const storage = new MemoryStorage();
			storage.setItem(HOLD_KEY, '{not json');
			const port = new FakePort({mode: 'voice_push_to_talk', muted: true});
			recoverBandMicHold(port, () => storage);
			expect(port.setTransmitMode).not.toHaveBeenCalled();
			expect(port.setMuted).not.toHaveBeenCalled();
			expect(storage.items.size).toBe(0);
		});
	});
});
