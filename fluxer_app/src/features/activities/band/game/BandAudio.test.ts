// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AudioStem} from '@app/features/activities/band/engine/SongPackage';
import {
	BandAudio,
	DUCK_SHAPES,
	duckEnvelope,
	restoreEnvelope,
	stemRoleForPlayback,
} from '@app/features/activities/band/game/BandAudio';
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
	readonly connections: Array<unknown> = [];
	connect(target: unknown) {
		this.connections.push(target);
		return target;
	}
	disconnect() {}
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
	const context = {
		currentTime: 5,
		destination: new FakeNode(),
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
	return {context: context as unknown as AudioContext, gains, sources};
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

	it('mutes the vocals stem for a live singer and leaves it silent through misses', async () => {
		const {context, gains} = fakeContext({vox: 100});
		const audio = new BandAudio(context);
		await audio.loadStems([stem('vocals', 'vox')], true);
		audio.setPartMuted('vocals', true);
		const vocalsGain = gains[1];
		expect(vocalsGain.gain.value).toBe(0);
		vocalsGain.gain.calls.length = 0;
		audio.duck('vocals', 'strong');
		expect(vocalsGain.gain.calls).toEqual([]);
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
