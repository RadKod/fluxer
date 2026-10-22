// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandIntent, BandState} from '@app/features/activities/band/BandProtocol';
import {BAND_JAM_BACKING_LEAD_MS, type BandJamState} from '@app/features/activities/band/flow/BandJamMachine';
import {
	type BandRoomContext,
	createBandRoomState,
	isBandState,
	parseBandIntent,
	reduceBandIntent,
	tickBandRoom,
} from '@app/features/activities/band/flow/BandRoomMachine';
import {JAM_BACKING_PATTERNS} from '@app/features/activities/band/jam/JamBacking';
import {describe, expect, it} from 'vitest';

const NOW = 1_000_000;

function context(overrides: Partial<BandRoomContext> = {}): BandRoomContext {
	return {leaderId: 'lead', presentUserIds: new Set(['lead', 'u1', 'u2']), songs: new Map(), ...overrides};
}

function reduce(state: BandState, intent: BandIntent, from = 'lead', now = NOW, ctx = context()): BandState {
	return reduceBandIntent(state, intent, from, now, ctx);
}

function jam(): BandJamState {
	const state = reduce(createBandRoomState(NOW, context()), {t: 'band.jamStart'});
	if (state.phase !== 'jam') throw new Error('expected jam');
	return state;
}

describe('jam mode in the band room', () => {
	it('opens from the song picker for the leader only, in A minor pentatonic over the rock loop', () => {
		const pick = createBandRoomState(NOW, context());
		expect(reduce(pick, {t: 'band.jamStart'}, 'u1')).toBe(pick);
		const state = jam();
		expect(state).toMatchObject({
			phase: 'jam',
			key: 9,
			scale: 'minorPentatonic',
			backing: {style: 'rock', bpm: JAM_BACKING_PATTERNS.rock.bpm, on: true, since: NOW + BAND_JAM_BACKING_LEAD_MS},
			seats: [],
		});
	});

	it('does not open jam mode from the middle of a song round', () => {
		const pick = createBandRoomState(NOW, context());
		const select: BandState = {
			phase: 'select',
			songId: 'a',
			groupDifficulty: 'medium',
			seats: [],
			watching: [],
			endsAt: NOW + 10_000,
		};
		expect(reduce(select, {t: 'band.jamStart'})).toBe(select);
		expect(reduce(pick, {t: 'band.jamEnd'})).toBe(pick);
	});

	it('goes back to picking a song when the leader ends it or skips', () => {
		const state = jam();
		expect(reduce(state, {t: 'band.jamEnd'}, 'u1')).toBe(state);
		expect(reduce(state, {t: 'band.jamEnd'}).phase).toBe('pick');
		expect(reduce(state, {t: 'band.skip'}).phase).toBe('pick');
	});

	it('lets only the leader change the key, scale and backing', () => {
		const state = jam();
		expect(reduce(state, {t: 'band.jamSettings', key: 4}, 'u1')).toBe(state);
		const next = reduce(state, {t: 'band.jamSettings', key: 4, scale: 'blues'}, 'lead', NOW + 5_000);
		expect(next).toMatchObject({key: 4, scale: 'blues'});
		// The loop keeps its timeline through a key change.
		expect((next as BandJamState).backing.since).toBe(state.backing.since);
		expect(reduce(next, {t: 'band.jamSettings', key: 4})).toBe(next);
	});

	it('restarts the loop on a new style, tempo or switching it back on, with the style bringing its tempo', () => {
		const state = jam();
		const later = NOW + 30_000;
		const blues = reduce(state, {t: 'band.jamSettings', style: 'slowBlues'}, 'lead', later) as BandJamState;
		expect(blues.backing).toEqual({
			style: 'slowBlues',
			bpm: JAM_BACKING_PATTERNS.slowBlues.bpm,
			on: true,
			since: later + BAND_JAM_BACKING_LEAD_MS,
		});
		const off = reduce(blues, {t: 'band.jamSettings', backing: false}, 'lead', later + 1) as BandJamState;
		expect(off.backing).toMatchObject({on: false, since: blues.backing.since});
		const on = reduce(off, {t: 'band.jamSettings', backing: true}, 'lead', later + 2) as BandJamState;
		expect(on.backing.since).toBe(later + 2 + BAND_JAM_BACKING_LEAD_MS);
	});

	it('keeps the tempo within range', () => {
		const state = jam();
		expect((reduce(state, {t: 'band.jamSettings', bpm: 999}) as BandJamState).backing.bpm).toBe(220);
		expect((reduce(state, {t: 'band.jamSettings', bpm: 3}) as BandJamState).backing.bpm).toBe(50);
		expect((reduce(state, {t: 'band.jamSettings', bpm: 112.6}) as BandJamState).backing.bpm).toBe(113);
	});

	it('lets anyone present pick, change, share and put down an instrument', () => {
		let state: BandState = jam();
		state = reduce(state, {t: 'band.jamInstrument', instrument: 'guitar'}, 'u1');
		state = reduce(state, {t: 'band.jamInstrument', instrument: 'guitar'}, 'u2');
		expect((state as BandJamState).seats).toEqual([
			{userId: 'u1', instrument: 'guitar'},
			{userId: 'u2', instrument: 'guitar'},
		]);
		const same = reduce(state, {t: 'band.jamInstrument', instrument: 'guitar'}, 'u1');
		expect(same).toBe(state);
		state = reduce(state, {t: 'band.jamInstrument', instrument: 'drums'}, 'u1');
		state = reduce(state, {t: 'band.jamInstrument', instrument: null}, 'u2');
		expect((state as BandJamState).seats).toEqual([{userId: 'u1', instrument: 'drums'}]);
		expect(reduce(state, {t: 'band.jamInstrument', instrument: 'bass'}, 'stranger')).toBe(state);
	});

	it('ignores song-round intents while jamming', () => {
		const state = jam();
		expect(reduce(state, {t: 'band.vote', songId: 'a'})).toBe(state);
		expect(reduce(state, {t: 'band.claimSeat', part: 'guitar'})).toBe(state);
		expect(reduce(state, {t: 'band.ready', ready: true})).toBe(state);
	});

	it('drops the seats of people who left on the tick and otherwise keeps the state', () => {
		let state: BandState = jam();
		state = reduce(state, {t: 'band.jamInstrument', instrument: 'keys'}, 'u1');
		state = reduce(state, {t: 'band.jamInstrument', instrument: 'bass'}, 'u2');
		expect(tickBandRoom(state, NOW + 1, context())).toBe(state);
		const ticked = tickBandRoom(state, NOW + 1, context({presentUserIds: new Set(['lead', 'u2'])}));
		expect((ticked as BandJamState).seats).toEqual([{userId: 'u2', instrument: 'bass'}]);
	});

	it('takes a jam state as a room state, so a new leader continues the jam', () => {
		expect(isBandState(jam())).toBe(true);
		expect(isBandState({phase: 'karaoke'})).toBe(false);
	});
});

describe('jam intents on the wire', () => {
	it('parses the jam intents', () => {
		expect(parseBandIntent({t: 'band.jamStart'})).toEqual({t: 'band.jamStart'});
		expect(parseBandIntent({t: 'band.jamEnd', extra: 1})).toEqual({t: 'band.jamEnd'});
		expect(parseBandIntent({t: 'band.jamInstrument', instrument: 'rhythm'})).toEqual({
			t: 'band.jamInstrument',
			instrument: 'rhythm',
		});
		expect(parseBandIntent({t: 'band.jamInstrument', instrument: null})).toEqual({
			t: 'band.jamInstrument',
			instrument: null,
		});
		expect(parseBandIntent({t: 'band.jamSettings', key: 2, style: 'punk', backing: false})).toEqual({
			t: 'band.jamSettings',
			key: 2,
			style: 'punk',
			backing: false,
		});
	});

	it('drops malformed jam intents whole', () => {
		expect(parseBandIntent({t: 'band.jamInstrument', instrument: 'vocals'})).toBeNull();
		expect(parseBandIntent({t: 'band.jamInstrument'})).toBeNull();
		expect(parseBandIntent({t: 'band.jamSettings', key: 12})).toBeNull();
		expect(parseBandIntent({t: 'band.jamSettings', key: 2, scale: 'dorian'})).toBeNull();
		expect(parseBandIntent({t: 'band.jamSettings', style: 'polka'})).toBeNull();
		expect(parseBandIntent({t: 'band.jamSettings', bpm: Number.NaN})).toBeNull();
		expect(parseBandIntent({t: 'band.jamSettings', backing: 'yes'})).toBeNull();
		expect(parseBandIntent({t: 'band.jamSettings', scale: 'toString'})).toBeNull();
	});

	it('is not mistaken for a jam note message, which the leader drops', () => {
		expect(parseBandIntent({t: 'band.jam', e: [0, 1, 60, 100, 0]})).toBeNull();
	});
});
