// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandIntent, BandState} from '@app/features/activities/band/BandProtocol';
import {followBandStartMode} from '@app/features/activities/band/flow/BandStartMode';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import VoiceActivities, {START_MODE_TTL_MS} from '@app/features/activities/state/VoiceActivities';
import {observable, runInAction} from 'mobx';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

interface Room {
	isLeader: boolean;
	stateSettled: boolean;
	phase: BandState['phase'] | null;
}

let room: Room;
let sent: Array<BandIntent>;
let now: number;
let stop: () => void;

function follow(): void {
	const session = {
		sessionId: 's1',
		get isLeader() {
			return room.isLeader;
		},
		get stateSettled() {
			return room.stateSettled;
		},
	} as unknown as ActivitySession;
	stop = followBandStartMode(
		session,
		() => room.phase,
		(sessionId) => VoiceActivities.takeStartMode(sessionId, now),
		(intent) => sent.push(intent),
	);
}

function update(patch: Partial<Room>): void {
	runInAction(() => Object.assign(room, patch));
}

beforeEach(() => {
	VoiceActivities.reset();
	room = observable({isLeader: true, stateSettled: false, phase: null});
	sent = [];
	now = 1_000;
});

afterEach(() => stop());

describe('followBandStartMode', () => {
	it('opens the room in jam once I lead the settled first pick', () => {
		VoiceActivities.setStartMode('s1', 'jam', now);
		follow();
		expect(sent).toEqual([]);
		update({stateSettled: true});
		expect(sent).toEqual([]);
		update({phase: 'pick'});
		expect(sent).toEqual([{t: 'band.jamStart'}]);
		update({phase: 'jam'});
		update({phase: 'pick'});
		expect(sent).toEqual([{t: 'band.jamStart'}]);
	});

	it('never sends while someone else leads', () => {
		VoiceActivities.setStartMode('s1', 'jam', now);
		update({isLeader: false, stateSettled: true, phase: 'pick'});
		follow();
		expect(sent).toEqual([]);
	});

	it('never sends from a room that is past the pick', () => {
		VoiceActivities.setStartMode('s1', 'jam', now);
		update({stateSettled: true, phase: 'select'});
		follow();
		update({phase: 'play'});
		expect(sent).toEqual([]);
	});

	it('lets an expired hint go', () => {
		VoiceActivities.setStartMode('s1', 'jam', now);
		follow();
		now += START_MODE_TTL_MS;
		update({stateSettled: true, phase: 'pick'});
		expect(sent).toEqual([]);
	});

	it('leaves a room started from the songs card alone', () => {
		update({stateSettled: true, phase: 'pick'});
		follow();
		expect(sent).toEqual([]);
	});
});
