// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannel, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {
	getInstanceConfigRepository,
	getTableGameRepository,
	getTableGameService,
} from '@app/api/middleware/ServiceSingletons';
import {registerTableGameMockScripts} from '@app/api/table_game/tests/TableGameMockScripts';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {TABLE_GAME_SPECTATOR_LIMIT} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameSpectateResponse, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

registerTableGameMockScripts();

const THEME = 'gece-lounge';
const conn = (account: TestAccount) => `c${account.userId}`;
const rackOf = (view: TableGameView) => (view.game_view as {rack?: Array<string> | null} | null)?.rack ?? null;

describe('TableGameController', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		await getInstanceConfigRepository().updateVoiceRoomConfig(() => ({
			rooms_enabled: true,
			games_enabled: true,
			room_cameras_enabled: false,
			default_room_theme: null,
		}));
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	// Voice membership is the seat service's j: mark (A2); here a caller is in voice under the connection c<user id>.
	function voiceMembers(...inVoice: Array<TestAccount>) {
		const seats = getTableGameService().deps.voiceSeatService;
		const ids = new Set(inVoice.map(conn));
		vi.spyOn(seats, 'membership').mockImplementation(async ({connectionId}) =>
			ids.has(connectionId) ? {regionId: 'eu', serverId: 'lk-1'} : null,
		);
		vi.spyOn(seats, 'seatAtTable').mockResolvedValue(undefined);
		vi.spyOn(seats, 'leaveTableSeat').mockResolvedValue(undefined);
	}

	async function themedRoom(memberCount: number) {
		const setup = await setupTestGuildWithMembers(harness, memberCount);
		const room = async (name: string) => {
			const voice = await createChannel(harness, setup.owner.token, setup.guild.id, name, ChannelTypes.GUILD_VOICE);
			await createBuilder(harness, setup.owner.token)
				.patch(`/channels/${voice.id}`)
				.body({room_theme: THEME})
				.execute();
			return voice.id;
		};
		return {...setup, x: await room('room-x'), y: await room('room-y')};
	}

	const tablePath = (channelId: string) => `/channels/${channelId}/table-games/T01`;

	async function openTable(account: TestAccount, channelId: string, game = 'okey') {
		return await createBuilder<TableGameView>(harness, account.token)
			.post(tablePath(channelId))
			.body({game, speed: 'normal', connection_id: conn(account)})
			.expect(201)
			.execute();
	}

	async function sit(account: TestAccount, channelId: string, position: number) {
		return await createBuilder<TableGameView>(harness, account.token)
			.put(`${tablePath(channelId)}/players/@me`)
			.body({position, connection_id: conn(account)})
			.expect(200)
			.execute();
	}

	it('acting on a table of channel X with a route for channel Y never reaches X', async () => {
		const {owner, members, x, y} = await themedRoom(1);
		voiceMembers(owner, members[0]!);
		await openTable(owner, x, 'chess');
		const playing = await sit(members[0]!, x, 3);
		const before = playing.summary.version;
		await createBuilder(harness, owner.token)
			.post(`${tablePath(y)}/actions`)
			.body({version: before, action: {type: 'resign'}})
			.expect(404, 'UNKNOWN_TABLE_GAME')
			.execute();
		const outsider = await setupTestGuildWithMembers(harness, 0);
		const {response} = await createBuilder(harness, outsider.owner.token)
			.post(`${tablePath(x)}/actions`)
			.body({version: before, action: {type: 'resign'}})
			.executeRaw();
		expect([403, 404]).toContain(response.status);
		const after = await getTableGameRepository().load(x, 'T01');
		expect(after).toMatchObject({version: before, status: 'playing'});
	});

	it('non-player action → TABLE_GAME_CONFLICT', async () => {
		const {owner, members, x} = await themedRoom(1);
		voiceMembers(owner, members[0]!);
		const view = await openTable(owner, x);
		await createBuilder(harness, members[0]!.token)
			.post(`${tablePath(x)}/actions`)
			.body({version: view.summary.version, action: {type: 'tick'}})
			.expect(409, 'TABLE_GAME_CONFLICT')
			.execute();
	});

	it('spectate needs voice membership', async () => {
		const {owner, members, x} = await themedRoom(1);
		voiceMembers(owner);
		await openTable(owner, x);
		await createBuilder(harness, members[0]!.token)
			.put(`${tablePath(x)}/spectators/@me`)
			.body({connection_id: conn(members[0]!)})
			.expect(400, 'USER_NOT_IN_VOICE')
			.execute();
	});

	it('51st spectator gets subscribed false and polls with ETag; 304 when unchanged', async () => {
		const {owner, members, x} = await themedRoom(1);
		const watcher = members[0]!;
		voiceMembers(owner, watcher);
		await openTable(owner, x);
		for (let index = 0; index < TABLE_GAME_SPECTATOR_LIMIT; index++) {
			await getTableGameRepository().spectate(x, 'T01', String(900_000 + index), TABLE_GAME_SPECTATOR_LIMIT, 600);
		}
		const watch = await createBuilder<TableGameSpectateResponse>(harness, watcher.token)
			.put(`${tablePath(x)}/spectators/@me`)
			.body({connection_id: conn(watcher)})
			.expect(200)
			.execute();
		expect(watch.subscribed).toBe(false);
		expect(watch.view.summary.spectator_count).toBe(TABLE_GAME_SPECTATOR_LIMIT);
		voiceMembers(owner); // the ticket alone carries the overflow poll
		const first = await createBuilder<TableGameView>(harness, watcher.token)
			.get(tablePath(x))
			.expect(200)
			.executeWithResponse();
		const etag = first.response.headers.get('etag')!;
		// "tg-<created_at>-<version>-<position|s>-<spectating>-<spectator_count>"
		expect(etag.replace(/^"tg-[0-9]+-/, '')).toBe(`${first.json.summary.version}-s-0-${TABLE_GAME_SPECTATOR_LIMIT}"`);
		const again = await createBuilder(harness, watcher.token)
			.get(tablePath(x))
			.header('If-None-Match', etag)
			.expect(304)
			.executeRaw();
		expect(again.text).toBe('');
	});

	it('a new table at the same slot and version never answers 304 to the old ETag (detail and list)', async () => {
		const {owner, members, x} = await themedRoom(1);
		const watcher = members[0]!;
		voiceMembers(owner, watcher);
		const detail = `${tablePath(x)}?connection_id=${conn(watcher)}`;
		const list = `/channels/${x}/table-games?connection_id=${conn(watcher)}`;
		const etagOf = async (path: string) =>
			(await createBuilder(harness, watcher.token).get(path).expect(200).executeRaw()).response.headers.get('etag')!;
		const first = await openTable(owner, x);
		const [oldDetail, oldList] = [await etagOf(detail), await etagOf(list)];
		await createBuilder(harness, owner.token)
			.delete(`${tablePath(x)}/players/@me`)
			.expect(204)
			.execute();
		// The ended table's key and the 1 s list cache expired.
		await getTableGameRepository().kvClient.del(`{tg:${x}:T01}`, `{tg_list:${x}}`);
		const second = await openTable(owner, x);
		expect(second.summary.version).toBe(first.summary.version);
		for (const [path, etag] of [
			[detail, oldDetail],
			[list, oldList],
		] as const) {
			const {response} = await createBuilder(harness, watcher.token)
				.get(path)
				.header('If-None-Match', etag)
				.executeRaw();
			expect(response.status).toBe(200);
		}
	});

	it('spectator_count change changes the ETag', async () => {
		const {owner, members, x} = await themedRoom(1);
		const watcher = members[0]!;
		voiceMembers(owner, watcher);
		await openTable(owner, x);
		const detail = `${tablePath(x)}?connection_id=${conn(watcher)}`;
		const first = await createBuilder(harness, watcher.token).get(detail).expect(200).executeRaw();
		await getTableGameRepository().spectate(x, 'T01', '900001', TABLE_GAME_SPECTATOR_LIMIT, 600);
		const {response} = await createBuilder(harness, watcher.token)
			.get(detail)
			.header('If-None-Match', first.response.headers.get('etag')!)
			.executeRaw();
		expect(response.status).toBe(200);
	});

	it('GET returns my rack only when I am a player; table GET responses are private, no-cache, Vary Authorization', async () => {
		const {owner, members, x} = await themedRoom(4);
		const players = [owner, members[0]!, members[1]!, members[2]!];
		const watcher = members[3]!;
		voiceMembers(...players, watcher);
		await openTable(owner, x);
		for (let position = 2; position <= 4; position++) await sit(players[position - 1]!, x, position);
		const mine = await createBuilder<TableGameView>(harness, members[0]!.token)
			.get(tablePath(x))
			.expect(200)
			.executeWithResponse();
		expect(mine.json.viewer_position).toBe(2);
		expect(rackOf(mine.json)?.length).toBeGreaterThanOrEqual(14);
		for (const header of [mine.response.headers]) {
			expect(header.get('cache-control')).toBe('private, no-cache');
			expect(header.get('vary')).toContain('Authorization');
		}
		const theirs = await createBuilder<TableGameView>(harness, watcher.token)
			.get(`${tablePath(x)}?connection_id=${conn(watcher)}`)
			.expect(200)
			.execute();
		expect(theirs.viewer_position).toBeNull();
		expect(rackOf(theirs)).toBeNull();
		const list = await createBuilder(harness, watcher.token)
			.get(`/channels/${x}/table-games?connection_id=${conn(watcher)}`)
			.expect(200)
			.executeWithResponse();
		expect(list.response.headers.get('cache-control')).toBe('private, no-cache');
		expect(list.response.headers.get('vary')).toContain('Authorization');
		expect(list.response.headers.get('etag')).toMatch(/^"tgl-[0-9a-f]{32}"$/);
	});

	it('rule violation body is {code, message, reason} with no tiles', async () => {
		const {owner, members, x} = await themedRoom(3);
		const players = [owner, members[0]!, members[1]!, members[2]!];
		voiceMembers(...players);
		await openTable(owner, x);
		let view: TableGameView | null = null;
		for (let position = 2; position <= 4; position++) view = await sit(players[position - 1]!, x, position);
		const game = view!.game_view!;
		if (game.game === 'chess') throw new Error('okey expected');
		const idle = players.find((_, index) => index + 1 !== game.turn)!;
		const idleView = await createBuilder<TableGameView>(harness, idle.token).get(tablePath(x)).expect(200).execute();
		const tile = rackOf(idleView)![0]!;
		const {response, text} = await createBuilder(harness, idle.token)
			.post(`${tablePath(x)}/actions`)
			.body({version: view!.summary.version, action: {type: 'discard', tile}})
			.executeRaw();
		expect(response.status).toBe(400);
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(['code', 'message', 'reason']);
		expect(body).toMatchObject({code: 'TABLE_GAME_RULE_VIOLATION', reason: 'not_your_turn'});
		expect(text).not.toMatch(/\bt\d+\b/);
	});

	// 33 requests of one user stay under the global 50 per second; the action bucket is 30 per 10 s per channel and slot.
	it('rate limit buckets per user+channel(+slot)', async () => {
		const {owner, members, x, y} = await themedRoom(1);
		voiceMembers(owner, members[0]!);
		const act = (account: TestAccount, channelId: string) =>
			createBuilder(harness, account.token)
				.post(`${tablePath(channelId)}/actions`)
				.header('x-fluxer-test-enable-rate-limits', 'true')
				.body({version: 0, action: {type: 'tick'}})
				.executeRaw();
		for (let index = 0; index < 30; index++) expect((await act(owner, x)).response.status).toBe(404);
		expect((await act(owner, x)).response.status).toBe(429);
		expect((await act(owner, y)).response.status).toBe(404);
		expect((await act(members[0]!, x)).response.status).toBe(404);
	});
});
