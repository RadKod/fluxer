// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	computeSpeakerAudioParams,
	equalPowerChannelGains,
	FLAT_GAIN,
	HRTF_STICKY_MARGIN_M,
	listenerForward,
	MAX_HRTF_SPEAKERS,
	peakChannelGain,
	SPEAKER_GAIN,
	type SpatialAudioInput,
	type SpatialListener,
	type SpatialSpeaker,
	type SpeakerAudioParams,
	spatialSpeakerKey,
} from '@app/features/voice_scene/audio/SpatialAudioMath';
import type {Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {describe, expect, it} from 'vitest';

const ORIGIN: Vec3 = {x: 0, y: 0, z: 0};
const LISTENER: SpatialListener = {position: ORIGIN, azimuth: 0};

function speaker(identity: string, position: Vec3, kind: 'mic' | 'screen' = 'mic'): SpatialSpeaker {
	return {identity, kind, position};
}

function paramsFor(speakers: ReadonlyArray<SpatialSpeaker>, listener = LISTENER) {
	return {
		spatial: computeSpeakerAudioParams({listener, speakers}, 'spatial'),
		flat: computeSpeakerAudioParams({listener, speakers}, 'flat'),
	};
}

describe('SpatialAudioMath', () => {
	it('speaker gain 0.708 for every speaker, flat mode √2 with centered equalpower', () => {
		expect(SPEAKER_GAIN).toBeCloseTo(0.708, 3);
		expect(FLAT_GAIN).toBeCloseTo(Math.SQRT2, 12);
		const speakers = [speaker('a', {x: 1, y: 0, z: 0}), speaker('b', {x: -1, y: 0, z: 1})];
		const {spatial, flat} = paramsFor(speakers);
		expect(spatial.get(spatialSpeakerKey('a', 'mic'))!.gain).toBe(SPEAKER_GAIN);
		expect(spatial.get(spatialSpeakerKey('b', 'mic'))!.gain).toBe(SPEAKER_GAIN);
		for (const params of flat.values()) {
			expect(params.gain).toBe(FLAT_GAIN);
			expect(params.panningModel).toBe('equalpower');
			const [left, right] = equalPowerChannelGains(params.position);
			expect(left * params.gain).toBeCloseTo(1, 12);
			expect(right * params.gain).toBeCloseTo(1, 12);
		}
	});

	it('per-channel gain (pan law × speaker gain) ≤ 1 for every position, mode and model', () => {
		const speakers: Array<SpatialSpeaker> = [];
		for (let i = 0; i < 64; i++) {
			const angle = (i / 64) * Math.PI * 2;
			const radius = 0.25 + (i % 5);
			const position = {x: Math.cos(angle) * radius, y: (i % 3) - 1, z: Math.sin(angle) * radius};
			speakers.push(speaker(`u${i}`, position, i % 7 === 0 ? 'screen' : 'mic'));
		}
		speakers.push(speaker('same-spot', ORIGIN));
		for (const azimuth of [0, 0.4, -0.785, Math.PI / 2, Math.PI]) {
			const {spatial, flat} = paramsFor(speakers, {position: ORIGIN, azimuth});
			for (const params of [...spatial.values(), ...flat.values()]) {
				expect(peakChannelGain(params)).toBeLessThanOrEqual(1 + 1e-9);
			}
		}
	});

	it('stereo input at the edge stays ≤ 1 per channel', () => {
		// The panner runs channelCount 1 / explicit: Web Audio downmixes stereo to mono as (L + R) / 2 before panning.
		const downmix = (left: number, right: number): number => (left + right) / 2;
		const edges = [speaker('left', {x: -3, y: 0, z: 0}), speaker('right', {x: 3, y: 0, z: 0})];
		edges.push(speaker('tv', {x: 3, y: 0, z: 0}, 'screen'), speaker('far', {x: -3, y: 0, z: 0}));
		const {spatial, flat} = paramsFor(edges);
		for (const params of [...spatial.values(), ...flat.values()]) {
			for (const [left, right] of [
				[1, 1],
				[1, -1],
				[1, 0],
				[-1, -1],
			] as const) {
				expect(Math.abs(downmix(left, right)) * peakChannelGain(params)).toBeLessThanOrEqual(1 + 1e-9);
			}
		}
		const [hardLeft, hardRight] = equalPowerChannelGains(spatial.get(spatialSpeakerKey('right', 'mic'))!.position);
		expect(hardLeft).toBeCloseTo(0, 9);
		expect(hardRight).toBeCloseTo(1, 9);
	});

	it('camera rotation never changes panningModel', () => {
		const speakers = Array.from({length: 8}, (_, i) =>
			speaker(`s${i}`, {x: Math.cos(i) * 3, y: 0, z: Math.sin(i) * 3}),
		);
		speakers.push(speaker('s1', {x: 0, y: 1, z: -4}, 'screen'));
		const home = {camHome: {x: 0, y: 5, z: 8}, camTarget: ORIGIN};
		const models = (azimuth: number) =>
			[...computeSpeakerAudioParams({listener: {position: ORIGIN, azimuth, home}, speakers}, 'spatial').entries()].map(
				([key, params]) => `${key}=${params.panningModel}`,
			);
		const atHome = models(0);
		expect(atHome.filter((model) => model.endsWith('=HRTF'))).toHaveLength(MAX_HRTF_SPEAKERS);
		for (let degrees = -45; degrees <= 45; degrees += 5) expect(models((degrees * Math.PI) / 180)).toEqual(atHome);
	});

	it('HRTF on at most 4 nearest speakers, sticky under distance changes', () => {
		expect(MAX_HRTF_SPEAKERS).toBe(4);
		expect(HRTF_STICKY_MARGIN_M).toBe(0.5);
		const hrtfKeys = (params: ReadonlyMap<string, SpeakerAudioParams>): Array<string> =>
			[...params]
				.filter(([, p]) => p.panningModel === 'HRTF')
				.map(([key]) => key)
				.sort();
		const run = (speakers: ReadonlyArray<SpatialSpeaker>, previous?: ReadonlyMap<string, SpeakerAudioParams>) =>
			computeSpeakerAudioParams({listener: LISTENER, speakers}, 'spatial', previous);
		const at = (x: number, z = 0): Vec3 => ({x, y: 0, z});
		// Nearest four; the far speaker loses. A tie keeps the input (seat) order.
		const seats = [
			speaker('same-far', at(9)),
			speaker('b1', at(1)),
			speaker('b2', at(0, 2)),
			speaker('tie-1', at(-3)),
			speaker('tie-2', at(3)),
			speaker('tv', at(0, -2.5), 'screen'),
		];
		const first = run(seats);
		const nearest = ['mic:b1', 'mic:b2', 'mic:tie-1', 'screen:tv'];
		expect(hrtfKeys(first)).toEqual(nearest);

		// tie-2 steps 0.1 m closer than tie-1: within the margin, nobody swaps (no 30 ms dip on a talker).
		const closer = seats.map((s) => (s.identity === 'tie-2' ? speaker('tie-2', at(2.9)) : s));
		expect(hrtfKeys(run(closer, first))).toEqual(nearest);
		// The stickiness comes only from the previous assignment: fresh, the strictly nearest four win.
		expect(hrtfKeys(run(closer))).toEqual(['mic:b1', 'mic:b2', 'mic:tie-2', 'screen:tv']);

		// Someone sits right next to me: closer by more than the margin, so the farthest holder gives way.
		const neighbour = [...seats, speaker('next', at(0.4, 0.3))];
		expect(hrtfKeys(run(neighbour, first))).toEqual(['mic:b1', 'mic:b2', 'mic:next', 'screen:tv']);

		// tie-1 walks across the room: beyond the margin, the nearest takes over.
		const away = closer.map((s) => (s.identity === 'tie-1' ? speaker('tie-1', at(-6)) : s));
		expect(hrtfKeys(run(away, first))).toEqual(['mic:b1', 'mic:b2', 'mic:tie-2', 'screen:tv']);

		// Flat mode holds no HRTF, so turning spatial back on starts fresh.
		const flat = computeSpeakerAudioParams({listener: LISTENER, speakers: closer}, 'flat');
		expect(hrtfKeys(run(closer, flat))).toEqual(['mic:b1', 'mic:b2', 'mic:tie-2', 'screen:tv']);
	});

	it('gain never changes with distance, and every peak stays ≤ 1', () => {
		const speakers: Array<SpatialSpeaker> = [];
		for (let i = 0; i < 96; i++) {
			const angle = (i / 96) * Math.PI * 2;
			const radius = (i % 12) * 1.75; // 0 … 19.25 m
			const position = {x: Math.cos(angle) * radius, y: (i % 3) * 0.6 - 0.6, z: Math.sin(angle) * radius};
			speakers.push(speaker(`u${i}`, position, i % 7 === 0 ? 'screen' : 'mic'));
		}
		speakers.push(speaker('far', {x: 0, y: 0, z: -1000}));
		for (const position of [ORIGIN, {x: 3, y: 1.1, z: -2}]) {
			for (const azimuth of [0, 0.6, -Math.PI / 2, Math.PI]) {
				const input: SpatialAudioInput = {listener: {position, azimuth}, speakers};
				const spatial = computeSpeakerAudioParams(input, 'spatial');
				expect([...spatial.values()].filter((p) => p.panningModel === 'HRTF')).toHaveLength(MAX_HRTF_SPEAKERS);
				for (const s of speakers) {
					const params = spatial.get(spatialSpeakerKey(s.identity, s.kind))!;
					expect(peakChannelGain(params)).toBeLessThanOrEqual(1 + 1e-9);
					expect(params.gain).toBe(SPEAKER_GAIN);
				}
			}
		}
	});

	it('screen speaker uses the screen position and the speaker gain', () => {
		const screen = speaker('streamer', {x: 0, y: 1, z: -3}, 'screen');
		const mic = speaker('streamer', {x: 4, y: 0, z: 0});
		const {spatial} = paramsFor([mic, screen]);
		const screenParams = spatial.get(spatialSpeakerKey('streamer', 'screen'))!;
		expect(screenParams.gain).toBe(SPEAKER_GAIN);
		expect(screenParams.position).toEqual({x: 0, y: 1, z: -3});
		expect(spatial.get(spatialSpeakerKey('streamer', 'mic'))!.gain).toBe(SPEAKER_GAIN);
	});

	it('listener forward follows camera azimuth (0 → cam_home direction)', () => {
		const home = {camHome: {x: 10, y: 5, z: 10}, camTarget: ORIGIN};
		const atHome = listenerForward({position: ORIGIN, azimuth: 0, home});
		expect(atHome.x).toBeCloseTo(-Math.SQRT1_2, 9);
		expect(atHome.y).toBe(0);
		expect(atHome.z).toBeCloseTo(-Math.SQRT1_2, 9);
		const quarter = listenerForward({position: ORIGIN, azimuth: Math.PI / 2});
		expect(quarter.x).toBeCloseTo(-1, 9);
		expect(quarter.z).toBeCloseTo(0, 9);

		const ahead = [speaker('s', {x: 0, y: 0, z: -2})];
		const front = computeSpeakerAudioParams({listener: LISTENER, speakers: ahead}, 'spatial');
		const [frontLeft, frontRight] = equalPowerChannelGains(front.get(spatialSpeakerKey('s', 'mic'))!.position);
		expect(frontLeft).toBeCloseTo(frontRight, 9);
		const turned = computeSpeakerAudioParams(
			{listener: {position: ORIGIN, azimuth: Math.PI / 2}, speakers: ahead},
			'spatial',
		);
		const [turnedLeft, turnedRight] = equalPowerChannelGains(turned.get(spatialSpeakerKey('s', 'mic'))!.position);
		expect(turnedRight).toBeCloseTo(1, 9);
		expect(turnedLeft).toBeCloseTo(0, 9);
	});
});
