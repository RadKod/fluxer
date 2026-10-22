// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstrumentPart} from '@app/features/activities/band/engine/ChartModel';
import {SONG_HEADROOM_GAIN} from '@app/features/activities/band/game/BandAudio';
import {
	MISS_LEVEL_SPREAD_DB,
	MISS_RATE_SPREAD,
	MISS_SAMPLE_URLS,
	MISS_SOUND_GAP_S,
	MISS_VOICES,
	type MissSample,
	MissSound,
	missVariation,
} from '@app/features/activities/band/game/MissSound';
import {describe, expect, it, vi} from 'vitest';

class FakeParam {
	value = 0;
	setValueAtTime(value: number) {
		this.value = value;
	}
	linearRampToValueAtTime(value: number) {
		this.value = value;
	}
}

class FakeNode {
	readonly connections: Array<unknown> = [];
	connect<T>(target: T): T {
		this.connections.push(target);
		return target;
	}
	disconnect() {}
}

class FakeGain extends FakeNode {
	readonly gain = new FakeParam();
}

class FakeSource extends FakeNode {
	buffer: {sample: MissSample} | null = null;
	readonly playbackRate = new FakeParam();
	onended: (() => void) | null = null;
	started: [when: number, offset: number] | null = null;
	start(when: number, offset: number) {
		this.started = [when, offset];
	}
}

const SAMPLE_OF_URL = new Map(Object.entries(MISS_SAMPLE_URLS).map(([sample, url]) => [url, sample as MissSample]));

function setup({enabled = true, random = () => 0.5}: {enabled?: boolean; random?: () => number} = {}) {
	const sources: Array<FakeSource> = [];
	const context = {
		currentTime: 10,
		createBufferSource: () => {
			const source = new FakeSource();
			sources.push(source);
			return source;
		},
		createGain: () => new FakeGain(),
		decodeAudioData: async (bytes: ArrayBuffer) => ({sample: new TextDecoder().decode(bytes)}),
	};
	const output = new FakeNode();
	const missSound = new MissSound(
		context as unknown as BaseAudioContext,
		output as unknown as AudioNode,
		() => enabled,
		random,
	);
	const fetchBytes = vi.fn(async (url: string) => new TextEncoder().encode(SAMPLE_OF_URL.get(url)).buffer);
	return {context, missSound, sources, fetchBytes};
}

describe('missVariation', () => {
	it('stays within ±6% rate, the voice offset and 2 dB under the base level', () => {
		const voice = MISS_VOICES.guitar;
		const base = 1 / SONG_HEADROOM_GAIN;
		for (const value of [0, 0.25, 0.5, 0.999]) {
			const {playbackRate, offsetS, gain} = missVariation(voice, () => value);
			expect(playbackRate).toBeGreaterThanOrEqual(1 - MISS_RATE_SPREAD);
			expect(playbackRate).toBeLessThanOrEqual(1 + MISS_RATE_SPREAD);
			expect(offsetS).toBeGreaterThanOrEqual(0);
			expect(offsetS).toBeLessThanOrEqual(voice.maxOffsetS);
			expect(gain).toBeLessThanOrEqual(base);
			expect(gain).toBeGreaterThanOrEqual(base * 10 ** (-MISS_LEVEL_SPREAD_DB / 20));
		}
	});

	it('varies from one miss to the next', () => {
		const values = [0.1, 0.9, 0.3, 0.6];
		let call = 0;
		const random = () => values[call++ % values.length];
		const first = missVariation(MISS_VOICES.guitar, random);
		const second = missVariation(MISS_VOICES.guitar, random);
		expect(second.playbackRate).not.toBe(first.playbackRate);
		expect(second.offsetS).not.toBe(first.offsetS);
		expect(second.gain).not.toBe(first.gain);
	});

	it('cancels the song headroom so a miss peaks at its own level', () => {
		const {gain} = missVariation(MISS_VOICES.bass, () => 0);
		expect(gain * SONG_HEADROOM_GAIN).toBeCloseTo(1);
	});
});

describe('MissSound', () => {
	it('decodes every sample once, up front', async () => {
		const {missSound, fetchBytes} = setup();
		await missSound.load(fetchBytes);
		expect(fetchBytes.mock.calls.map(([url]) => url).sort()).toEqual(Object.values(MISS_SAMPLE_URLS).sort());
	});

	it.each<[InstrumentPart, MissSample]>([
		['guitar', 'pickScrape'],
		['rhythm', 'pickScrape'],
		['bass', 'mutedChug'],
		['drums', 'woodStick'],
		['keys', 'mutedChug'],
	])('plays %s misses with the %s sample', async (part, sample) => {
		const {missSound, sources, fetchBytes} = setup();
		await missSound.load(fetchBytes);
		missSound.play(part);
		expect(sources).toHaveLength(1);
		expect(sources[0].buffer).toEqual({sample});
	});

	it('plays keys softer than bass from the same sample', () => {
		expect(MISS_VOICES.keys.sample).toBe(MISS_VOICES.bass.sample);
		expect(MISS_VOICES.keys.level).toBeLessThan(MISS_VOICES.bass.level);
	});

	it('starts at the varied rate and offset, now', async () => {
		const {missSound, sources, fetchBytes} = setup({random: () => 1});
		await missSound.load(fetchBytes);
		missSound.play('guitar');
		const [source] = sources;
		expect(source.playbackRate.value).toBeCloseTo(1 + MISS_RATE_SPREAD);
		expect(source.started).toEqual([10, MISS_VOICES.guitar.maxOffsetS]);
	});

	it('plays one sound for misses within the gap, then the next after it', async () => {
		const {context, missSound, sources, fetchBytes} = setup();
		await missSound.load(fetchBytes);
		missSound.play('guitar');
		context.currentTime += 0.02;
		missSound.play('guitar');
		context.currentTime += MISS_SOUND_GAP_S - 0.03;
		missSound.play('guitar');
		expect(sources).toHaveLength(1);
		context.currentTime = 10 + MISS_SOUND_GAP_S + 0.001;
		missSound.play('guitar');
		expect(sources).toHaveLength(2);
	});

	it('stays silent with the setting off', async () => {
		const {missSound, sources, fetchBytes} = setup({enabled: false});
		await missSound.load(fetchBytes);
		missSound.play('guitar');
		missSound.play('drums');
		expect(sources).toHaveLength(0);
	});

	it('stays silent for a sample that failed to load, and does not throw', async () => {
		const {missSound, sources} = setup();
		await missSound.load(async () => {
			throw new Error('offline');
		});
		expect(() => missSound.play('drums')).not.toThrow();
		expect(sources).toHaveLength(0);
	});
});
