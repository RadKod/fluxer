// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandState} from '@app/features/activities/band/BandProtocol';
import {
	moveInGrid,
	myVoteSongId,
	pickGridColumns,
	voteAction,
	votePanel,
} from '@app/features/activities/band/flow/BandPickModel';
import {describe, expect, it} from 'vitest';

type PickState = Extract<BandState, {phase: 'pick'}>;

function pick(votes: PickState['votes'], endsAt: number | null): PickState {
	return {phase: 'pick', suggestions: [], votes, openedAt: 0, endsAt};
}

describe('votePanel', () => {
	it('waits while nobody has voted', () => {
		expect(votePanel(pick([], null), 'me', true, 1_000)).toEqual({kind: 'waiting'});
	});

	it('lists voted songs by count with the leader and my vote marked', () => {
		const state = pick(
			[
				{userId: 'selim', songId: 'du-hast'},
				{userId: 'me', songId: 'bohemian'},
				{userId: 'esber', songId: 'bohemian'},
			],
			6_000,
		);
		expect(votePanel(state, 'me', false, 2_000)).toEqual({
			kind: 'counting',
			secondsLeft: 4,
			remaining: 4_000 / 6_000,
			rows: [
				{songId: 'bohemian', voterIds: ['me', 'esber'], leading: true, mine: true},
				{songId: 'du-hast', voterIds: ['selim'], leading: false, mine: false},
			],
			canPlayNow: false,
		});
	});

	it('offers play now to the leader only and never counts below zero', () => {
		const panel = votePanel(pick([{userId: 'selim', songId: 'a'}], 6_000), 'me', true, 9_000);
		expect(panel).toMatchObject({kind: 'counting', secondsLeft: 0, remaining: 0, canPlayNow: true});
	});
});

describe('voteAction', () => {
	const votes = [{userId: 'me', songId: 'a'}];

	it('takes back my vote on my own song and votes anywhere else', () => {
		expect(myVoteSongId(votes, 'me')).toBe('a');
		expect(myVoteSongId(votes, 'selim')).toBeNull();
		expect(voteAction('a', votes, 'me')).toBe('unvote');
		expect(voteAction('b', votes, 'me')).toBe('vote');
		expect(voteAction('a', votes, 'selim')).toBe('vote');
	});
});

describe('pickGridColumns', () => {
	it('fits four cards beside the rail and panel of a 1440 px stage, fewer when narrow', () => {
		expect(pickGridColumns(772)).toBe(4);
		expect(pickGridColumns(560)).toBe(3);
		expect(pickGridColumns(300)).toBe(2);
		expect(pickGridColumns(2_000)).toBe(6);
	});
});

describe('moveInGrid', () => {
	it('moves by one across and by a row up and down, stopping at the edges', () => {
		expect(moveInGrid(0, 'ArrowRight', 4, 10)).toBe(1);
		expect(moveInGrid(0, 'ArrowLeft', 4, 10)).toBe(0);
		expect(moveInGrid(1, 'ArrowDown', 4, 10)).toBe(5);
		expect(moveInGrid(5, 'ArrowDown', 4, 10)).toBe(9);
		expect(moveInGrid(6, 'ArrowDown', 4, 10)).toBe(6);
		expect(moveInGrid(5, 'ArrowUp', 4, 10)).toBe(1);
		expect(moveInGrid(2, 'ArrowUp', 4, 10)).toBe(2);
		expect(moveInGrid(3, 'End', 4, 10)).toBe(9);
		expect(moveInGrid(7, 'Home', 4, 10)).toBe(0);
		expect(moveInGrid(42, 'ArrowLeft', 4, 10)).toBe(8);
		expect(moveInGrid(0, 'ArrowDown', 4, 0)).toBe(0);
	});
});
