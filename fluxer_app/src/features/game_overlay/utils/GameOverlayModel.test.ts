// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	computeGameOverlaySize,
	getGameOverlayMicState,
	selectGameOverlayEntries,
} from '@app/features/game_overlay/utils/GameOverlayModel';
import {describe, expect, it} from 'vitest';

interface TestEntry {
	userId: string;
	connectionId: string;
	speaking: boolean;
}

function entry(userId: string, speaking: boolean, connectionId = `${userId}-c`): TestEntry {
	return {userId, connectionId, speaking};
}

function many(count: number, speaking: boolean): Array<TestEntry> {
	return Array.from({length: count}, (_, index) => entry(`u${index}`, speaking));
}

describe('selectGameOverlayEntries', () => {
	it('merges connections of the same user into the speaking connection, in the first connection place', () => {
		const result = selectGameOverlayEntries(
			[entry('a', false, 'a1'), entry('b', false), entry('a', true, 'a2')],
			'room',
		);
		expect(result.shown.map((item) => [item.userId, item.connectionId, item.speaking])).toEqual([
			['a', 'a2', true],
			['b', 'b-c', false],
		]);
		expect(result.overflow).toBe(0);
	});

	it('takes the mic state of the speaking connection, as the in-app avatar stack does', () => {
		const muted = {...entry('a', false, 'a1'), selfMute: true, selfDeaf: true};
		const open = {...entry('a', true, 'a2'), selfMute: false, selfDeaf: false};
		const [shown] = selectGameOverlayEntries([muted, open], 'room').shown;
		expect(shown).toBe(open);
		expect(getGameOverlayMicState(shown)).toBe('on');
	});

	it('shows only speaking users in speaking mode', () => {
		const result = selectGameOverlayEntries([entry('a', false), entry('b', true), entry('c', true)], 'speaking');
		expect(result.shown.map((item) => item.userId)).toEqual(['b', 'c']);
	});

	it('shows nothing in speaking mode when nobody speaks', () => {
		expect(selectGameOverlayEntries([entry('a', false), entry('b', false)], 'speaking')).toEqual({
			shown: [],
			overflow: 0,
		});
	});

	it('caps speaking mode at 6 and reports the rest as overflow', () => {
		const result = selectGameOverlayEntries(many(9, true), 'speaking');
		expect(result.shown).toHaveLength(6);
		expect(result.overflow).toBe(3);
	});

	it('caps room mode at 15 and reports the rest as overflow', () => {
		const result = selectGameOverlayEntries(many(20, false), 'room');
		expect(result.shown).toHaveLength(15);
		expect(result.overflow).toBe(5);
	});

	it('keeps silent users in room mode and preserves input order', () => {
		const result = selectGameOverlayEntries([entry('c', false), entry('a', true), entry('b', false)], 'room');
		expect(result.shown.map((item) => item.userId)).toEqual(['c', 'a', 'b']);
	});

	it('is deterministic for the same input', () => {
		const input = [entry('a', true), entry('b', false), entry('a', false, 'a2')];
		expect(selectGameOverlayEntries(input, 'room')).toEqual(selectGameOverlayEntries(input, 'room'));
		expect(selectGameOverlayEntries(input, 'speaking')).toEqual(selectGameOverlayEntries(input, 'speaking'));
	});
});

describe('computeGameOverlaySize', () => {
	it('sizes speaking mode as a 40 px column of 34 px steps', () => {
		expect(computeGameOverlaySize('speaking', 1, 0)).toEqual({width: 40, height: 40});
		expect(computeGameOverlaySize('speaking', 6, 0)).toEqual({width: 40, height: 210});
		expect(computeGameOverlaySize('speaking', 6, 3)).toEqual({width: 40, height: 244});
	});

	it('sizes room mode as 154 px wide rows of 28 px with 6 px padding', () => {
		expect(computeGameOverlaySize('room', 1, 0)).toEqual({width: 154, height: 40});
		expect(computeGameOverlaySize('room', 15, 0)).toEqual({width: 154, height: 432});
		expect(computeGameOverlaySize('room', 15, 5)).toEqual({width: 154, height: 460});
	});
});

describe('getGameOverlayMicState', () => {
	it('shows deafened over muted, muted over an open mic', () => {
		expect(getGameOverlayMicState({selfMute: false, selfDeaf: false})).toBe('on');
		expect(getGameOverlayMicState({selfMute: true, selfDeaf: false})).toBe('muted');
		expect(getGameOverlayMicState({selfMute: true, selfDeaf: true})).toBe('deafened');
		expect(getGameOverlayMicState({selfMute: false, selfDeaf: true})).toBe('deafened');
	});
});
