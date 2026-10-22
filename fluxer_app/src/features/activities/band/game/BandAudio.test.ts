// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AudioStem} from '@app/features/activities/band/engine/SongPackage';
import {
	BandAudio,
	DUCK_SHAPES,
	duckEnvelope,
	FREESTYLE_STEM_LEVEL,
	freestyleStemEnvelope,
	GUIDE_VOCAL_GAIN,
	restoreEnvelope,
	SONG_HEADROOM_GAIN,
	stemRoleForPlayback,
} from '@app/features/activities/band/game/BandAudio';
import {WHAMMY, whammyDelaySwingS} from '@app/features/activities/band/game/Whammy';
import {describe, expect, it, vi} from 'vitest';

const STRONG = DUCK_SHAPES.strong.level;

type ParamCall = readonly [method: string, value: number, time: number];

class FakeParam {
	value = 1;
	readonly calls: Array<ParamCall> = [];
	cancelScheduledValues(time: number) {
		this.calls.push(['cancel', 0, time]);
	}
	setValueAtTime(value: number, time: number) {
		this.calls.push(['set', value, time]);
		this.value = value;
	}
	linearRampToValueAtTime(value: number, time: number) {
		this.calls.push(['ramp', value, time]);
	}
	setTargetAtTime(value: number, time: number) {
		this.calls.push(['target', value, time]);
	}
	exponentialRampToValueAtTime(value: number, time: number) {
		this.calls.push(['exp', value, time]);
	}
}

class FakeNode {
	connections: Array<unknown> = [];
	connect(target: unknown) {
		this.connections.push(target);
		return target;
	}
	disconnect(target?: unknown) {
		this.connections = target === undefined ? [] : this.connections.filter((node) => node !== target);
	}
}

class FakeDelay extends FakeNode {
	readonly delayTime = new FakeParam();
}

class FakeOscillator extends FakeNode {
	readonly frequency = new FakeParam();
	started = false;
	start() {
		this.started = true;
	}
	stop() {}
}

class FakeGain extends FakeNode {
	readonly gain = new FakeParam();
}

class FakeSource extends FakeNode {
	buffer: {duration: number} | null = null;
	started: [number, number] | null = null;
	start(when: number, offset: number) {
		this.started = [when, offset];
	}
	stop() {}
}

function fakeContext(durations: Record<string, number>) {
	const gains: Array<FakeGain> = [];
	const sources: Array<FakeSource> = [];
	const delays: Array<FakeDelay> = [];
	const oscillators: Array<FakeOscillator> = [];
	const context = {
		currentTime: 5,
		destination: new FakeNode(),
		createDelay: () => {
			const delay = new FakeDelay();
			delays.push(delay);
			return delay;
		},
		createOscillator: () => {
			const oscillator = new FakeOscillator();
			oscillators.push(oscillator);
			return oscillator;
		},
		createGain: () => {
			const gain = new FakeGain();
			gains.push(gain);
			return gain;
		},
		createBufferSource: () => {
			const source = new FakeSource();
			sources.push(source);
			return source;
		},
		decodeAudioData: vi.fn(async (data: ArrayBuffer) => ({
			duration: durations[new TextDecoder().decode(data)] ?? 0,
		})),
	};
	return {context: context as unknown as AudioContext, gains, sources, delays, oscillators};
}

function stem(role: AudioStem['role'], name: string): AudioStem {
	return {role, fileName: `${name}.opus`, format: 'opus', data: new TextEncoder().encode(name)};
}

describe('BandAudio', () => {
	it('drops a part to near silence on a miss and keeps it there until a hit restores it', () => {
		const points = duckEnvelope(10, 1, 1);
		expect(points).toEqual([
			{time: 10, value: 1, ramp: false},
			{time: 10.03, value: 0.05, ramp: true},
		]);
		expect(restoreEnvelope(12, 1, 0.05)).toEqual([
			{time: 12, value: 0.05, ramp: false},
			{time: 12.08, value: 1, ramp: true},
		]);
	});

	it('only thins the part when the light duck is chosen', () => {
		expect(duckEnvelope(10, 1, 1, 'light')[1].value).toBe(0.3);
	});

	it('plays single-mix songs as backing so nothing ducks them', () => {
		expect(stemRoleForPlayback('guitar', false)).toBe('backing');
		expect(stemRoleForPlayback('guitar', true)).toBe('guitar');
		expect(stemRoleForPlayback('preview', true)).toBeNull();
	});

	it('starts every stem at the scheduled time and skips stems that ended before a late join', async () => {
		const {context, sources} = fakeContext({gtr: 200, drm1: 200, drm2: 200, crowd: 20});
		const audio = new BandAudio(context);
		await audio.loadStems(
			[stem('guitar', 'gtr'), stem('drums', 'drm1'), stem('drums', 'drm2'), stem('crowd', 'crowd')],
			true,
		);
		expect(audio.durationMs).toBe(200_000);
		audio.start({contextTime: 6, offsetSeconds: 30, songZeroContextTime: -24});
		expect(sources.map((source) => source.started)).toEqual([
			[6, 30],
			[6, 30],
			[6, 30],
		]);
	});

	it('ducks only the missed part and never the backing track', async () => {
		const {context, gains} = fakeContext({gtr: 100, song: 100});
		const audio = new BandAudio(context);
		await audio.loadStems([stem('guitar', 'gtr'), stem('backing', 'song')], true);
		const [, guitarGain, backingGain] = gains;
		audio.duck('guitar', 'strong');
		audio.duck('drums', 'strong');
		expect(guitarGain.gain.calls.map(([method]) => method)).toEqual(['cancel', 'set', 'ramp']);
		audio.restore('guitar');
		audio.restore('guitar');
		expect(guitarGain.gain.calls.map(([method]) => method)).toEqual(['cancel', 'set', 'ramp', 'cancel', 'set', 'ramp']);
		expect(guitarGain.gain.calls[2]).toEqual(['ramp', STRONG, 5.03]);
		expect(backingGain.gain.calls).toEqual([]);
	});

	it('ducks the rhythm guitar stem on its own, apart from the lead', async () => {
		const {context, gains} = fakeContext({gtr: 100, rhy: 100});
		const audio = new BandAudio(context);
		await audio.loadStems([stem('guitar', 'gtr'), stem('rhythm', 'rhy')], true);
		const [, guitarGain, rhythmGain] = gains;
		audio.duck('rhythm', 'strong');
		expect(rhythmGain.gain.calls[2]).toEqual(['ramp', STRONG, 5.03]);
		expect(guitarGain.gain.calls).toEqual([]);
	});

	it('keeps the vocals stem as a guide under a live singer, at -12 dB', async () => {
		const {context, gains} = fakeContext({vox: 100});
		const audio = new BandAudio(context);
		await audio.loadStems([stem('vocals', 'vox')], true);
		audio.setPartLevel('vocals', GUIDE_VOCAL_GAIN);
		const vocalsGain = gains[1];
		expect(GUIDE_VOCAL_GAIN).toBe(0.25);
		expect(20 * Math.log10(GUIDE_VOCAL_GAIN)).toBeCloseTo(-12, 0);
		expect(vocalsGain.gain.value).toBe(GUIDE_VOCAL_GAIN);
	});

	it('silences a part set to level zero, misses included', async () => {
		const {context, gains} = fakeContext({vox: 100});
		const audio = new BandAudio(context);
		await audio.loadStems([stem('vocals', 'vox')], true);
		audio.setPartLevel('vocals', 0);
		const vocalsGain = gains[1];
		expect(vocalsGain.gain.value).toBe(0);
		vocalsGain.gain.calls.length = 0;
		audio.duck('vocals', 'strong');
		expect(vocalsGain.gain.calls).toEqual([]);
	});

	it('plays the song 3 dB down so a full-scale song stays under the voice soft-clip knee', () => {
		const {context, gains} = fakeContext({});
		const audio = new BandAudio(context);
		const master = gains[0];
		expect(master.gain.value).toBe(SONG_HEADROOM_GAIN);
		audio.setVolume(1);
		expect(master.gain.calls.at(-1)).toEqual(['target', SONG_HEADROOM_GAIN, 5]);
		audio.setVolume(0.5);
		expect(master.gain.calls.at(-1)).toEqual(['target', 0.5 * SONG_HEADROOM_GAIN, 5]);
		expect(SONG_HEADROOM_GAIN).toBeLessThan(0.8);
	});

	it('ducks the soloist stem to a fifth under each freestyle section and brings it back after', async () => {
		const {context, gains} = fakeContext({gtr: 100, song: 100});
		const audio = new BandAudio(context);
		await audio.loadStems([stem('guitar', 'gtr'), stem('backing', 'song')], true);
		const [master, guitarGain] = gains;
		audio.scheduleFreestyleSolos('guitar', [
			{startTime: 20, endTime: 30},
			{startTime: 50, endTime: 55},
		]);
		const freestyleGain = gains[3];
		expect(guitarGain.connections).toEqual([freestyleGain]);
		expect(freestyleGain.connections).toEqual([master]);
		expect(freestyleGain.gain.calls.filter(([method]) => method !== 'cancel')).toEqual([
			['set', 1, 20],
			['ramp', FREESTYLE_STEM_LEVEL, 20.12],
			['set', FREESTYLE_STEM_LEVEL, 30],
			['ramp', 1, 30.12],
			['set', 1, 50],
			['ramp', FREESTYLE_STEM_LEVEL, 50.12],
			['set', FREESTYLE_STEM_LEVEL, 55],
			['ramp', 1, 55.12],
		]);
		expect(FREESTYLE_STEM_LEVEL).toBe(0.2);
		// A miss during the song still ducks the part on its own gain, on top of the freestyle level.
		audio.duck('guitar', 'strong');
		expect(guitarGain.gain.calls.at(-1)).toEqual(['ramp', STRONG, 5.03]);
		expect(freestyleStemEnvelope([])).toEqual([]);
	});

	it('runs a whammy part through a delay line whose swing follows the whammy, and leaves the rest alone', async () => {
		const {context, gains, delays, oscillators} = fakeContext({gtr: 100, drm: 100});
		const audio = new BandAudio(context);
		await audio.loadStems([stem('guitar', 'gtr'), stem('drums', 'drm')], true);
		expect(audio.enableWhammy('guitar')).toBe(true);
		expect(audio.enableWhammy('guitar')).toBe(true);
		expect(audio.enableWhammy('bass')).toBe(false);
		expect(delays).toHaveLength(1);
		const [delay] = delays;
		const [lfo] = oscillators;
		const [master, guitarGain, drumsGain, swing] = gains;
		expect(delay.delayTime.value).toBe(WHAMMY.baseDelayS);
		expect(guitarGain.connections).toEqual([delay]);
		expect(delay.connections).toEqual([master]);
		expect(drumsGain.connections).toEqual([master]);
		expect(lfo.started).toBe(true);
		expect(swing.connections).toEqual([delay.delayTime]);

		const modulation = {depthCents: 40, rateHz: 6};
		audio.setWhammy('guitar', modulation);
		expect(swing.gain.calls.at(-1)).toEqual(['target', whammyDelaySwingS(modulation), 5]);
		expect(lfo.frequency.calls.at(-1)).toEqual(['target', 6, 5]);
		audio.setWhammy('guitar', {depthCents: 0, rateHz: 6});
		expect(swing.gain.calls.at(-1)).toEqual(['target', 0, 5]);
	});

	it('releases the shared context lease once on dispose', async () => {
		const release = vi.fn();
		const {context} = fakeContext({});
		const audio = new BandAudio(context, release);
		audio.dispose();
		audio.dispose();
		expect(release).toHaveBeenCalledTimes(1);
	});
});
