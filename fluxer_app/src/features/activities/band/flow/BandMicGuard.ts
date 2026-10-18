// SPDX-License-Identifier: AGPL-3.0-or-later

// While I play an instrument, my open mic would put the song's own sound and my key clicks into the call. With a
// push-to-talk key bound, the guard switches me to push-to-talk; without one, push-to-talk would not take effect, so
// it mutes me instead. A singer is the opposite: they sing over the call, and the panel holds the keyboard so a
// push-to-talk key cannot be pressed, so the guard opens their mic (voice activity, unmuted). Either way it puts back
// exactly what it changed, and only if I did not change it myself meanwhile.

import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import type {TransmitMode} from '@app/features/input/state/input_keybind/KeybindSyncCodec';

export interface BandMicPort {
	hasPushToTalkKey(): boolean;
	transmitMode(): TransmitMode;
	setTransmitMode(mode: TransmitMode): void;
	isMuted(): boolean;
	isDeafened(): boolean;
	toggleMute(): Promise<void>;
}

type Role = 'off' | 'player' | 'singer';

interface Hold {
	// The transmit mode to put back, when the guard changed it.
	readonly previousMode: TransmitMode | null;
	readonly changedMode: TransmitMode | null;
	// Whether the guard muted (player) or unmuted (singer) me.
	readonly toggledMute: boolean;
}

const NO_HOLD: Hold = {previousMode: null, changedMode: null, toggledMute: false};

function roleOf(part: BandPart | null): Role {
	if (part === null) return 'off';
	return part === 'vocals' ? 'singer' : 'player';
}

export class BandMicGuard {
	private hold: Hold = NO_HOLD;
	private role: Role = 'off';

	constructor(private readonly port: BandMicPort) {}

	// My seat's part while a song plays, null otherwise. Acts on changes only: if I unmute myself mid-song, the guard
	// does not mute me again.
	update(part: BandPart | null): void {
		const role = roleOf(part);
		if (role === this.role) return;
		this.restore();
		this.role = role;
		if (role === 'player') this.engagePlayer();
		else if (role === 'singer') this.engageSinger();
	}

	private engagePlayer(): void {
		if (this.port.hasPushToTalkKey()) {
			this.switchMode('voice_push_to_talk', false);
			return;
		}
		if (this.port.isMuted() || this.port.isDeafened()) return;
		this.hold = {...NO_HOLD, toggledMute: true};
		void this.port.toggleMute();
	}

	private engageSinger(): void {
		// A deafened singer chose silence; unmuting would undeafen them too.
		if (this.port.isDeafened()) return;
		const unmute = this.port.isMuted();
		this.switchMode('voice_activity', unmute);
		if (unmute) void this.port.toggleMute();
	}

	private switchMode(mode: TransmitMode, toggledMute: boolean): void {
		const previous = this.port.transmitMode();
		if (previous === mode) {
			this.hold = {...NO_HOLD, toggledMute};
			return;
		}
		this.port.setTransmitMode(mode);
		this.hold = {previousMode: previous, changedMode: mode, toggledMute};
	}

	private restore(): void {
		const {hold, role} = this;
		this.hold = NO_HOLD;
		if (hold.previousMode !== null && this.port.transmitMode() === hold.changedMode) {
			this.port.setTransmitMode(hold.previousMode);
		}
		if (!hold.toggledMute || this.port.isDeafened()) return;
		// Put the mute back only if it is still what the guard left.
		const leftMuted = role === 'player';
		if (this.port.isMuted() === leftMuted) void this.port.toggleMute();
	}
}
