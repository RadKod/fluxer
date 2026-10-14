// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {Logger} from '@app/api/Logger';
import type {ClassicOkeyState} from '@app/api/table_game/engine/okey/ClassicOkey';
import type {Okey101State} from '@app/api/table_game/engine/okey/Okey101';
import {greedyOkey101Agent} from '@app/api/table_game/engine/okey/tests/Okey101Agents';
import type {TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {deckTokensOf, type OkeyTiles, rackTokensOf, tokensIn} from '@app/api/table_game/engine/tests/EngineInvariants';
import {randomOkeyAgent} from '@app/api/table_game/engine/tests/OkeyAgents';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {TABLE_GAME_ENGINES} from '@app/api/table_game/TableGameEngines';
import {CHANNEL, cid, conn, createFixture, PLAYERS, SLOT, uid} from '@app/api/table_game/tests/TableGameTestFixture';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {okeyTileToken} from '@fluxer/constants/src/TableGameConstants';
import {
	type TableGameAction,
	TableGameUpdateEvent,
	TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {afterEach, describe, expect, it, vi} from 'vitest';

const CLASSIC_GAMES = 300;
const OKEY101_GAMES = 200;
const SPECTATORS = ['201', '202'];
const STEP_MS = 1_000;
const MAX_STEPS = 2_000;
const START = Date.parse('2026-10-03T12:00:00.000Z');

type Viewer = TablePosition | null;
const rackOf = (view: TableGameView) => (view.game_view as {rack?: Array<string> | null} | null)?.rack ?? null;
const totals = {steps: 0, results: {} as Record<string, number>};

// Tokens the viewer must never see in the state right after the step: other players' racks and the deck.
function forbiddenFor(state: OkeyTiles, viewer: Viewer): Set<string> {
	const hidden = new Set(deckTokensOf(state));
	for (const position of [1, 2, 3, 4] as const) {
		if (position !== viewer) for (const token of rackTokensOf(state, position)) hidden.add(token);
	}
	return hidden;
}

function expectNoLeak(text: string, state: OkeyTiles, viewer: Viewer, where: string) {
	const seen = tokensIn(text);
	for (const token of forbiddenFor(state, viewer)) {
		if (seen.has(token)) throw new Error(`${where}: ${token} reached viewer ${viewer ?? 'spectator'}`);
	}
}

describe('Ş10 table game leak (service layer)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	async function playThroughService(game: 'okey' | 'okey101', seed: number) {
		vi.setSystemTime(START);
		const seeded = new SeededRng(seed);
		vi.spyOn(crypto, 'randomInt').mockImplementation(((max: number) => seeded.int(max)) as never);
		const logger = Logger.child({}) as NoopLogger;
		const logs = [vi.spyOn(logger, 'debug'), vi.spyOn(logger, 'info'), vi.spyOn(logger, 'warn')];
		const f = createFixture(TABLE_GAME_ENGINES);
		await f.fill(game);
		for (const spectator of SPECTATORS) {
			f.joinVoice(spectator);
			const watch = await f.service.spectate({
				userId: uid(spectator),
				channelId: cid(CHANNEL),
				slot: SLOT,
				connectionId: conn(spectator),
			});
			expect(rackOf(watch.view)).toBeNull();
		}
		const agent = (state: unknown, actor: TablePosition): TableGameAction =>
			game === 'okey'
				? randomOkeyAgent(state as ClassicOkeyState, actor)
				: greedyOkey101Agent(state as Okey101State, actor);
		const checkOutgoing = async (from: number, response: unknown, responder: Viewer, error: unknown) => {
			const env = (await f.load())!;
			const state = env.engine as OkeyTiles;
			for (const sent of f.dispatches.slice(from)) {
				const event = TableGameUpdateEvent.parse(sent.event);
				const position = env.players.find((p) => p.user_id === sent.userId)?.position ?? null;
				if (position === null) expect(rackOf(event.view)).toBeNull();
				expectNoLeak(JSON.stringify(event), state, position, `event to ${sent.userId}`);
			}
			if (response !== undefined)
				expectNoLeak(JSON.stringify(TableGameView.parse(response)), state, responder, 'response');
			if (error !== undefined) {
				const body = error as {code?: unknown; message?: unknown; data?: unknown};
				expectNoLeak(JSON.stringify({code: body.code, message: body.message, data: body.data}), state, null, 'error');
			}
			for (const spy of logs) expectNoLeak(JSON.stringify(spy.mock.calls), state, null, 'log');
			return env;
		};
		let env = await checkOutgoing(0, undefined, null, undefined);
		for (let step = 0; env.status === 'playing'; step++) {
			if (step >= MAX_STEPS) throw new Error(`seed ${seed}: no end within ${MAX_STEPS} steps`);
			const actor = (env.engine as {turn: TablePosition}).turn;
			const action = agent(env.engine, actor);
			vi.setSystemTime(Date.now() + STEP_MS);
			if (action.type === 'tick') {
				const deadline = TABLE_GAME_ENGINES[game].deadline(env.engine) ?? Date.now();
				vi.setSystemTime(Math.max(Date.now(), deadline));
			}
			const from = f.dispatches.length;
			let response: unknown;
			let error: unknown;
			try {
				response = await f.service.act({
					userId: uid(PLAYERS[actor - 1]!),
					channelId: cid(CHANNEL),
					slot: SLOT,
					version: env.version,
					action,
				});
			} catch (caught) {
				error = caught;
			}
			env = await checkOutgoing(from, response, actor, error);
			// A spectator's own read goes through the same view path.
			const read = await f.service.get({
				userId: uid(SPECTATORS[0]!),
				channelId: cid(CHANNEL),
				slot: SLOT,
				connectionId: conn(SPECTATORS[0]!),
			});
			expectNoLeak(JSON.stringify(TableGameView.parse(read.body)), env.engine as OkeyTiles, null, 'spectator read');
		}
		expect(env.status).toBe('ended');
		totals.steps += f.dispatches.length;
		totals.results[env.result!.kind] = (totals.results[env.result!.kind] ?? 0) + 1;
		vi.restoreAllMocks();
	}

	it(`${CLASSIC_GAMES} classic and ${OKEY101_GAMES} 101 games: no rack or deck token in any event, response, log or error`, async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const started = performance.now();
		for (let seed = 1; seed <= CLASSIC_GAMES; seed++) await playThroughService('okey', seed);
		for (let seed = 1; seed <= OKEY101_GAMES; seed++) await playThroughService('okey101', seed);
		console.info(
			`table game leak test: ${Math.round(performance.now() - started)} ms, ${totals.steps} events`,
			totals.results,
		);
	}, 600_000);

	// a watch seat is a seat, nothing more: the table service only knows players and spectators.
	it('watch-seat holder gets rack null on GET, event and spectate', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(START);
		const seeded = new SeededRng(7);
		vi.spyOn(crypto, 'randomInt').mockImplementation(((max: number) => seeded.int(max)) as never);
		const f = createFixture(TABLE_GAME_ENGINES);
		const env = await f.fill('okey');
		const watcher = SPECTATORS[0]!;
		const me = {userId: uid(watcher), channelId: cid(CHANNEL), slot: SLOT, connectionId: conn(watcher)};
		f.joinVoice(watcher);
		const spectated = await f.service.spectate(me);
		expect(rackOf(spectated.view)).toBeNull();
		const read = async () => TableGameView.parse((await f.service.get(me)).body);
		const before = await read();

		const seats = `{voice_seats:${CHANNEL}}`;
		await f.kv.hset(seats, `s:seat_${SLOT}_Y1`, conn(watcher));
		await f.kv.hset(seats, `p:${conn(watcher)}`, `seat_${SLOT}_Y1`);
		await f.kv.hset(seats, `u:${watcher}`, conn(watcher));
		const seated = await read();
		expect(seated).toEqual(before);
		expect(seated.viewer_position).toBeNull();
		expect(rackOf(seated)).toBeNull();

		const state = env.engine as ClassicOkeyState;
		const from = f.dispatches.length;
		await f.service.act({
			userId: uid(PLAYERS[state.turn - 1]!),
			channelId: cid(CHANNEL),
			slot: SLOT,
			version: env.version,
			action: {type: 'discard', tile: okeyTileToken(state.racks[state.turn - 1]![0]!)},
		});
		const events = f.dispatches.slice(from).filter((sent) => sent.userId === watcher);
		expect(events).toHaveLength(1);
		const event = TableGameUpdateEvent.parse(events[0]!.event);
		expect(event.view.viewer_position).toBeNull();
		expect(rackOf(event.view)).toBeNull();
		expectNoLeak(JSON.stringify(event), (await f.load())!.engine as OkeyTiles, null, 'event to the watch seat');

		const again = await f.service.spectate(me);
		expect(again.view.viewer_position).toBeNull();
		expect(rackOf(again.view)).toBeNull();
	});
});
