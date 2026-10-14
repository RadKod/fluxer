// SPDX-License-Identifier: AGPL-3.0-or-later

import {EventEmitter} from 'node:events';
import {createRoomSpatialAudio, type SpatialSpeaker} from '@app/features/voice_scene/audio/RoomSpatialAudio';
import {FLAT_GAIN, SPEAKER_GAIN} from '@app/features/voice_scene/audio/SpatialAudioMath';
import {type Room, RoomEvent, Track} from 'livekit-client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const RAMP = 0.05;

class FakeParam {
	value = 0;
	target = 0;
	readonly setTargetAtTime = vi.fn((target: number) => {
		this.target = target;
		return this;
	});
}

function fakeContext(): AudioContext {
	return {
		currentTime: 2.5,
		createPanner: () => ({positionX: new FakeParam(), positionY: new FakeParam(), positionZ: new FakeParam()}),
		createGain: () => ({gain: new FakeParam()}),
	} as unknown as AudioContext;
}

interface FakeTrack {
	kind: 'audio';
	setWebAudioPlugins: ReturnType<typeof vi.fn>;
}

function fakeTrack(): FakeTrack {
	return {kind: 'audio', setWebAudioPlugins: vi.fn()};
}

interface FakeChain {
	panner: {
		positionX: FakeParam;
		positionY: FakeParam;
		positionZ: FakeParam;
		panningModel: string;
		rolloffFactor: number;
		channelCount: number;
		channelCountMode: string;
	};
	gain: {gain: FakeParam};
}

function chainOf(track: FakeTrack): FakeChain {
	const [panner, gain] = track.setWebAudioPlugins.mock.calls[0]![0];
	return {panner, gain};
}

function fakeRoom(participants: Record<string, Array<{track: FakeTrack; source: Track.Source}>>) {
	const remoteParticipants = new Map(
		Object.entries(participants).map(([identity, publications]) => [
			identity,
			{identity, audioTrackPublications: new Map(publications.map((p, i) => [`TR_${identity}_${i}`, p]))},
		]),
	);
	const emitter = Object.assign(new EventEmitter(), {remoteParticipants});
	return {room: emitter as unknown as Room, emitter};
}

function seated(identity: string, x: number): SpatialSpeaker {
	return {identity, kind: 'mic', position: {x, y: 1, z: 0}};
}

function updateInput(speakers: ReadonlyArray<SpatialSpeaker>, azimuth = 0) {
	return {listener: {position: {x: 0, y: 1, z: 0}, azimuth}, speakers};
}

function spyValueWrites(chain: FakeChain): ReturnType<typeof vi.fn> {
	const written = vi.fn();
	for (const param of [chain.panner.positionX, chain.panner.positionY, chain.panner.positionZ, chain.gain.gain]) {
		Object.defineProperty(param, 'value', {set: written, get: () => 0});
	}
	return written;
}

describe('RoomSpatialAudio', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('installs the plugin list once per track; 50 updates and spatial→flat→spatial only change AudioParam targets', () => {
		const mic = fakeTrack();
		const {room} = fakeRoom({user_1_a: [{track: mic, source: Track.Source.Microphone}]});
		const controller = createRoomSpatialAudio(fakeContext);
		controller.attach(room);
		const {panner, gain} = chainOf(mic);
		const written = spyValueWrites(chainOf(mic));
		for (let i = 0; i < 50; i++) controller.update(updateInput([seated('user_1_a', 1 + i / 10)], i / 50));
		vi.runAllTimers();
		controller.setMode('flat');
		vi.runAllTimers();
		expect(gain.gain.setTargetAtTime).toHaveBeenCalledWith(FLAT_GAIN, 2.5, RAMP);
		controller.setMode('spatial');
		vi.runAllTimers();
		expect(mic.setWebAudioPlugins).toHaveBeenCalledTimes(1);
		expect(written).not.toHaveBeenCalled();
		expect(panner.positionX.setTargetAtTime.mock.calls.length).toBeGreaterThanOrEqual(52);
		expect(gain.gain.target).toBeCloseTo(SPEAKER_GAIN, 12);
	});

	it('new track subscribed later gets its chain once', () => {
		const {room, emitter} = fakeRoom({});
		const controller = createRoomSpatialAudio(fakeContext);
		controller.attach(room);
		controller.update(updateInput([seated('user_2_b', 2)]));
		const late = fakeTrack();
		const publication = {track: late, source: Track.Source.Microphone};
		emitter.emit(RoomEvent.TrackSubscribed, late, publication, {identity: 'user_2_b'});
		emitter.emit(RoomEvent.TrackSubscribed, late, publication, {identity: 'user_2_b'});
		controller.update(updateInput([seated('user_2_b', 3)]));
		expect(late.setWebAudioPlugins).toHaveBeenCalledTimes(1);
		expect(chainOf(late).gain.gain.target).toBeCloseTo(SPEAKER_GAIN, 12);
	});

	it('unsubscribed track is forgotten (WeakMap)', () => {
		const mic = fakeTrack();
		const publication = {track: mic, source: Track.Source.Microphone};
		const {room, emitter} = fakeRoom({user_3_c: [publication]});
		const controller = createRoomSpatialAudio(fakeContext);
		controller.attach(room);
		controller.update(updateInput([seated('user_3_c', 1)]));
		emitter.emit(RoomEvent.TrackUnsubscribed, mic, publication, {identity: 'user_3_c'});
		const {panner} = chainOf(mic);
		const callsBefore = panner.positionX.setTargetAtTime.mock.calls.length;
		controller.update(updateInput([seated('user_3_c', 4)]));
		controller.setMode('flat');
		expect(panner.positionX.setTargetAtTime.mock.calls.length).toBe(callsBefore);
	});

	it('returns no-op controller when shared context is null', () => {
		const mic = fakeTrack();
		const {room, emitter} = fakeRoom({user_4_d: [{track: mic, source: Track.Source.Microphone}]});
		const controller = createRoomSpatialAudio(() => null);
		controller.attach(room);
		controller.update(updateInput([seated('user_4_d', 1)]));
		controller.setMode('flat');
		controller.detach();
		expect(emitter.listenerCount(RoomEvent.TrackSubscribed)).toBe(0);
		expect(mic.setWebAudioPlugins).not.toHaveBeenCalled();
	});

	it('position changes use setTargetAtTime (no zipper)', () => {
		const mic = fakeTrack();
		const {room} = fakeRoom({user_5_e: [{track: mic, source: Track.Source.Microphone}]});
		const controller = createRoomSpatialAudio(fakeContext);
		controller.attach(room);
		const {panner} = chainOf(mic);
		const assigned = vi.fn();
		Object.defineProperty(panner.positionX, 'value', {set: assigned, get: () => 0});
		controller.update(updateInput([seated('user_5_e', 3)]));
		expect(panner.positionX.setTargetAtTime).toHaveBeenLastCalledWith(3, 2.5, RAMP);
		expect(assigned).not.toHaveBeenCalled();
	});

	it('closing the room view restores the original chain once; spatial off inside the room keeps the chain', () => {
		const mic = fakeTrack();
		const screen = fakeTrack();
		const {room, emitter} = fakeRoom({
			user_6_f: [
				{track: mic, source: Track.Source.Microphone},
				{track: screen, source: Track.Source.ScreenShareAudio},
			],
		});
		const controller = createRoomSpatialAudio(fakeContext);
		controller.attach(room);
		controller.update(updateInput([seated('user_6_f', 2)]));
		controller.setMode('flat');
		vi.runAllTimers();
		for (const track of [mic, screen]) expect(track.setWebAudioPlugins).toHaveBeenCalledTimes(1);
		controller.detach();
		controller.detach();
		expect(emitter.listenerCount(RoomEvent.TrackSubscribed)).toBe(0);
		expect(emitter.listenerCount(RoomEvent.TrackUnsubscribed)).toBe(0);
		// LiveKit's own list is empty: no panner, so the stereo screen share is stereo again.
		for (const track of [mic, screen]) {
			expect(track.setWebAudioPlugins).toHaveBeenCalledTimes(2);
			expect(track.setWebAudioPlugins).toHaveBeenLastCalledWith([]);
		}
		// Reopening the room builds a fresh chain.
		createRoomSpatialAudio(fakeContext).attach(room);
		expect(mic.setWebAudioPlugins).toHaveBeenCalledTimes(3);
		expect(mic.setWebAudioPlugins.mock.lastCall?.[0]).toHaveLength(2);
	});

	it('does not touch tracks while flat until spatial is first enabled', () => {
		const mic = fakeTrack();
		const screen = fakeTrack();
		const {room} = fakeRoom({
			user_7_g: [
				{track: mic, source: Track.Source.Microphone},
				{track: screen, source: Track.Source.ScreenShareAudio},
			],
		});
		const controller = createRoomSpatialAudio(fakeContext);
		controller.setMode('flat');
		controller.attach(room);
		controller.update(updateInput([seated('user_7_g', 1)]));
		expect(mic.setWebAudioPlugins).not.toHaveBeenCalled();
		controller.setMode('spatial');
		expect(mic.setWebAudioPlugins).toHaveBeenCalledTimes(1);
		expect(screen.setWebAudioPlugins).toHaveBeenCalledTimes(1);
	});
	it('downmixes every panner to mono (channelCount 1, explicit)', () => {
		const mic = fakeTrack();
		const screen = fakeTrack();
		const {room} = fakeRoom({
			user_8_h: [
				{track: mic, source: Track.Source.Microphone},
				{track: screen, source: Track.Source.ScreenShareAudio},
			],
		});
		createRoomSpatialAudio(fakeContext).attach(room);
		for (const track of [mic, screen]) {
			expect(chainOf(track).panner.channelCount).toBe(1);
			expect(chainOf(track).panner.channelCountMode).toBe('explicit');
		}
	});

	it('spatial off inside the room puts every chain to flat via AudioParam only, no plugin rebuild', () => {
		const tracks = Array.from({length: 6}, () => fakeTrack());
		const {room} = fakeRoom(
			Object.fromEntries(tracks.map((track, i) => [`user_9${i}_x`, [{track, source: Track.Source.Microphone}]])),
		);
		const controller = createRoomSpatialAudio(fakeContext);
		controller.update(updateInput(tracks.map((_, i) => seated(`user_9${i}_x`, i + 1))));
		controller.attach(room);
		const models = tracks.map((track) => chainOf(track).panner.panningModel);
		expect(models.filter((model) => model === 'HRTF')).toHaveLength(4);
		const writes = tracks.map((track) => spyValueWrites(chainOf(track)));
		controller.setMode('flat');
		vi.runAllTimers();
		for (const [i, track] of tracks.entries()) {
			const {panner, gain} = chainOf(track);
			expect(track.setWebAudioPlugins).toHaveBeenCalledTimes(1);
			expect(writes[i]).not.toHaveBeenCalled();
			expect(panner.panningModel).toBe('equalpower');
			expect([panner.positionX.target, panner.positionY.target, panner.positionZ.target]).toEqual([0, 0, -1]);
			expect(gain.gain.target).toBe(FLAT_GAIN);
		}
	});

	it('HRTF ↔ equalpower swap fades the gain to 0, changes the model, then ramps back (no click)', () => {
		const mic = fakeTrack();
		const {room} = fakeRoom({user_10_k: [{track: mic, source: Track.Source.Microphone}]});
		const controller = createRoomSpatialAudio(fakeContext);
		controller.update(updateInput([seated('user_10_k', 2)]));
		controller.attach(room);
		const {panner, gain} = chainOf(mic);
		expect(panner.panningModel).toBe('HRTF');
		controller.setMode('flat');
		expect(panner.panningModel).toBe('HRTF');
		expect(gain.gain.target).toBe(0);
		vi.advanceTimersByTime(29);
		controller.setMode('spatial');
		controller.setMode('flat');
		expect(gain.gain.target).toBe(0);
		vi.advanceTimersByTime(1);
		expect(panner.panningModel).toBe('equalpower');
		expect(gain.gain.target).toBe(FLAT_GAIN);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rolloffFactor stays 0 and distance never changes the gain', () => {
		const mic = fakeTrack();
		const {room} = fakeRoom({user_11_m: [{track: mic, source: Track.Source.Microphone}]});
		const controller = createRoomSpatialAudio(fakeContext);
		controller.attach(room);
		const {panner, gain} = chainOf(mic);
		for (const x of [1, 6, 20, 0.5]) {
			controller.update(updateInput([seated('user_11_m', x)]));
			vi.runAllTimers(); // the first update swaps equalpower → HRTF through the dip
			expect(panner.rolloffFactor).toBe(0);
			expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(SPEAKER_GAIN, 2.5, RAMP);
		}
		expect(mic.setWebAudioPlugins).toHaveBeenCalledTimes(1);
	});

	it('HRTF goes to the nearest four and sticks across updates; a real swap still dips the gain', () => {
		const tracks = Array.from({length: 5}, () => fakeTrack());
		const ids = tracks.map((_, i) => `user_12${i}_n`);
		const {room} = fakeRoom(
			Object.fromEntries(tracks.map((track, i) => [ids[i], [{track, source: Track.Source.Microphone}]])),
		);
		const controller = createRoomSpatialAudio(fakeContext);
		// Seat order puts the nearest speaker last; HRTF follows distance, not order.
		const place = (xs: ReadonlyArray<number>) => updateInput(xs.map((x, i) => seated(ids[i]!, x)));
		controller.update(place([5, 2, 3, 4, 1]));
		controller.attach(room);
		const models = () => tracks.map((track) => chainOf(track).panner.panningModel);
		expect(models()).toEqual(['equalpower', 'HRTF', 'HRTF', 'HRTF', 'HRTF']);
		const zeroTargets = () =>
			tracks.map(
				(track) => chainOf(track).gain.gain.setTargetAtTime.mock.calls.filter(([target]) => target === 0).length,
			);
		const dipsBefore = zeroTargets();
		// The first speaker comes 0.2 m closer than the farthest holder: inside the margin, no swap, no dip.
		controller.update(place([3.8, 2, 3, 4, 1]));
		vi.runAllTimers();
		expect(models()).toEqual(['equalpower', 'HRTF', 'HRTF', 'HRTF', 'HRTF']);
		expect(zeroTargets()).toEqual(dipsBefore);
		// Now clearly nearer: the farthest holder gives way, both swaps go through the gain dip.
		controller.update(place([2.5, 2, 3, 4, 1]));
		expect(zeroTargets()[0]).toBe(dipsBefore[0]! + 1);
		expect(zeroTargets()[3]).toBe(dipsBefore[3]! + 1);
		vi.runAllTimers();
		expect(models()).toEqual(['HRTF', 'HRTF', 'HRTF', 'equalpower', 'HRTF']);
	});
});
