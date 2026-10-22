// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstrumentPart} from '@app/features/activities/band/engine/ChartModel';
import {SONG_HEADROOM_GAIN} from '@app/features/activities/band/game/BandAudio';
import {Logger} from '@app/features/platform/utils/AppLogger';
import bassMissUrl from '@app/media/sounds/band/kacirma-bas.wav';
import drumsMissUrl from '@app/media/sounds/band/kacirma-davul.wav';
import guitarMissUrl from '@app/media/sounds/band/kacirma-gitar.wav';

const logger = new Logger('BandMissSound');

// A chord mashed wrong gives several misses within a few frames; one sound is enough.
export const MISS_SOUND_GAP_S = 0.08;
// Guitar Hero style: the same recording never plays twice the same way.
export const MISS_RATE_SPREAD = 0.06;
export const MISS_LEVEL_SPREAD_DB = 2;
// The samples peak at -6 dBFS. The master's song headroom would push them 3 dB further under the song, so their gain
// cancels it: at full volume a miss peaks at -6 dBFS over a song around -16 LUFS, the balance of the demo the sounds
// were picked from, and it still follows the volume setting.
const MISS_LEVEL = 1 / SONG_HEADROOM_GAIN;
// Starting part way into a sample would click without it.
const MISS_ATTACK_S = 0.0015;

export type MissSample = 'pickScrape' | 'mutedChug' | 'woodStick';

export const MISS_SAMPLE_URLS: Readonly<Record<MissSample, string>> = {
	pickScrape: guitarMissUrl,
	mutedChug: bassMissUrl,
	woodStick: drumsMissUrl,
};

interface MissVoice {
	readonly sample: MissSample;
	// How far into the sample a play may start; short for the stick so its attack survives.
	readonly maxOffsetS: number;
	readonly level: number;
}

// Keys have no muted-string or stick sound of their own; the bass chug, 4 dB softer, reads as a dead key without
// sounding like a guitar.
export const MISS_VOICES: Readonly<Record<InstrumentPart, MissVoice>> = {
	guitar: {sample: 'pickScrape', maxOffsetS: 0.025, level: 1},
	rhythm: {sample: 'pickScrape', maxOffsetS: 0.025, level: 1},
	bass: {sample: 'mutedChug', maxOffsetS: 0.012, level: 1},
	drums: {sample: 'woodStick', maxOffsetS: 0.004, level: 1},
	keys: {sample: 'mutedChug', maxOffsetS: 0.012, level: 10 ** (-4 / 20)},
};

export interface MissVariation {
	readonly playbackRate: number;
	readonly offsetS: number;
	readonly gain: number;
}

export function missVariation(voice: MissVoice, random: () => number = Math.random): MissVariation {
	const levelDb = -MISS_LEVEL_SPREAD_DB * random();
	return {
		playbackRate: 1 + MISS_RATE_SPREAD * (random() * 2 - 1),
		offsetS: voice.maxOffsetS * random(),
		gain: MISS_LEVEL * voice.level * 10 ** (levelDb / 20),
	};
}

type FetchSample = (url: string) => Promise<ArrayBuffer>;

const fetchSample: FetchSample = async (url) => {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.arrayBuffer();
};

// The sound of my own miss, wrong strum, overstrum or stray pad. It is heard only on this device; the rest of the
// band hears my part drop out instead.
export class MissSound {
	private readonly buffers = new Map<MissSample, AudioBuffer>();
	private lastAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly context: BaseAudioContext,
		private readonly output: AudioNode,
		private readonly enabled: () => boolean,
		private readonly random: () => number = Math.random,
	) {}

	// Decoded before the song starts so the first miss is not late. A sample that fails to load stays silent.
	async load(fetchBytes: FetchSample = fetchSample): Promise<void> {
		const samples = Object.keys(MISS_SAMPLE_URLS) as Array<MissSample>;
		await Promise.all(
			samples.map(async (sample) => {
				try {
					const bytes = await fetchBytes(MISS_SAMPLE_URLS[sample]);
					this.buffers.set(sample, await this.context.decodeAudioData(bytes));
				} catch (error) {
					logger.warn('Miss sample could not be loaded', {sample, error});
				}
			}),
		);
	}

	play(part: InstrumentPart): void {
		if (!this.enabled()) return;
		const voice = MISS_VOICES[part];
		const buffer = this.buffers.get(voice.sample);
		if (!buffer) return;
		const when = this.context.currentTime;
		if (when - this.lastAt < MISS_SOUND_GAP_S) return;
		this.lastAt = when;

		const {playbackRate, offsetS, gain} = missVariation(voice, this.random);
		const source = this.context.createBufferSource();
		source.buffer = buffer;
		source.playbackRate.value = playbackRate;
		const level = this.context.createGain();
		level.gain.setValueAtTime(0, when);
		level.gain.linearRampToValueAtTime(gain, when + MISS_ATTACK_S);
		source.connect(level).connect(this.output);
		source.onended = () => {
			source.disconnect();
			level.disconnect();
		};
		source.start(when, offsetS);
	}
}
