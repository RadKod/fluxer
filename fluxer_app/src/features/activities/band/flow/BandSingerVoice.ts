// SPDX-License-Identifier: AGPL-3.0-or-later

// A singer over the song needs a different mic than a talker. The call's voice processing treats a held note as
// noise, levels the voice against the music and cuts soft passages, so for the length of a song the singer's mic
// switches to music processing, and everyone else's call stops levelling the singer's voice.
//
// The mic switch restarts the capture and drops a fraction of a second of audio, so it happens only during the
// countdown before the song, never mid-song; a client that first sees the song after it started leaves the mic alone.
// It ends with the song, when the singer leaves the seat, and when the room goes away. Nothing is saved: a reload
// drops it and the mic is back on the singer's own settings.

import type {VoiceMusicProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';

// What the singer hears the song on. Speakers keep echo cancellation; headphones give the cleanest voice.
export type BandSingerOutput = VoiceMusicProcessing;

const DEFAULT_SINGER_OUTPUT: BandSingerOutput = 'speakers';

export interface BandVoicePort {
	// My mic for singing over the song, or back to my own settings with null.
	setSingerMic(output: BandSingerOutput | null): void;
	// The call plays these people's voices without levelling them; an empty list levels everyone again.
	setUnlevelledVoices(userIds: ReadonlyArray<string>): void;
}

export type BandSingerOutputStorage = Pick<Storage, 'getItem' | 'setItem'>;

const OUTPUT_STORAGE_PREFIX = 'sanalyer:band-singer-output:';

export const browserSingerOutputStorage = (): BandSingerOutputStorage => localStorage;

// Per user on this device; storage can be missing or refuse (private mode, full quota), and then the default holds.
export function readSingerOutput(storage: () => BandSingerOutputStorage, userId: string): BandSingerOutput {
	try {
		const stored = storage().getItem(OUTPUT_STORAGE_PREFIX + userId);
		return stored === 'headphones' || stored === 'speakers' ? stored : DEFAULT_SINGER_OUTPUT;
	} catch {
		return DEFAULT_SINGER_OUTPUT;
	}
}

export function writeSingerOutput(
	storage: () => BandSingerOutputStorage,
	userId: string,
	output: BandSingerOutput,
): void {
	try {
		storage().setItem(OUTPUT_STORAGE_PREFIX + userId, output);
	} catch {}
}

export class BandSingerMic {
	private engaged = false;

	constructor(
		private readonly port: BandVoicePort,
		// The leader clock, which the song's startAt is on.
		private readonly now: () => number,
		private readonly output: () => BandSingerOutput,
	) {}

	// The start of the song while I hold its vocals seat, null otherwise.
	update(startAt: number | null): void {
		if (startAt === null) {
			this.release();
			return;
		}
		if (this.engaged || this.now() >= startAt) return;
		this.engaged = true;
		this.port.setSingerMic(this.output());
	}

	release(): void {
		if (!this.engaged) return;
		this.engaged = false;
		this.port.setSingerMic(null);
	}
}
