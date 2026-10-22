// SPDX-License-Identifier: AGPL-3.0-or-later

// While I play an instrument, my open mic would put the song's own sound and my key clicks into the call. With a
// push-to-talk key bound, the guard switches me to push-to-talk; without one, push-to-talk would not take effect, so
// it mutes me instead. A singer is the opposite: they sing over the call, and the panel holds the keyboard so a
// push-to-talk key cannot be pressed, so the guard opens their mic (voice activity, unmuted). Either way it puts back
// exactly what it changed, and only if I did not change it myself meanwhile.
//
// The transmit mode and the mute are saved and the mode follows me to my other devices, so a reload, a crash or a
// closed window in mid-song would leave me on push-to-talk everywhere. The hold is written down while it lasts, and
// the next start puts back whatever the restore never got to.

import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import {normalizeTransmitMode, type TransmitMode} from '@app/features/input/state/input_keybind/KeybindSyncCodec';

export interface BandMicPort {
	hasPushToTalkKey(): boolean;
	transmitMode(): TransmitMode;
	setTransmitMode(mode: TransmitMode): void;
	isMuted(): boolean;
	isDeafened(): boolean;
	toggleMute(): Promise<void>;
	// Sets the saved mute without the toggle's sound or microphone prompt, for a start-up repair outside any call.
	setMuted(muted: boolean): void;
}

export type BandMicHoldStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type Role = 'off' | 'player' | 'singer';

interface Hold {
	// The transmit mode to put back, when the guard changed it.
	readonly previousMode: TransmitMode | null;
	readonly changedMode: TransmitMode | null;
	// Whether the guard muted (player) or unmuted (singer) me.
	readonly toggledMute: boolean;
}

interface StoredHold extends Hold {
	readonly role: Exclude<Role, 'off'>;
}

const NO_HOLD: Hold = {previousMode: null, changedMode: null, toggledMute: false};

const HOLD_STORAGE_KEY = 'sanalyer:band-mic-hold';

// Plain localStorage, not AppStorage: it is written at once, so it is there even when the tab dies a moment later.
const browserStorage = (): BandMicHoldStorage => localStorage;

function roleOf(part: BandPart | null): Role {
	if (part === null) return 'off';
	return part === 'vocals' ? 'singer' : 'player';
}

function isEmpty(hold: Hold): boolean {
	return hold.previousMode === null && !hold.toggledMute;
}

function readMode(value: unknown): TransmitMode | null {
	return typeof value === 'string' ? normalizeTransmitMode(value) : null;
}

// Storage can be missing or refuse (private mode, full quota); the guard keeps working without it.
function writeStoredHold(storage: () => BandMicHoldStorage, hold: StoredHold | null): void {
	try {
		if (hold === null) storage().removeItem(HOLD_STORAGE_KEY);
		else storage().setItem(HOLD_STORAGE_KEY, JSON.stringify(hold));
	} catch {}
}

function readStoredHold(storage: () => BandMicHoldStorage): StoredHold | null {
	try {
		const raw = storage().getItem(HOLD_STORAGE_KEY);
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as Partial<Record<keyof StoredHold, unknown>> | null;
		if (parsed?.role !== 'player' && parsed?.role !== 'singer') return null;
		return {
			role: parsed.role,
			previousMode: readMode(parsed.previousMode),
			changedMode: readMode(parsed.changedMode),
			toggledMute: parsed.toggledMute === true,
		};
	} catch {
		return null;
	}
}

// Puts back a hold the last run left behind. Like the restore, it only undoes what is still as the guard left it: a
// mode I changed since, on this or another device, stays mine.
export function recoverBandMicHold(port: BandMicPort, storage: () => BandMicHoldStorage = browserStorage): void {
	const hold = readStoredHold(storage);
	writeStoredHold(storage, null);
	if (hold === null) return;
	if (hold.previousMode !== null && port.transmitMode() === hold.changedMode) {
		port.setTransmitMode(hold.previousMode);
	}
	if (!hold.toggledMute || port.isDeafened()) return;
	const leftMuted = hold.role === 'player';
	if (port.isMuted() === leftMuted) port.setMuted(!leftMuted);
}

export class BandMicGuard {
	private hold: Hold = NO_HOLD;
	private role: Role = 'off';

	constructor(
		private readonly port: BandMicPort,
		private readonly storage: () => BandMicHoldStorage = browserStorage,
	) {}

	// My seat's part while a song plays, null otherwise. Acts on changes only: if I unmute myself mid-song, the guard
	// does not mute me again.
	update(part: BandPart | null): void {
		const role = roleOf(part);
		if (role === this.role) return;
		this.restore();
		this.role = role;
		if (role === 'player') this.engagePlayer();
		else if (role === 'singer') this.engageSinger();
		if (role !== 'off' && !isEmpty(this.hold)) writeStoredHold(this.storage, {...this.hold, role});
	}

	// The page is going away without a dispose. Puts the mic back now but keeps the written hold: the saves this
	// triggers may not land before the page is gone, so the next start checks them.
	releaseForUnload(): void {
		this.restore({keepStored: true});
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

	private restore({keepStored = false}: {keepStored?: boolean} = {}): void {
		const {hold, role} = this;
		this.hold = NO_HOLD;
		// Only a hold this guard wrote is cleared; one left by an earlier run waits for the start-up repair.
		if (!keepStored && !isEmpty(hold)) writeStoredHold(this.storage, null);
		if (hold.previousMode !== null && this.port.transmitMode() === hold.changedMode) {
			this.port.setTransmitMode(hold.previousMode);
		}
		if (!hold.toggledMute || this.port.isDeafened()) return;
		// Put the mute back only if it is still what the guard left.
		const leftMuted = role === 'player';
		if (this.port.isMuted() === leftMuted) void this.port.toggleMute();
	}
}
