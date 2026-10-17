// SPDX-License-Identifier: AGPL-3.0-or-later

// While I play, my open mic would put the song's own sound and my key clicks into the call. With a push-to-talk key
// bound, the guard switches me to push-to-talk; without one, push-to-talk would not take effect, so it mutes me
// instead. Either way it puts back exactly what it changed, and only if I did not change it myself meanwhile.

import type {TransmitMode} from '@app/features/input/state/input_keybind/KeybindSyncCodec';

export interface BandMicPort {
	hasPushToTalkKey(): boolean;
	transmitMode(): TransmitMode;
	setTransmitMode(mode: TransmitMode): void;
	isMuted(): boolean;
	isDeafened(): boolean;
	toggleMute(): Promise<void>;
}

type Hold =
	| {readonly kind: 'none'}
	| {readonly kind: 'pushToTalk'; readonly previous: TransmitMode}
	| {readonly kind: 'muted'};

export class BandMicGuard {
	private hold: Hold = {kind: 'none'};
	private playing = false;

	constructor(private readonly port: BandMicPort) {}

	// Acts on changes only: if I unmute myself mid-song, the guard does not mute me again.
	update(playing: boolean): void {
		if (playing === this.playing) return;
		this.playing = playing;
		if (playing) this.engage();
		else this.restore();
	}

	private engage(): void {
		if (this.port.hasPushToTalkKey()) {
			const previous = this.port.transmitMode();
			if (previous === 'voice_push_to_talk') return;
			this.port.setTransmitMode('voice_push_to_talk');
			this.hold = {kind: 'pushToTalk', previous};
			return;
		}
		if (this.port.isMuted() || this.port.isDeafened()) return;
		this.hold = {kind: 'muted'};
		void this.port.toggleMute();
	}

	private restore(): void {
		const hold = this.hold;
		this.hold = {kind: 'none'};
		if (hold.kind === 'pushToTalk' && this.port.transmitMode() === 'voice_push_to_talk') {
			this.port.setTransmitMode(hold.previous);
		}
		if (hold.kind === 'muted' && this.port.isMuted() && !this.port.isDeafened()) void this.port.toggleMute();
	}
}
