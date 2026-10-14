// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {damaSearchedNodes} from '@app/api/table_game/engine/dama/DamaCore';
import {tavlaGenerations} from '@app/api/table_game/engine/tavla/Tavla';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {TABLE_GAME_ENGINES} from '@app/api/table_game/TableGameEngines';
import {TABLE_GAME_TTL_S} from '@app/api/table_game/TableGameLimits';
import {
	CHANNEL,
	cid,
	conn,
	createFixture,
	type FakeState,
	type Fixture,
	PLAYERS,
	SLOT,
	uid,
} from '@app/api/table_game/tests/TableGameTestFixture';
import {TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import {TableGameConflictError} from '@fluxer/errors/src/domains/voice/TableGameConflictError';
import {TableGameRuleViolationError} from '@fluxer/errors/src/domains/voice/TableGameRuleViolationError';
import {
	type DamaView,
	type TableGameAction,
	TableGameView,
	type TavlaView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const START = Date.parse('2026-10-03T12:00:00.000Z');
const [A, B] = PLAYERS;
const NEW_KINDS = ['dama', 'dama_normal', 'tavla'] as const;
type NewKind = (typeof NEW_KINDS)[number];

const at = (ms: number) => vi.setSystemTime(START + ms);
const ref = (userId: string) => ({userId: uid(userId), channelId: cid(CHANNEL), slot: SLOT});

// Two players at 1 and 3; the engines roll through node:crypto, seeded here so a run replays.
async function seatTwo(f: Fixture, game: NewKind | 'okey'): Promise<TableGameView> {
	f.joinVoice(A);
	f.joinVoice(B);
	await f.service.create({...ref(A), game, speed: 'normal', connectionId: conn(A)});
	return await f.service.join({...ref(B), position: 3, connectionId: conn(B)});
}

const userAt = (position: number) => (position === 1 ? A : B);

async function read(f: Fixture, userId: string): Promise<TableGameView> {
	return TableGameView.parse((await f.service.get({...ref(userId), connectionId: conn(userId)})).body);
}

describe('table games: dama, dama_normal and tavla through the service', () => {
	beforeEach(() => {
		vi.useFakeTimers({toFake: ['Date']});
		at(0);
		const seeded = new SeededRng(42);
		vi.spyOn(crypto, 'randomInt').mockImplementation(((max: number) => seeded.int(max)) as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('dama, dama_normal and tavla tables sit at 1 and 3 and start when full', async () => {
		for (const game of NEW_KINDS) {
			const f = createFixture(TABLE_GAME_ENGINES);
			f.joinVoice(A);
			f.joinVoice(B);
			const lobby = await f.service.create({...ref(A), game, speed: 'normal', connectionId: conn(A)});
			expect(lobby.summary).toMatchObject({game, status: 'lobby', players: [{position: 1, user_id: A}]});
			for (const position of [2, 4]) {
				await expect(f.service.join({...ref(B), position, connectionId: conn(B)})).rejects.toBeInstanceOf(
					TableGameConflictError,
				);
			}
			const started = TableGameView.parse(await f.service.join({...ref(B), position: 3, connectionId: conn(B)}));
			expect(started.summary).toMatchObject({game, status: 'playing'});
			expect(started.summary.players.map((player) => player.position)).toEqual([1, 3]);
			expect(started.game_view?.game).toBe(game);
			const turn = (started.game_view as DamaView | TavlaView).turn!;
			expect((await read(f, userAt(turn))).game_view).toMatchObject({legal_moves: expect.any(Array)});
			expect((await read(f, userAt(turn === 1 ? 3 : 1))).game_view).toMatchObject({legal_moves: null});
		}
	});

	it('tavla timeout goes through the timer path and counts timeouts', async () => {
		const f = createFixture(TABLE_GAME_ENGINES);
		await seatTwo(f, 'tavla');
		const turnMs = TABLE_GAME_TURN_MS.tavla.normal;
		const first = (await read(f, A)).game_view as TavlaView;
		const slow = first.turn!;
		const timeoutsOf = async (position: number) =>
			(await read(f, A)).summary.players.find((player) => player.position === position)!.timeouts;

		at(turnMs - 1);
		await f.service.processDueTimers(Date.now());
		expect(((await read(f, A)).game_view as TavlaView).turn).toBe(slow);

		at(turnMs);
		await f.service.processDueTimers(Date.now());
		const auto = (await read(f, A)).game_view as TavlaView;
		expect(auto.last_moves.length).toBeGreaterThan(0);
		expect(await timeoutsOf(slow)).toBe(1);

		// The other player moves, so the slow one's next timeout is the second in a row.
		const other = auto.turn!;
		expect(other).not.toBe(slow);
		const mover = (await read(f, userAt(other))).game_view as TavlaView;
		const moves = mover.legal_moves![0]!.split(' ').map((step) => {
			const [from, to] = step.split('/') as [string, string];
			return {from: from === 'bar' ? ('bar' as const) : Number(from), to: to === 'off' ? ('off' as const) : Number(to)};
		});
		at(turnMs + 1_000);
		const env = (await f.load())!;
		await f.service.act({...ref(userAt(other)), version: env.version, action: {type: 'tavla_move', moves}});
		expect(await timeoutsOf(other)).toBe(0);

		const next = (await read(f, A)).game_view as TavlaView;
		expect(next.turn).toBe(slow);
		at(Date.parse(next.deadline_at!) - START);
		await f.service.processDueTimers(Date.now());
		const ended = await read(f, A);
		expect(ended.summary.status).toBe('ended');
		expect(ended.summary.result).toEqual({kind: 'forfeit', loser: slow, reason: 'timeouts'});
	});

	it('dama clocks charge through resolveDue', async () => {
		for (const game of ['dama', 'dama_normal'] as const) {
			at(0);
			const f = createFixture(TABLE_GAME_ENGINES);
			await seatTwo(f, game);
			const clockMs = TABLE_GAME_TURN_MS[game].normal;
			const start = (await read(f, A)).game_view as DamaView;
			const moverSide = start.turn === start.white ? 'white' : 'black';
			const waitingSide = moverSide === 'white' ? 'black' : 'white';
			const mover = (await read(f, userAt(start.turn!))).game_view as DamaView;
			at(5_000);
			const action: TableGameAction = {type: 'dama_move', path: mover.legal_moves![0]!.split('-')};
			const env = (await f.load())!;
			await f.service.act({...ref(userAt(start.turn!)), version: env.version, action});
			const moved = (await read(f, A)).game_view as DamaView;
			expect(moved.clocks_ms).toEqual({[moverSide]: clockMs - 5_000, [waitingSide]: clockMs});
			expect(moved.turn).not.toBe(start.turn);

			// The waiting side's whole clock runs out on the timer: a loss on time.
			at(5_000 + clockMs - 1);
			await f.service.processDueTimers(Date.now());
			expect((await read(f, A)).summary.status).toBe('playing');
			at(5_000 + clockMs);
			await f.service.processDueTimers(Date.now());
			const ended = await read(f, A);
			expect(ended.summary.result).toEqual({kind: 'win', winners: [start.turn], reason: 'timeout'});
		}
	});

	// every request loads a fresh envelope from KV, so only a position keyed cache spares the search.
	it('a second GET and an illegal move on the same dama board do not search again', async () => {
		const f = createFixture(TABLE_GAME_ENGINES);
		await seatTwo(f, 'dama');
		const mover = userAt(((await read(f, A)).game_view as DamaView).turn!);
		expect(((await read(f, mover)).game_view as DamaView).legal_moves).toHaveLength(8);
		const searched = damaSearchedNodes();
		await read(f, mover);
		const env = (await f.load())!;
		await expect(
			f.service.act({...ref(mover), version: env.version, action: {type: 'dama_move', path: ['a3', 'a5']}}),
		).rejects.toBeInstanceOf(TableGameRuleViolationError);
		expect(damaSearchedNodes()).toBe(searched);
	});

	it('a second GET and an illegal move on the same tavla position do not generate again', async () => {
		const f = createFixture(TABLE_GAME_ENGINES);
		await seatTwo(f, 'tavla');
		const mover = userAt(((await read(f, A)).game_view as TavlaView).turn!);
		expect(((await read(f, mover)).game_view as TavlaView).legal_moves!.length).toBeGreaterThan(0);
		const generated = tavlaGenerations();
		await read(f, mover);
		const env = (await f.load())!;
		await expect(
			f.service.act({...ref(mover), version: env.version, action: {type: 'tavla_move', moves: [{from: 1, to: 2}]}}),
		).rejects.toBeInstanceOf(TableGameRuleViolationError);
		expect(tavlaGenerations()).toBe(generated);
	});

	// a long game (tavla at 90 s turns) outlives the 2 h playing TTL its spectator set got at the start.
	it('playing table older than the playing TTL keeps its spectators', async () => {
		const f = createFixture();
		f.joinVoice('201');
		const env = await f.fill();
		await f.service.spectate({...ref('201'), connectionId: conn('201')});
		let version = env.version;
		let delivered = false;
		for (let elapsed = 20_000; elapsed <= (TABLE_GAME_TTL_S.playing + 120) * 1000; elapsed += 20_000) {
			at(elapsed);
			const current = (await f.load())!;
			const before = f.dispatches.length;
			await f.service.act({
				...ref(PLAYERS[(current.engine as FakeState).turn - 1]!),
				version: current.version,
				action: {type: 'discard', tile: 't1'},
			});
			delivered = f.dispatches.slice(before).some((dispatch) => dispatch.userId === '201');
			version = current.version + 1;
		}
		expect(version).toBeGreaterThan(env.version + TABLE_GAME_TTL_S.playing / 20);
		expect(delivered).toBe(true);
		expect(await f.repository.listSpectators(CHANNEL, SLOT)).toEqual(['201']);
		expect(await f.repository.readSpectatorLock('201')).toBe(`${CHANNEL}:${SLOT}`);
	});
});
