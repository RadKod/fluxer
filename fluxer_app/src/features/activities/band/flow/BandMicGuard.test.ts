// SPDX-License-Identifier: AGPL-3.0-or-later

import {BandMicGuard, type BandMicPort} from '@app/features/activities/band/flow/BandMicGuard';
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
	private readonly pushToTalkKey: boolean;

	constructor({
		pushToTalkKey = false,
		mode = 'voice_activity',
		muted = false,
		deafened = false,
	}: {pushToTalkKey?: boolean; mode?: TransmitMode; muted?: boolean; deafened?: boolean}) {
		this.pushToTalkKey = pushToTalkKey;
		this.mode = mode;
		this.muted = muted;
		this.deafened = deafened;
	}

	hasPushToTalkKey(): boolean {
		return this.pushToTalkKey;
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

describe('BandMicGuard', () => {
	it('switches to push-to-talk while playing and back after', () => {
		const port = new FakePort({pushToTalkKey: true});
		const guard = new BandMicGuard(port);
		guard.update('guitar');
		expect(port.mode).toBe('voice_push_to_talk');
		guard.update('guitar');
		expect(port.setTransmitMode).toHaveBeenCalledTimes(1);
		guard.update(null);
		expect(port.mode).toBe('voice_activity');
	});

	it('leaves push-to-talk users alone', () => {
		const port = new FakePort({pushToTalkKey: true, mode: 'voice_push_to_talk'});
		const guard = new BandMicGuard(port);
		guard.update('guitar');
		guard.update(null);
		expect(port.setTransmitMode).not.toHaveBeenCalled();
		expect(port.mode).toBe('voice_push_to_talk');
	});

	it('keeps a mode I picked myself during the song', () => {
		const port = new FakePort({pushToTalkKey: true});
		const guard = new BandMicGuard(port);
		guard.update('guitar');
		port.mode = 'voice_activity';
		guard.update(null);
		expect(port.setTransmitMode).toHaveBeenCalledTimes(1);
	});

	it('mutes while playing when no push-to-talk key is bound, and unmutes after', () => {
		const port = new FakePort({});
		const guard = new BandMicGuard(port);
		guard.update('guitar');
		expect(port.muted).toBe(true);
		guard.update(null);
		expect(port.muted).toBe(false);
		expect(port.toggleMute).toHaveBeenCalledTimes(2);
	});

	it('does not mute me again after I unmuted mid-song, and does not touch it after', () => {
		const port = new FakePort({});
		const guard = new BandMicGuard(port);
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
			const guard = new BandMicGuard(port);
			guard.update('guitar');
			guard.update(null);
			expect(port.toggleMute).not.toHaveBeenCalled();
		}
	});

	it('does not unmute when I deafened during the song', () => {
		const port = new FakePort({});
		const guard = new BandMicGuard(port);
		guard.update('guitar');
		port.deafened = true;
		guard.update(null);
		expect(port.toggleMute).toHaveBeenCalledTimes(1);
	});

	describe('singer', () => {
		it('opens a muted push-to-talk mic for the song and puts both back after', () => {
			const port = new FakePort({pushToTalkKey: true, mode: 'voice_push_to_talk', muted: true});
			const guard = new BandMicGuard(port);
			guard.update('vocals');
			expect(port).toMatchObject({mode: 'voice_activity', muted: false});
			guard.update(null);
			expect(port).toMatchObject({mode: 'voice_push_to_talk', muted: true});
		});

		it('leaves an open mic open and touches nothing after', () => {
			const port = new FakePort({});
			const guard = new BandMicGuard(port);
			guard.update('vocals');
			guard.update(null);
			expect(port.toggleMute).not.toHaveBeenCalled();
			expect(port.setTransmitMode).not.toHaveBeenCalled();
		});

		it('does not mute again a singer who muted themselves mid-song', () => {
			const port = new FakePort({muted: true});
			const guard = new BandMicGuard(port);
			guard.update('vocals');
			port.muted = true;
			guard.update(null);
			expect(port.toggleMute).toHaveBeenCalledTimes(1);
			expect(port.muted).toBe(true);
		});

		it('leaves a deafened singer alone', () => {
			const port = new FakePort({muted: true, deafened: true});
			const guard = new BandMicGuard(port);
			guard.update('vocals');
			guard.update(null);
			expect(port.toggleMute).not.toHaveBeenCalled();
		});

		it('swaps cleanly when I move from an instrument to the mic mid-song', () => {
			const port = new FakePort({});
			const guard = new BandMicGuard(port);
			guard.update('drums');
			expect(port.muted).toBe(true);
			guard.update('vocals');
			expect(port.muted).toBe(false);
			guard.update(null);
			expect(port.muted).toBe(false);
			expect(port.toggleMute).toHaveBeenCalledTimes(2);
		});
	});
});
