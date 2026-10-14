// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import {
	testOkeyGameView,
	testSummary,
	testUnknownGameView,
	testView,
	UNKNOWN_GAME,
} from '@app/features/table_game/state/TableGameTestViews';
import {TABLE_GAME_ENDED_TTL_S} from '@app/features/table_game/state/TableGameTiming';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {handleTableGameUpdate} = await import('@app/features/table_game/events/TableGameUpdate');

const CONTEXT = {} as GatewayHandlerContext;
const CHANNEL = '500';

function update(view: ReturnType<typeof testView>, channelId = CHANNEL): void {
	handleTableGameUpdate({channel_id: channelId, guild_id: '9', slot: view.summary.slot, view}, CONTEXT);
}

beforeEach(() => {
	TableGames.reset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('TableGames store', () => {
	it('stores summaries per channel', () => {
		TableGames.handleList('500', [testSummary({slot: 'T01'}), testSummary({slot: 'T02', game: 'chess'})]);
		TableGames.handleList('600', [testSummary({slot: 'T01', status: 'lobby'})]);
		expect(TableGames.getSummaries('500').map((s) => s.slot)).toEqual(['T01', 'T02']);
		expect(TableGames.getSummary('600', 'T01')?.status).toBe('lobby');
		expect(TableGames.getSummary('600', 'T02')).toBeNull();
		TableGames.handleList('500', [testSummary({slot: 'T02', game: 'chess'})]);
		expect(TableGames.getSummaries('500').map((s) => s.slot)).toEqual(['T02']);
		expect(TableGames.getSummaries('600')).toHaveLength(1);
	});

	it('TABLE_GAME_UPDATE replaces the view only when version increases', () => {
		update(testView({version: 4}));
		update(testView({version: 3, summary: {spectator_count: 9}}));
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.version).toBe(4);
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.spectator_count).toBe(0);
		update(testView({version: 4, summary: {spectator_count: 9}}));
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.spectator_count).toBe(0);
		update(testView({version: 5, summary: {spectator_count: 2}}));
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.spectator_count).toBe(2);
		expect(TableGames.getSummary(CHANNEL, 'T01')?.version).toBe(5);
	});

	it('takes a REST view of the same version (my own perspective) but never an older one', () => {
		update(testView({version: 4, spectating: false, viewerPosition: null}));
		expect(TableGames.handleView(CHANNEL, testView({version: 4, spectating: true, viewerPosition: null}), 'rest')).toBe(
			true,
		);
		expect(TableGames.getView(CHANNEL, 'T01')?.spectating).toBe(true);
		expect(TableGames.handleView(CHANNEL, testView({version: 3}), 'rest')).toBe(false);
	});

	it('accepts a new table in a slot whose previous table ended, even at a lower version', () => {
		update(testView({version: 40, status: 'ended'}));
		update(testView({version: 0, status: 'lobby'}));
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.status).toBe('lobby');
	});

	it('a late REST reply or list of the running game never undoes its end', () => {
		update(testView({version: 6, status: 'ended'}));
		expect(TableGames.handleView(CHANNEL, testView({version: 5, status: 'playing'}), 'rest')).toBe(false);
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.status).toBe('ended');
		TableGames.handleList(CHANNEL, [testSummary({version: 5, status: 'playing'})]);
		expect(TableGames.getSummary(CHANNEL, 'T01')?.status).toBe('ended');
	});

	it('a new table first seen past its lobby replaces a stale ended view', () => {
		vi.useFakeTimers({now: 0});
		update(testView({version: 6, status: 'ended'}));
		update(testView({version: 9, status: 'ended', summary: {slot: 'T02'}}));
		// A same-version REST read of the end does not restart its window: the key still expires 300 s after the end.
		vi.advanceTimersByTime(200_000);
		expect(TableGames.handleView(CHANNEL, testView({version: 6, status: 'ended'}), 'rest')).toBe(true);
		vi.advanceTimersByTime((TABLE_GAME_ENDED_TTL_S + 1) * 1000 - 200_000);
		update(testView({version: 1, status: 'playing'}));
		expect(TableGames.getView(CHANNEL, 'T01')?.summary).toMatchObject({status: 'playing', version: 1});
		TableGames.handleList(CHANNEL, [testSummary({slot: 'T02', version: 1, status: 'playing'})]);
		expect(TableGames.getSummary(CHANNEL, 'T02')).toMatchObject({status: 'playing', version: 1});
		expect(TableGames.handleView(CHANNEL, testView({version: 2, summary: {slot: 'T02'}}), 'event')).toBe(true);
	});

	it('within the ended window a late lower-version playing reply is still rejected', () => {
		vi.useFakeTimers({now: 0});
		update(testView({version: 6, status: 'ended'}));
		vi.advanceTimersByTime((TABLE_GAME_ENDED_TTL_S - 1) * 1000);
		expect(TableGames.handleView(CHANNEL, testView({version: 5, status: 'playing'}), 'rest')).toBe(false);
		TableGames.handleList(CHANNEL, [testSummary({version: 5, status: 'playing'})]);
		expect(TableGames.getSummary(CHANNEL, 'T01')?.status).toBe('ended');
	});

	it("once the list shows a new table's lobby, its later summaries win over the old table's end", () => {
		update(testView({version: 40, status: 'ended'}));
		TableGames.handleList(CHANNEL, [testSummary({version: 1, status: 'lobby'})]);
		expect(TableGames.getSummary(CHANNEL, 'T01')?.status).toBe('lobby');
		TableGames.handleList(CHANNEL, [testSummary({version: 4, status: 'playing'})]);
		expect(TableGames.getSummary(CHANNEL, 'T01')).toMatchObject({status: 'playing', version: 4});
	});

	it('a newer list summary wins over an older stored view for the slot summary', () => {
		update(testView({version: 2}));
		TableGames.handleList(CHANNEL, [testSummary({version: 7, status: 'ended'})]);
		expect(TableGames.getSummary(CHANNEL, 'T01')?.version).toBe(7);
		update(testView({version: 8}));
		expect(TableGames.getSummary(CHANNEL, 'T01')?.version).toBe(8);
	});

	it('keeps my local rack order across updates: a gone tile leaves its cell empty, a new tile goes after the last', () => {
		update(testView({version: 1, gameView: testOkeyGameView({rack: ['t1', 't2', 't3', 't4']})}));
		expect(TableGames.getRack(CHANNEL, 'T01')).toEqual(['t1', 't2', 't3', 't4']);
		TableGames.setRackOrder(CHANNEL, 'T01', ['t4', null, 't2', 't1', null, 't3']);
		expect(TableGames.getRack(CHANNEL, 'T01')).toEqual(['t4', null, 't2', 't1', null, 't3']);
		update(testView({version: 2, gameView: testOkeyGameView({rack: ['t1', 't3', 't4', 't9']})}));
		expect(TableGames.getRack(CHANNEL, 'T01')).toEqual(['t4', null, null, 't1', null, 't3', 't9']);
	});

	it('discarding keeps the other tiles in place', () => {
		const tiles = Array.from({length: 15}, (_, index) => `t${index}`);
		update(testView({version: 1, gameView: testOkeyGameView({rack: tiles})}));
		// 14 tiles fill the first row but its last cell; t14 starts the second row (cell 15).
		TableGames.setRackOrder(CHANNEL, 'T01', [...tiles.slice(0, 14), null, 't14']);
		update(testView({version: 2, gameView: testOkeyGameView({rack: tiles.filter((tile) => tile !== 't2')})}));
		expect(TableGames.getRack(CHANNEL, 'T01')).toEqual(['t0', 't1', null, ...tiles.slice(3, 14), null, 't14']);
	});

	it("a drawn tile takes the first empty cell when the rack's last cell holds a tile", () => {
		update(testView({version: 1, gameView: testOkeyGameView({rack: ['t0', 't1']})}));
		const order: Array<string | null> = Array.from({length: 30}, () => null);
		order[0] = 't0';
		order[29] = 't1';
		TableGames.setRackOrder(CHANNEL, 'T01', order);
		update(testView({version: 2, gameView: testOkeyGameView({rack: ['t0', 't1', 't9']})}));
		const rack = TableGames.getRack(CHANNEL, 'T01');
		expect(rack).toHaveLength(30);
		expect([rack[0], rack[1], rack[29]]).toEqual(['t0', 't9', 't1']);
	});

	it('ignores a rack order that is not a rearrangement of my rack', () => {
		update(testView({version: 1, gameView: testOkeyGameView({rack: ['t1', 't2']})}));
		TableGames.setRackOrder(CHANNEL, 'T01', ['t1', 't7']);
		TableGames.setRackOrder(CHANNEL, 'T01', ['t1', 't1', 't2']);
		TableGames.setRackOrder(CHANNEL, 'T01', ['t1']);
		expect(TableGames.getRack(CHANNEL, 'T01')).toEqual(['t1', 't2']);
	});

	it('has no rack when the view has none (spectator or chess)', () => {
		update(testView({version: 1, viewerPosition: null, spectating: true}));
		expect(TableGames.getRack(CHANNEL, 'T01')).toEqual([]);
	});

	it('panel request ids keep growing across a reset, so a later request is never mistaken for a handled one', () => {
		TableGames.requestPanel(CHANNEL, 'T01');
		const first = TableGames.panelRequest!.id;
		TableGames.reset();
		TableGames.requestPanel(CHANNEL, 'T01');
		expect(TableGames.panelRequest!.id).toBeGreaterThan(first);
	});

	it('finds the tables I play in a channel from views and list summaries', () => {
		TableGames.handleList(CHANNEL, [
			testSummary({slot: 'T01', status: 'playing'}),
			testSummary({slot: 'T02', status: 'ended'}),
			testSummary({
				slot: 'T03',
				status: 'lobby',
				players: [{position: 2, user_id: '777', connected: true, timeouts: 0}],
			}),
		]);
		update(testView({version: 9, summary: {slot: 'T04', status: 'lobby'}}));
		expect(TableGames.getMyActiveSlots(CHANNEL, '100')).toEqual(['T01', 'T04']);
		expect(TableGames.getMyActiveSlots('other', '100')).toEqual([]);
	});

	// Kept, not dropped: summary and version are the same for every kind, and the panel shows an update notice for it.
	it('a TABLE_GAME_UPDATE of an unknown game kind is kept as it came, with no rack, and never throws', () => {
		update(testView({version: 1, viewerPosition: 1, gameView: testOkeyGameView({rack: ['t0']})}));
		const unknown = testUnknownGameView('playing', {version: 2});
		expect(() => update(unknown)).not.toThrow();
		expect(TableGames.getView(CHANNEL, 'T01')).toEqual(unknown);
		expect(TableGames.getSummary(CHANNEL, 'T01')?.game).toBe(UNKNOWN_GAME);
		expect(TableGames.getRack(CHANNEL, 'T01')).toEqual([]);
		expect(TableGames.getMyActiveSlots(CHANNEL, '71')).toEqual(['T01']);
	});

	// A new kind may carry its own `rack` field of another shape; reconcileRack must never see it (a throw in a
	// gateway handler is a fatal session error).
	it('an unknown game kind with a non-array rack field never throws and yields no rack', () => {
		update(testView({version: 1, viewerPosition: 1, gameView: testOkeyGameView({rack: ['t0']})}));
		const unknown = testUnknownGameView('playing', {version: 2});
		(unknown.game_view as unknown as {rack: object}).rack = {};
		expect(() => update(unknown)).not.toThrow();
		expect(TableGames.getRack(CHANNEL, 'T01')).toEqual([]);
	});

	it('dama, dama_normal and tavla views carry no rack', () => {
		for (const [index, game] of (['dama', 'dama_normal', 'tavla'] as const).entries()) {
			update(testView({version: index * 2 + 1, viewerPosition: 1, gameView: testOkeyGameView({rack: ['t0']})}));
			expect(TableGames.getRack(CHANNEL, 'T01')).toEqual(['t0']);
			update(testView({game, version: index * 2 + 2, viewerPosition: 1}));
			expect(TableGames.getRack(CHANNEL, 'T01')).toEqual([]);
		}
	});
});
