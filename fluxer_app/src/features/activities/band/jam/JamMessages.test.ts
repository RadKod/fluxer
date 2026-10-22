// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AudioClockAnchor} from '@app/features/activities/band/engine/SessionClock';
import {
	decodeJamMessage,
	encodeJamEvents,
	JAM_JITTER_BUFFER_MS,
	JAM_TIME_WRAP_MS,
	type JamEvent,
	remoteEventContextTime,
	unwrapSessionTime,
	wrapSessionTime,
} from '@app/features/activities/band/jam/JamMessages';
import {orderedRemoteTime} from '@app/features/activities/band/jam/JamPlayer';
import {encodeActivityEnvelope} from '@app/features/activities/session/ActivityEnvelope';
import {describe, expect, it} from 'vitest';

const NOW = 1_761_200_000_123;

const EVENTS: ReadonlyArray<JamEvent> = [
	{kind: 'noteOn', time: NOW - 40, note: 57, velocity: 0.9, pinchHarmonic: 0, powerChord: false, clean: false},
	{kind: 'noteOn', time: NOW - 30, note: 62, velocity: 1, pinchHarmonic: 5, powerChord: false, clean: false},
	{kind: 'noteOn', time: NOW - 20, note: 45, velocity: 0.5, pinchHarmonic: 0, powerChord: true, clean: true},
	{kind: 'bendOn', time: NOW - 10, semitones: 3},
	{kind: 'bendOff', time: NOW - 5},
	{kind: 'noteOff', time: NOW, note: 57},
];

describe('JamMessages', () => {
	it('round-trips every event kind', () => {
		const decoded = decodeJamMessage(encodeJamEvents(EVENTS), NOW + 60);
		expect(decoded).toEqual(
			EVENTS.map((event) =>
				event.kind === 'noteOn' ? {...event, velocity: Math.round(event.velocity * 127) / 127} : event,
			),
		);
	});

	it('is small: a note on fits in under 80 bytes with the activity envelope', () => {
		const message = encodeJamEvents([EVENTS[0]]);
		expect(message.e).toEqual([0, wrapSessionTime(NOW - 40), 57, 114, 0]);
		expect(encodeActivityEnvelope('app', 12345, message).byteLength).toBeLessThan(80);
	});

	it('unwraps times across the wrap boundary', () => {
		const boundary = Math.ceil(NOW / JAM_TIME_WRAP_MS) * JAM_TIME_WRAP_MS;
		const sentBefore = boundary - 30;
		const receivedAfter = boundary + 50;
		expect(unwrapSessionTime(wrapSessionTime(sentBefore), receivedAfter)).toBe(sentBefore);
		expect(unwrapSessionTime(wrapSessionTime(boundary + 10), boundary - 20)).toBe(boundary + 10);
		expect(unwrapSessionTime(wrapSessionTime(NOW), NOW)).toBe(NOW);
	});

	it('drops malformed messages whole', () => {
		const ok = encodeJamEvents([EVENTS[0]]).e;
		const bad: ReadonlyArray<unknown> = [
			null,
			{t: 'band.hit', e: ok},
			{t: 'band.jam'},
			{t: 'band.jam', e: [9, 0]},
			{t: 'band.jam', e: [0, 5, 57, 0, 0]},
			{t: 'band.jam', e: [0, 5, 128, 100, 0]},
			{t: 'band.jam', e: [0, 5, 57, 100, 4]},
			{t: 'band.jam', e: [0, JAM_TIME_WRAP_MS, 57, 100, 0]},
			{t: 'band.jam', e: [2, 5, 4]},
			{t: 'band.jam', e: [...ok, 1, 5]},
			{t: 'band.jam', e: [0, 5.5, 57, 100, 0]},
		];
		for (const payload of bad) expect(decodeJamMessage(payload, NOW)).toBeNull();
		expect(decodeJamMessage({t: 'band.jam', e: []}, NOW)).toEqual([]);
	});

	it('clamps the pinch harmonic to a sendable one', () => {
		const event: JamEvent = {...EVENTS[0], kind: 'noteOn', pinchHarmonic: 9} as JamEvent;
		expect(encodeJamEvents([event]).e[4]).toBe(0);
	});
});

describe('remoteEventContextTime', () => {
	// AudioContext time 10 s was heard at local epoch 1_761_200_000_000 ms; the session clock runs 200 ms ahead.
	const anchor: AudioClockAnchor = {contextTime: 10, performanceTime: 0, timeOrigin: 1_761_200_000_000};
	const offset = 200;
	const played = 1_761_200_000_200 + 1000; // session time of a note played at context time 11 s

	it('plays an event one jitter buffer after it was played', () => {
		const schedule = remoteEventContextTime(played, offset, anchor, 11.03);
		expect(schedule.lateMs).toBe(0);
		expect(schedule.contextTime).toBeCloseTo(11 + JAM_JITTER_BUFFER_MS / 1000, 9);
	});

	it('plays a late event at once and says how late', () => {
		const schedule = remoteEventContextTime(played, offset, anchor, 11.2, 80);
		expect(schedule.contextTime).toBe(11.2);
		expect(schedule.lateMs).toBeCloseTo(120, 6);
	});

	it('does not trust an event far in the future', () => {
		const schedule = remoteEventContextTime(played + 5000, offset, anchor, 11, 60);
		expect(schedule.contextTime).toBeCloseTo(11.06, 9);
	});
});

describe('orderedRemoteTime', () => {
	it('keeps a player’s events in order and a note off after its note on', () => {
		const state = {held: new Map([[57, 5]]), lastTime: 5};
		expect(orderedRemoteTime({kind: 'bendOn', time: 0, semitones: 2}, 4.9, state)).toBe(5);
		expect(orderedRemoteTime({kind: 'noteOff', time: 0, note: 57}, 5.01, state)).toBeCloseTo(5.03, 9);
		expect(orderedRemoteTime({kind: 'noteOff', time: 0, note: 57}, 5.5, state)).toBe(5.5);
	});
});
