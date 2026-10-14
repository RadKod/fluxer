// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {EventEmitter} from 'node:events';
import type {RoomLayout} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {SeatAssignment, SeatParticipant} from '@app/features/voice_scene/utils/SeatAssignment';
import {type Room, RoomEvent} from 'livekit-client';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({requestTableListRefresh: vi.fn()}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {useSeatAssignments} = await import('@app/features/voice_scene/hooks/useSeatAssignments');

const LAYOUT: RoomLayout = {
	seats: [
		{name: 'seat_A_01', group: 'A', position: {x: 1, y: 1, z: 0}, table: null, watch: null},
		{name: 'seat_T01_1', group: 'T01', position: {x: 4, y: 1, z: 0}, table: {slot: 'T01', position: 1}, watch: null},
		{name: 'seat_T01_Y1', group: 'T01', position: {x: 4, y: 1, z: 2}, table: null, watch: {slot: 'T01', index: 1}},
		{name: 'seat_T01_Y2', group: 'T01', position: {x: 5, y: 1, z: 2}, table: null, watch: {slot: 'T01', index: 2}},
	],
	stands: [{x: 10, y: 1, z: 0}],
	tables: [{slot: 'T01', center: {x: 4, y: 0.8, z: 1}, topSize: 1}],
	camTarget: {x: 0, y: 0, z: 0},
	camHome: {x: 0, y: 5, z: 8},
	screen: null,
	camPan: {x: 0, z: 0},
};

interface FakeParticipant {
	identity: string;
	attributes: Record<string, string>;
}

function fakeRoom(local: FakeParticipant, remotes: Array<FakeParticipant>) {
	const emitter = Object.assign(new EventEmitter(), {
		localParticipant: local,
		remoteParticipants: new Map(remotes.map((participant) => [participant.identity, participant])),
	});
	return emitter;
}

const PARTICIPANTS: Array<SeatParticipant> = [
	{userId: '1', connectionId: 'a'},
	{userId: '2', connectionId: 'b'},
];

let root: Root;
let latest: {assignment: SeatAssignment<SeatParticipant>; seatOf: ReadonlyMap<string, string>} | null = null;

function Probe({room}: {room: Room | null}): null {
	latest = useSeatAssignments({channelId: '500', room, layout: LAYOUT, participants: PARTICIPANTS});
	return null;
}

function render(room: ReturnType<typeof fakeRoom> | null): void {
	act(() => root.render(createElement(Probe, {room: room as unknown as Room | null})));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.mocked(TableGameCommands.requestTableListRefresh).mockClear();
	root = createRoot(document.createElement('div'));
	latest = null;
});

afterEach(() => {
	act(() => root.unmount());
});

describe('useSeatAssignments', () => {
	it('reads micup.seat of the local and remote participants', () => {
		render(
			fakeRoom({identity: 'user_1_a', attributes: {'micup.seat': 'seat_A_01'}}, [
				{identity: 'user_2_b', attributes: {}},
			]),
		);
		expect(latest?.seatOf).toEqual(new Map([['user_1_a', 'seat_A_01']]));
		expect(latest?.assignment.seated.get('seat_A_01')).toEqual(PARTICIPANTS[0]);
		expect(latest?.assignment.standing).toEqual([PARTICIPANTS[1]]);
	});

	it('follows ParticipantAttributesChanged, ParticipantConnected and ParticipantDisconnected', () => {
		const remote = {identity: 'user_2_b', attributes: {} as Record<string, string>};
		const room = fakeRoom({identity: 'user_1_a', attributes: {}}, []);
		render(room);
		expect(latest?.seatOf.size).toBe(0);
		act(() => {
			room.remoteParticipants.set(remote.identity, remote);
			room.emit(RoomEvent.ParticipantConnected, remote);
		});
		remote.attributes = {'micup.seat': 'seat_A_01'};
		act(() => {
			room.emit(RoomEvent.ParticipantAttributesChanged, {'micup.seat': 'seat_A_01'}, remote);
		});
		expect(latest?.assignment.seated.get('seat_A_01')).toEqual(PARTICIPANTS[1]);
		act(() => {
			room.remoteParticipants.delete(remote.identity);
			room.emit(RoomEvent.ParticipantDisconnected, remote);
		});
		expect(latest?.seatOf.size).toBe(0);
	});

	it('a table seat attribute change requests a table list refresh; a lounge change does not', () => {
		const remote = {identity: 'user_2_b', attributes: {} as Record<string, string>};
		const room = fakeRoom({identity: 'user_1_a', attributes: {}}, [remote]);
		render(room);
		remote.attributes = {'micup.seat': 'seat_A_01'};
		act(() => {
			room.emit(RoomEvent.ParticipantAttributesChanged, {'micup.seat': 'seat_A_01'}, remote);
		});
		expect(TableGameCommands.requestTableListRefresh).not.toHaveBeenCalled();
		remote.attributes = {'micup.seat': 'seat_T01_1'};
		act(() => {
			room.emit(RoomEvent.ParticipantAttributesChanged, {'micup.seat': 'seat_T01_1'}, remote);
		});
		expect(TableGameCommands.requestTableListRefresh).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.requestTableListRefresh).toHaveBeenLastCalledWith('500');
		// Leaving the table back to the lounge changes the table too.
		remote.attributes = {'micup.seat': 'seat_A_01'};
		act(() => {
			room.emit(RoomEvent.ParticipantAttributesChanged, {'micup.seat': 'seat_A_01'}, remote);
		});
		expect(TableGameCommands.requestTableListRefresh).toHaveBeenCalledTimes(2);
	});

	it('a watch seat change does not trigger the table list refresh', () => {
		// In a 10 000-person room every such move would be 10 000 list reads.
		const remote = {identity: 'user_2_b', attributes: {'micup.seat': 'seat_A_01'} as Record<string, string>};
		const room = fakeRoom({identity: 'user_1_a', attributes: {}}, [remote]);
		render(room);
		for (const seat of ['seat_T01_Y1', 'seat_T01_Y2', 'seat_A_01']) {
			remote.attributes = {'micup.seat': seat};
			act(() => {
				room.emit(RoomEvent.ParticipantAttributesChanged, {'micup.seat': seat}, remote);
			});
		}
		expect(latest?.assignment.seated.get('seat_A_01')).toEqual(PARTICIPANTS[1]);
		expect(TableGameCommands.requestTableListRefresh).not.toHaveBeenCalled();
	});

	it('a player at a table leaving the call refreshes the table list', () => {
		const remote = {identity: 'user_2_b', attributes: {'micup.seat': 'seat_T01_1'} as Record<string, string>};
		const room = fakeRoom({identity: 'user_1_a', attributes: {}}, [remote]);
		render(room);
		act(() => {
			room.remoteParticipants.delete(remote.identity);
			room.emit(RoomEvent.ParticipantDisconnected, remote);
		});
		expect(TableGameCommands.requestTableListRefresh).toHaveBeenCalledTimes(1);
	});

	it('unmount removes every room listener', () => {
		const room = fakeRoom({identity: 'user_1_a', attributes: {}}, []);
		render(room);
		act(() => root.unmount());
		root = createRoot(document.createElement('div'));
		expect(room.eventNames()).toEqual([]);
	});

	it('no room → everyone stands', () => {
		render(null);
		expect(latest?.assignment.standing).toEqual(PARTICIPANTS);
	});
});
