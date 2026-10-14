// SPDX-License-Identifier: AGPL-3.0-or-later

import {CryptoRng} from '@app/api/table_game/engine/TableGameEngine';
import {TABLE_GAME_LOBBY_TIMEOUT_MS, TABLE_GAME_LOCK_SETTLE_S} from '@app/api/table_game/TableGameLimits';
import {
	CHANNEL,
	cid,
	conn,
	createFixture,
	FAKE_ENGINES,
	type FakeState,
	type Fixture,
	fakeStarts,
	OTHER_CHANNEL,
	PLAYERS,
	SLOT,
	uid,
} from '@app/api/table_game/tests/TableGameTestFixture';
import {TABLE_GAME_DISCONNECT_GRACE_MS, TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {UserNotInVoiceError} from '@fluxer/errors/src/domains/user/UserNotInVoiceError';
import {TableGameConflictError} from '@fluxer/errors/src/domains/voice/TableGameConflictError';
import {TableGameRuleViolationError} from '@fluxer/errors/src/domains/voice/TableGameRuleViolationError';
import {UnknownTableGameError} from '@fluxer/errors/src/domains/voice/UnknownTableGameError';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const START = new Date('2026-10-03T10:00:00.000Z').getTime();
const TURN = TABLE_GAME_TURN_MS.okey.normal;
const [A, B, C, D] = PLAYERS;

function at(ms: number) {
	vi.setSystemTime(START + ms);
}

const ref = (userId: string, channelId = CHANNEL) => ({userId: uid(userId), channelId: cid(channelId), slot: SLOT});

async function act(f: Fixture, userId: string, version: number, action: {type: string}) {
	return await f.service.act({...ref(userId), version, action: action as never});
}

describe('TableGameService', () => {
	let f: Fixture;

	beforeEach(() => {
		vi.useFakeTimers({toFake: ['Date']});
		at(0);
		fakeStarts.length = 0;
		f = createFixture();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('inherited instance theme enables table creation and listing', async () => {
		f.themes.set(CHANNEL, null);
		Object.assign(f.config, {default_room_theme: VOICE_ROOM_THEME_IDS[0]});
		f.joinVoice(A);
		expect((await f.create(A)).summary.slot).toBe(SLOT);
		expect((await f.service.list({...ref(A), connectionId: conn(A)})).body.tables).toHaveLength(1);
	});

	it('explicit none hides a previously cached game list', async () => {
		f.joinVoice(A);
		await f.create(A);
		expect((await f.service.list({...ref(A), connectionId: conn(A)})).body.tables).toHaveLength(1);
		f.themes.set(CHANNEL, 'none');
		Object.assign(f.config, {default_room_theme: VOICE_ROOM_THEME_IDS[0]});
		expect((await f.service.list({...ref(A), connectionId: conn(A)})).body.tables).toEqual([]);
	});

	it('explicit none rejects table creation despite an instance default', async () => {
		f.themes.set(CHANNEL, 'none');
		Object.assign(f.config, {default_room_theme: VOICE_ROOM_THEME_IDS[0]});
		f.joinVoice(A);
		await expect(f.create(A)).rejects.toBeInstanceOf(UnknownTableGameError);
	});

	it('an inherited default remains valid when the timer settles a table', async () => {
		await f.fill();
		f.themes.set(CHANNEL, null);
		Object.assign(f.config, {default_room_theme: VOICE_ROOM_THEME_IDS[0]});
		at(TURN);
		await f.service.processDueTimers(Date.now());
		expect((await f.load())?.result).not.toEqual({kind: 'canceled', reason: 'theme_changed'});
	});

	it('create needs voice membership, theme slot and a free user lock', async () => {
		await expect(f.create(A)).rejects.toBeInstanceOf(UserNotInVoiceError);
		f.joinVoice(A);
		await expect(
			f.service.create({...ref(A), slot: 'T09', game: 'okey', speed: 'normal', connectionId: conn(A)}),
		).rejects.toBeInstanceOf(UnknownTableGameError);
		const view = await f.create(A);
		expect(view.summary).toMatchObject({status: 'lobby', version: 0, players: [{position: 1, user_id: A}]});
		expect(view.viewer_position).toBe(1);
		expect(await f.repository.readUserLock(A)).toBe(`${CHANNEL}:${SLOT}`);
		expect(f.seats.seatAtTable).toHaveBeenCalledWith(
			expect.objectContaining({
				slot: SLOT,
				position: 1,
				voiceStates: [expect.objectContaining({connectionId: conn(A)})],
			}),
		);
		await expect(f.create(A)).rejects.toBeInstanceOf(TableGameConflictError);
	});

	it('create/join/spectate make no gateway call when j: is present', async () => {
		f.joinVoice(A);
		f.joinVoice(B);
		f.joinVoice('201');
		await f.create(A);
		await f.service.join({...ref(B), position: 2, connectionId: conn(B)});
		await f.service.spectate({...ref('201'), connectionId: conn('201')});
		expect(f.gateway.getVoiceStatesForChannel).not.toHaveBeenCalled();
	});

	it('user with an active table cannot create or join another → TABLE_GAME_CONFLICT', async () => {
		f.joinVoice(A);
		f.joinVoice(A, OTHER_CHANNEL);
		f.joinVoice(B, OTHER_CHANNEL);
		await f.create(A);
		await f.create(B, 'okey', OTHER_CHANNEL);
		await expect(f.create(A, 'okey', OTHER_CHANNEL)).rejects.toBeInstanceOf(TableGameConflictError);
		await expect(f.service.join({...ref(A, OTHER_CHANNEL), position: 2, connectionId: conn(A)})).rejects.toBeInstanceOf(
			TableGameConflictError,
		);
		expect(await f.repository.readUserLock(A)).toBe(`${CHANNEL}:${SLOT}`);
	});

	it('join fills a free position; full table starts the engine with CryptoRng', async () => {
		for (const user of PLAYERS) f.joinVoice(user);
		await f.create(A);
		await expect(f.service.join({...ref(B), position: 1, connectionId: conn(B)})).rejects.toBeInstanceOf(
			TableGameConflictError,
		);
		await f.service.join({...ref(B), position: 2, connectionId: conn(B)});
		await f.service.join({...ref(C), position: 3, connectionId: conn(C)});
		expect(fakeStarts).toHaveLength(0);
		const view = await f.service.join({...ref(D), position: 4, connectionId: conn(D)});
		expect(view.summary.status).toBe('playing');
		expect(fakeStarts).toHaveLength(1);
		expect(fakeStarts[0]!.rng).toBe(CryptoRng);
		expect(fakeStarts[0]!.positions).toEqual([1, 2, 3, 4]);
		expect((await f.load())!.engine).toMatchObject({deadlineAt: START + TURN});
	});

	it('chess accepts positions 1 and 3 only', async () => {
		f.joinVoice(A);
		f.joinVoice(B);
		await f.create(A, 'chess');
		await expect(f.service.join({...ref(B), position: 2, connectionId: conn(B)})).rejects.toBeInstanceOf(
			TableGameConflictError,
		);
		const view = await f.service.join({...ref(B), position: 3, connectionId: conn(B)});
		expect(view.summary.status).toBe('playing');
	});

	it('leave in lobby frees the seat; leave while playing → forfeit leave immediately (Ş14)', async () => {
		f.joinVoice(A);
		f.joinVoice(B);
		await f.create(A);
		await f.service.join({...ref(B), position: 2, connectionId: conn(B)});
		await f.service.leave(ref(B));
		expect((await f.load())!.players.map((p) => p.user_id)).toEqual([A]);
		expect(await f.repository.readUserLock(B)).toBeNull();
		expect(f.seats.leaveTableSeat).toHaveBeenCalledWith(expect.objectContaining({userId: uid(B)}));

		f = createFixture();
		const env = await f.fill();
		await f.service.leave(ref(B));
		const ended = (await f.load())!;
		expect(ended.status).toBe('ended');
		expect(ended.result).toEqual({kind: 'forfeit', loser: 2, reason: 'leave'});
		expect(ended.version).toBe(env.version + 1);
		for (const user of PLAYERS) expect(await f.repository.readUserLock(user)).toBeNull();
		expect(f.seats.leaveTableSeat).toHaveBeenCalledTimes(4);
	});

	it('voice left → disconnected; back within 30 s keeps playing; after 30 s forfeit disconnect', async () => {
		await f.fill();
		f.leaveVoice(C);
		await f.service.onVoiceLeft({userId: uid(C), guildId: 500n as never, channelId: cid(CHANNEL)});
		const marked = (await f.load())!;
		expect(marked.disconnected).toEqual({3: START});
		expect(f.dispatches.at(-1)!.event.view.summary.players.find((p) => p.position === 3)!.connected).toBe(false);

		at(10_000);
		f.joinVoice(C);
		await f.service.onVoiceJoined({userId: uid(C), guildId: 500n as never, channelId: cid(CHANNEL)});
		expect((await f.load())!.disconnected).toEqual({});

		f.leaveVoice(C);
		await f.service.onVoiceLeft({userId: uid(C), guildId: 500n as never, channelId: cid(CHANNEL)});
		at(10_000 + TABLE_GAME_DISCONNECT_GRACE_MS - 1);
		await f.service.processDueTimers(Date.now());
		expect((await f.load())!.status).toBe('playing');
		at(10_000 + TABLE_GAME_DISCONNECT_GRACE_MS);
		await f.service.processDueTimers(Date.now());
		expect((await f.load())!.result).toEqual({kind: 'forfeit', loser: 3, reason: 'disconnect'});
	});

	it('leaving voice for another channel starts the grace (no other connection here)', async () => {
		await f.fill();
		f.leaveVoice(B);
		f.joinVoice(B, OTHER_CHANNEL);
		await f.service.onVoiceLeft({userId: uid(B), guildId: 500n as never, channelId: cid(CHANNEL)});
		expect((await f.load())!.disconnected).toEqual({2: START});
	});

	it('second connection still in channel → no forfeit', async () => {
		await f.fill();
		f.joinVoice(B, CHANNEL, 'phone');
		f.leaveVoice(B);
		await f.service.onVoiceLeft({userId: uid(B), guildId: 500n as never, channelId: cid(CHANNEL)});
		expect((await f.load())!.disconnected).toEqual({});
	});

	it('late rpc remove after rejoin → no forfeit', async () => {
		await f.fill();
		// The user dropped and came back; the remove of the old connection arrives after the rejoin.
		await f.service.onVoiceLeft({userId: uid(B), guildId: 500n as never, channelId: cid(CHANNEL)});
		expect((await f.load())!.disconnected).toEqual({});
	});

	it('forfeit re-verifies presence at the deadline', async () => {
		await f.fill();
		f.leaveVoice(D);
		await f.service.onVoiceLeft({userId: uid(D), guildId: 500n as never, channelId: cid(CHANNEL)});
		f.joinVoice(D); // back, but the join hook never came
		at(TABLE_GAME_DISCONNECT_GRACE_MS);
		await f.service.processDueTimers(Date.now());
		const env = (await f.load())!;
		expect(env.status).toBe('playing');
		expect(env.disconnected).toEqual({});
	});

	it('presence check every 60 s marks a missing player', async () => {
		await f.fill();
		f.leaveVoice(A); // the leave hook was lost
		at(59_000);
		await f.service.processDueTimers(Date.now());
		expect(f.gateway.getVoiceStatesForChannel).not.toHaveBeenCalled();
		at(60_000);
		await f.service.processDueTimers(Date.now());
		expect(f.gateway.getVoiceStatesForChannel).toHaveBeenCalledTimes(1);
		const env = (await f.load())!;
		expect(env.disconnected).toEqual({1: START + 60_000});
		expect(env.next_presence_check_at).toBe(START + 120_000);
	});

	it('concurrent tick and discard on the same version: exactly one state change and one dispatch', async () => {
		const env = await f.fill();
		const turnUser = PLAYERS[(env.engine as FakeState).turn - 1]!;
		at(TURN + 1_000);
		const before = f.dispatches.length;
		const results = await Promise.allSettled([
			act(f, B, 0, {type: 'tick'}),
			act(f, turnUser, env.version, {type: 'discard', tile: 't1'} as never),
		]);
		const after = (await f.load())!;
		expect(after.version).toBe(env.version + 1);
		expect(f.dispatches.length - before).toBe(4);
		expect((after.engine as FakeState).moves).toBe(1);
		expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
	});

	it('4 player ticks after the deadline cause one state change and zero presence calls', async () => {
		const env = await f.fill();
		at(TURN + 1_000);
		await Promise.all(PLAYERS.map((user) => act(f, user, 0, {type: 'tick'})));
		expect((await f.load())!.version).toBe(env.version + 1);
		expect(f.gateway.getVoiceStatesForChannel).not.toHaveBeenCalled();
	});

	it('spectator tick → TABLE_GAME_CONFLICT', async () => {
		await f.fill();
		f.joinVoice('201');
		await f.service.spectate({...ref('201'), connectionId: conn('201')});
		at(TURN + 1_000);
		await expect(act(f, '201', 0, {type: 'tick'})).rejects.toBeInstanceOf(TableGameConflictError);
	});

	it('stale version → TABLE_GAME_CONFLICT; rule errors carry the reason only', async () => {
		const env = await f.fill();
		const turn = (env.engine as FakeState).turn;
		const turnUser = PLAYERS[turn - 1]!;
		const other = PLAYERS[turn % 4]!;
		await expect(act(f, turnUser, env.version - 1, {type: 'discard', tile: 't1'} as never)).rejects.toBeInstanceOf(
			TableGameConflictError,
		);
		const error = await act(f, other, env.version, {type: 'discard', tile: 't1'} as never).catch((e) => e);
		expect(error).toBeInstanceOf(TableGameRuleViolationError);
		expect(error.data).toEqual({reason: 'not_your_turn'});
		expect((await f.load())!.version).toBe(env.version);
	});

	it('slot missing from the channel theme cancels the table on the next action or tick', async () => {
		const env = await f.fill();
		f.themes.set(CHANNEL, null);
		await act(f, A, 0, {type: 'tick'});
		const ended = (await f.load())!;
		expect(ended.version).toBe(env.version + 1);
		expect(ended.result).toEqual({kind: 'canceled', reason: 'theme_changed'});
		for (const user of PLAYERS) expect(await f.repository.readUserLock(user)).toBeNull();
	});

	it('the timer cancels a due table whose slot left the channel theme, reading the channel only when due', async () => {
		const env = await f.fill();
		f.themes.set(CHANNEL, null);
		at(TURN - 1);
		await f.service.processDueTimers(Date.now());
		expect(f.channels.findUnique).not.toHaveBeenCalled();
		at(TURN);
		await f.service.processDueTimers(Date.now());
		const ended = (await f.load())!;
		expect(ended.version).toBe(env.version + 1);
		expect(ended.result).toEqual({kind: 'canceled', reason: 'theme_changed'});
		expect(f.channels.findUnique).toHaveBeenCalledTimes(1);
	});

	it('a failed channel read on the timer still settles the turn', async () => {
		const env = await f.fill();
		f.channels.findUnique.mockRejectedValueOnce(new Error('cassandra down'));
		at(TURN);
		await f.service.processDueTimers(Date.now());
		const after = (await f.load())!;
		expect(after.status).toBe('playing');
		expect((after.engine as FakeState).moves).toBe((env.engine as FakeState).moves + 1);
	});

	it('games off → routes 403 and the timer cancels running tables with reason disabled (Ş18)', async () => {
		await f.fill();
		f.config.games_enabled = false;
		await expect(act(f, A, 0, {type: 'tick'})).rejects.toBeInstanceOf(FeatureTemporarilyDisabledError);
		await expect(f.service.list({...ref(A), connectionId: conn(A)})).rejects.toBeInstanceOf(
			FeatureTemporarilyDisabledError,
		);
		await f.service.processDueTimers(Date.now());
		expect((await f.load())!.result).toEqual({kind: 'canceled', reason: 'disabled'});
	});

	it('a new table can be created right after the previous one ended', async () => {
		const env = await f.fill();
		await f.service.leave(ref(A));
		const view = await f.create(B);
		expect(view.summary).toMatchObject({status: 'lobby', version: env.version + 2, result: null});
	});

	it('abandoned lobby after 10 min frees locks and seats', async () => {
		f.joinVoice(A);
		f.joinVoice(B);
		await f.create(A);
		await f.service.join({...ref(B), position: 2, connectionId: conn(B)});
		at(TABLE_GAME_LOBBY_TIMEOUT_MS - 1);
		await f.service.processDueTimers(Date.now());
		expect((await f.load())!.status).toBe('lobby');
		at(TABLE_GAME_LOBBY_TIMEOUT_MS);
		await f.service.processDueTimers(Date.now());
		expect((await f.load())!.result).toEqual({kind: 'canceled', reason: 'abandoned'});
		expect(await f.repository.readUserLock(A)).toBeNull();
		expect(await f.repository.readUserLock(B)).toBeNull();
		expect(f.seats.leaveTableSeat).toHaveBeenCalledTimes(2);
	});

	it('leaving voice in the lobby leaves the table without penalty', async () => {
		f.joinVoice(A);
		f.joinVoice(B);
		await f.create(A);
		await f.service.join({...ref(B), position: 2, connectionId: conn(B)});
		f.leaveVoice(B);
		await f.service.onVoiceLeft({userId: uid(B), guildId: 500n as never, channelId: cid(CHANNEL)});
		const env = (await f.load())!;
		expect(env.status).toBe('lobby');
		expect(env.players.map((p) => p.user_id)).toEqual([A]);
		expect(await f.repository.readUserLock(B)).toBeNull();
	});

	it('join losing CAS releases its lock', async () => {
		f.joinVoice(A);
		f.joinVoice(B);
		await f.create(A);
		const cas = vi.spyOn(f.repository, 'cas').mockResolvedValueOnce(false).mockResolvedValueOnce(false);
		await expect(f.service.join({...ref(B), position: 2, connectionId: conn(B)})).rejects.toBeInstanceOf(
			TableGameConflictError,
		);
		cas.mockRestore();
		expect(await f.repository.readUserLock(B)).toBeNull();
	});

	it('a stale lock to an ended table is replaced atomically', async () => {
		await f.fill();
		await f.service.leave(ref(A));
		// A lock left behind (an unlock lost on the way) points at the ended table.
		await f.repository.lockUser(B, `${CHANNEL}:${SLOT}`);
		at(TABLE_GAME_LOCK_SETTLE_S * 1000 + 1);
		f.joinVoice(B, OTHER_CHANNEL);
		await f.create(B, 'okey', OTHER_CHANNEL);
		expect(await f.repository.readUserLock(B)).toBe(`${OTHER_CHANNEL}:${SLOT}`);
	});

	it('a fresh lock is never taken as stale: its table write may still be on the way', async () => {
		await f.repository.lockUser(A, '424242:T01');
		f.joinVoice(A);
		await expect(f.create(A)).rejects.toBeInstanceOf(TableGameConflictError);
	});

	it('two concurrent stale replacements: exactly one wins', async () => {
		await f.repository.lockUser(A, '424242:T01'); // a table that no longer exists
		at(TABLE_GAME_LOCK_SETTLE_S * 1000 + 1);
		f.joinVoice(A);
		f.joinVoice(A, OTHER_CHANNEL);
		const results = await Promise.allSettled([f.create(A), f.create(A, 'okey', OTHER_CHANNEL)]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const lock = await f.repository.readUserLock(A);
		const tables = [await f.load(CHANNEL), await f.load(OTHER_CHANNEL)].filter((t) => t !== null);
		expect(tables).toHaveLength(1);
		expect(lock).toBe(`${tables[0]!.channel_id}:${SLOT}`);
	});

	it('a player cannot spectate own table', async () => {
		await f.fill();
		await expect(f.service.spectate({...ref(A), connectionId: conn(A)})).rejects.toBeInstanceOf(TableGameConflictError);
	});

	it('a player is dispatched once even if in the spectator set', async () => {
		const env = await f.fill();
		await f.repository.spectate(CHANNEL, SLOT, A, 50, 600);
		f.joinVoice('201');
		await f.service.spectate({...ref('201'), connectionId: conn('201')});
		const before = f.dispatches.length;
		const turnUser = PLAYERS[(env.engine as FakeState).turn - 1]!;
		await act(f, turnUser, env.version, {type: 'discard', tile: 't1'} as never);
		const sent = f.dispatches.slice(before);
		expect(sent.map((d) => d.userId).sort()).toEqual([...PLAYERS, '201'].sort());
		expect(sent.find((d) => d.userId === A)!.event.view.viewer_position).toBe(1);
		expect(sent.find((d) => d.userId === '201')!.event.view).toMatchObject({viewer_position: null, spectating: true});
	});

	it('a spectator of a lobby keeps getting updates in a 20 min game', async () => {
		for (const user of PLAYERS) f.joinVoice(user);
		f.joinVoice('201');
		await f.create(A);
		await f.service.spectate({...ref('201'), connectionId: conn('201')}); // the lobby lifetime, 660 s
		for (const [index, user] of [B, C, D].entries()) {
			await f.service.join({...ref(user), position: index + 2, connectionId: conn(user)});
		}
		for (let elapsed = 20_000; elapsed <= 20 * 60_000; elapsed += 20_000) {
			at(elapsed);
			const env = (await f.load())!;
			const before = f.dispatches.length;
			await act(f, PLAYERS[(env.engine as FakeState).turn - 1]!, env.version, {type: 'discard', tile: 't1'} as never);
			expect(f.dispatches.slice(before).map((d) => d.userId)).toContain('201');
		}
		expect(await f.repository.readSpectatorLock('201')).toBe(`${CHANNEL}:${SLOT}`);
	});

	it('ended table frees its spectators: the last event reaches them, then the set and their locks go', async () => {
		await f.fill();
		f.joinVoice('201');
		await f.service.spectate({...ref('201'), connectionId: conn('201')});
		const before = f.dispatches.length;
		await f.service.leave(ref(A));
		const last = f.dispatches.slice(before).find((d) => d.userId === '201');
		expect(last!.event.view.summary.status).toBe('ended');
		expect(await f.repository.listSpectators(CHANNEL, SLOT)).toEqual([]);
		expect(await f.repository.readSpectatorLock('201')).toBeNull();
	});

	it('a new table at the slot starts with no spectators', async () => {
		await f.fill();
		await f.service.leave(ref(A));
		await f.repository.spectate(CHANNEL, SLOT, '202', 50, 300); // a late watcher of the ended table
		const before = f.dispatches.length;
		const view = await f.create(B);
		expect(view.summary.spectator_count).toBe(0);
		expect(await f.repository.listSpectators(CHANNEL, SLOT)).toEqual([]);
		expect(f.dispatches.slice(before).map((d) => d.userId)).toEqual([B]);
	});

	it('concurrent list reads within the cache window compute once', async () => {
		const readers = Array.from({length: 20}, (_, index) => String(400 + index));
		f.joinVoice(A);
		for (const reader of readers) f.joinVoice(reader);
		await f.create(A);
		f.seats.membership.mockClear();
		const load = vi.spyOn(f.repository, 'load');
		const reads = await Promise.all(
			readers.map((reader) => f.service.list({...ref(reader), connectionId: conn(reader)})),
		);
		expect(load).toHaveBeenCalledTimes(1); // gece-lounge has one table slot
		expect(f.seats.membership).toHaveBeenCalledTimes(readers.length); // the cache never skips the caller's checks
		expect(new Set(reads.map((read) => read.etag)).size).toBe(1);
		expect(reads.every((read) => read.body.tables.length === 1)).toBe(true);
		at(1_000); // past the 1 s window the next read computes again
		await f.service.list({...ref(A), connectionId: conn(A)});
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('non-member cannot GET table state or list', async () => {
		f.joinVoice(A);
		await f.create(A);
		await expect(f.service.get({...ref('201')})).rejects.toBeInstanceOf(UserNotInVoiceError);
		await expect(f.service.get({...ref('201'), connectionId: conn('201')})).rejects.toBeInstanceOf(UserNotInVoiceError);
		await expect(f.service.list({...ref('201'), connectionId: conn('201')})).rejects.toBeInstanceOf(
			UserNotInVoiceError,
		);
		await expect(f.service.list({...ref('201')})).rejects.toBeInstanceOf(UserNotInVoiceError);
		f.joinVoice('201');
		expect((await f.service.list({...ref('201'), connectionId: conn('201')})).body.tables).toHaveLength(1);
	});

	it('ticket lets an overflow spectator poll with no gateway call', async () => {
		await f.fill();
		f.joinVoice('201');
		await f.service.spectate({...ref('201'), connectionId: conn('201')});
		f.seats.membership.mockClear();
		f.leaveVoice('201');
		const {body: view} = await f.service.get(ref('201'));
		expect(view!.viewer_position).toBeNull();
		expect(f.seats.membership).not.toHaveBeenCalled();
		expect(f.gateway.getVoiceStatesForChannel).not.toHaveBeenCalled();
	});

	it('ticket expires after 60 s; renewal needs membership', async () => {
		await f.fill();
		f.joinVoice('201');
		await f.service.spectate({...ref('201'), connectionId: conn('201')});
		at(60_000);
		await expect(f.service.get(ref('201'))).rejects.toBeInstanceOf(UserNotInVoiceError);
		await f.service.get({...ref('201'), connectionId: conn('201')});
		f.leaveVoice('201');
		await f.service.get(ref('201'));
	});

	it('GET returns my rack only when I am a player', async () => {
		await f.fill();
		expect((await f.service.get(ref(A))).body!.game_view).toMatchObject({rack: []});
		f.joinVoice('201');
		expect((await f.service.get({...ref('201'), connectionId: conn('201')})).body!.game_view).toMatchObject({
			rack: null,
		});
	});

	// the tag comes from the envelope, so a revalidation costs no engine view (no dama/tavla move search).
	it('a matching If-None-Match never builds the view', async () => {
		await f.fill();
		f.joinVoice('201');
		const watcher = {...ref('201'), connectionId: conn('201')};
		const view = vi.spyOn(FAKE_ENGINES.okey, 'view');
		try {
			const mine = await f.service.get(ref(A));
			const theirs = await f.service.get(watcher);
			view.mockClear();
			expect(await f.service.get({...ref(A), ifNoneMatch: mine.etag})).toEqual({etag: mine.etag, body: null});
			expect(await f.service.get({...watcher, ifNoneMatch: `W/${theirs.etag}`})).toEqual({
				etag: theirs.etag,
				body: null,
			});
			expect(view).not.toHaveBeenCalled();
			expect((await f.service.get({...ref(A), ifNoneMatch: theirs.etag})).body).toEqual(mine.body);
			expect(view).toHaveBeenCalledTimes(1);
		} finally {
			view.mockRestore();
		}
	});

	// The tag is compared only after the caller's checks: a valid tag alone never answers 304.
	it('a non-member sending a valid If-None-Match for the table is rejected, never a 304', async () => {
		await f.fill();
		f.joinVoice('201');
		const {etag} = await f.service.get({...ref('201'), connectionId: conn('201')}); // the tag every non-player gets
		// '202' is in no voice channel and holds no watch ticket.
		await expect(f.service.get({...ref('202'), ifNoneMatch: etag})).rejects.toBeInstanceOf(UserNotInVoiceError);
		await expect(f.service.get({...ref('202'), connectionId: conn('202'), ifNoneMatch: etag})).rejects.toBeInstanceOf(
			UserNotInVoiceError,
		);
		// '201' still holds its watch ticket but no longer passes the channel check.
		f.removedUsers.add('201');
		await expect(f.service.get({...ref('201'), ifNoneMatch: etag})).rejects.toBeInstanceOf(UnknownChannelError);
		// The tag was valid all along: once '202' is in voice it revalidates to a 304.
		f.joinVoice('202');
		expect(await f.service.get({...ref('202'), connectionId: conn('202'), ifNoneMatch: etag})).toEqual({
			etag,
			body: null,
		});
	});

	it('a member removed from the guild cannot act, leave or unspectate', async () => {
		await f.fill();
		f.removedUsers.add(A);
		await expect(act(f, A, 0, {type: 'tick'})).rejects.toBeInstanceOf(UnknownChannelError);
		await expect(f.service.leave(ref(A))).rejects.toBeInstanceOf(UnknownChannelError);
		await expect(f.service.unspectate(ref(A))).rejects.toBeInstanceOf(UnknownChannelError);
		expect((await f.load())!.status).toBe('playing');
	});

	it('acting on a table of channel X with a route for channel Y never reaches X', async () => {
		const env = await f.fill();
		const turnUser = PLAYERS[(env.engine as FakeState).turn - 1]!;
		await expect(
			act(f, turnUser, env.version, {type: 'discard', tile: 't1'} as never).then(() =>
				f.service.act({...ref(turnUser, OTHER_CHANNEL), version: env.version + 1, action: {type: 'resign'}}),
			),
		).rejects.toBeInstanceOf(UnknownTableGameError);
		expect((await f.load())!.status).toBe('playing');
	});

	it('tableSeatFor names the table seat of an active player only', async () => {
		f.joinVoice(A);
		await f.create(A);
		expect(await f.service.tableSeatFor({userId: uid(A), channelId: cid(CHANNEL)})).toBe('seat_T01_1');
		expect(await f.service.tableSeatFor({userId: uid(A), channelId: cid(OTHER_CHANNEL)})).toBeNull();
		await f.service.leave(ref(A));
		expect(await f.service.tableSeatFor({userId: uid(A), channelId: cid(CHANNEL)})).toBeNull();
	});
});
