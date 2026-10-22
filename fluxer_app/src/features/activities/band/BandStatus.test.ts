// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

const {bandSongPlaying, describeBandState, describeMyBandPart} = await import(
	'@app/features/activities/band/BandStatus'
);

const i18n = {
	_: (descriptor: MessageDescriptor, values: Record<string, unknown> = {}) =>
		(descriptor.message ?? '').replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])),
} as unknown as I18n;

function session(state: unknown): ActivitySession {
	return {state} as ActivitySession;
}

describe('band status', () => {
	it('puts the game in the call tile only while a song plays or the band jams', () => {
		expect(bandSongPlaying(session({phase: 'play', songId: 'a', seats: [], startAt: 0}))).toBe(true);
		expect(bandSongPlaying(session({phase: 'jam', seats: []}))).toBe(true);
		for (const phase of ['pick', 'select', 'results']) expect(bandSongPlaying(session({phase}))).toBe(false);
		expect(bandSongPlaying(session(null))).toBe(false);
	});

	it('counts the ready seats while parts are chosen', () => {
		const seats = [
			{part: 'guitar', userId: '1', difficulty: 'easy', ready: true},
			{part: 'bass', userId: '2', difficulty: 'easy', ready: false},
			{part: 'drums', userId: '3', difficulty: 'easy', ready: true},
		];
		expect(describeBandState(session({phase: 'select', songId: 'a', seats}), i18n)).toBe('Choosing parts · 2/3 ready');
		expect(describeBandState(session({phase: 'select', songId: 'a', seats: []}), i18n)).toBe('Choosing parts');
	});

	it('says a vote is on before anyone has a title to show', () => {
		expect(describeBandState(session({phase: 'pick', votes: []}), i18n)).toBe('Picking a song');
		expect(describeBandState(session({phase: 'pick', votes: [{userId: '1', songId: 'x'}]}), i18n)).toBe(
			'Voting on a song',
		);
	});

	it('tells the call the band is jamming and names my jam instrument in the mini window', () => {
		expect(describeBandState(session({phase: 'jam', seats: []}), i18n)).toBe('Jamming');
		const mine = {
			state: {phase: 'jam', seats: [{userId: 'me', instrument: 'drums'}]},
			me: {userId: 'me'},
		} as unknown as ActivitySession;
		expect(describeMyBandPart(mine, i18n)).toBe('Drums · jam');
		const listening = {state: {phase: 'jam', seats: []}, me: {userId: 'me'}} as unknown as ActivitySession;
		expect(describeMyBandPart(listening, i18n)).toBeNull();
	});
});
