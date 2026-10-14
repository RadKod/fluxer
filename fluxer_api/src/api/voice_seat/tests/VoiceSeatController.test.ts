// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {
	createChannel,
	createPermissionOverwrite,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {getGatewayService} from '@app/api/middleware/ServiceRegistry';
import {
	getInstanceConfigRepository,
	getVoiceSeatRepository,
	getVoiceSeatService,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import type {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {registerVoiceSeatMockScripts} from '@app/api/voice_seat/tests/VoiceSeatMockScripts';
import {useThemeWatchSeats} from '@app/api/voice_seat/tests/VoiceSeatTestThemes';
import {VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW, VOICE_SEAT_CHANNEL_WINDOW_S} from '@app/api/voice_seat/VoiceSeatLimits';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {themeLoungeSeats, VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const THEME = VOICE_ROOM_THEME_IDS[0];
const LOUNGE = themeLoungeSeats(THEME);
const WATCH = ['seat_T01_Y1', 'seat_T01_Y2'];
const HTTP_TOO_MANY_REQUESTS = 429;
const RATE_LIMIT_TEST_HEADER = 'x-fluxer-test-enable-rate-limits';

interface Room {
	owner: TestAccount;
	member: TestAccount;
	guildId: string;
	channelId: string;
}

describe('PUT /channels/:channel_id/voice-seat', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
		registerVoiceSeatMockScripts();
	});
	beforeEach(async () => {
		await harness.reset();
		await getInstanceConfigRepository().updateVoiceRoomConfig(() => ({
			rooms_enabled: true,
			games_enabled: false,
			room_cameras_enabled: false,
			default_room_theme: null,
		}));
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	useThemeWatchSeats(THEME, WATCH);

	async function themedRoom(name = 'lounge'): Promise<Room> {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const voice = await createChannel(harness, owner.token, guild.id, name, ChannelTypes.GUILD_VOICE);
		await createBuilder(harness, owner.token)
			.patch(`/channels/${voice.id}`)
			.body({room_theme: THEME})
			.expect(HTTP_STATUS.OK)
			.execute();
		return {owner, member: members[0]!, guildId: guild.id, channelId: voice.id};
	}

	function inVoice(room: Room, channelId: string, entries: Array<{user: TestAccount; connectionId: string}>) {
		(getGatewayService() as NoopGatewayService).setVoiceStatesForChannel({
			guildId: createGuildID(BigInt(room.guildId)),
			channelId: createChannelID(BigInt(channelId)),
			voiceStates: entries.map(({user, connectionId}) => ({
				userId: user.userId,
				connectionId,
				channelId,
				regionId: 'eu',
				serverId: 'eu-1',
			})),
		});
	}

	// The membership mark the LiveKit participant_joined webhook writes.
	async function joined(room: Room, user: TestAccount, connectionId: string) {
		await getVoiceSeatRepository().take({
			channelId: createChannelID(BigInt(room.channelId)),
			identity: `user_${user.userId}_${connectionId}`,
			userId: createUserID(BigInt(user.userId)),
			mode: 'join',
			joinValue: `${user.userId}|eu|eu-1`,
			seats: [],
		});
	}

	// Watch seats are the table games': every watch seat pick below needs games on.
	const gamesOn = () =>
		getInstanceConfigRepository().updateVoiceRoomConfig(() => ({
			rooms_enabled: true,
			games_enabled: true,
			room_cameras_enabled: false,
			default_room_theme: null,
		}));

	function put(user: TestAccount, channelId: string, body: {connection_id: string; seat: string | null}) {
		return createBuilder<{seat: string | null}>(harness, user.token)
			.put(`/channels/${channelId}/voice-seat`)
			.body(body);
	}

	it('PUT moves me to a free seat and returns it', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		expect(
			await put(room.member, room.channelId, {connection_id: 'a', seat: LOUNGE[3]!}).expect(200).execute(),
		).toEqual({
			seat: LOUNGE[3],
		});
		expect(
			await put(room.member, room.channelId, {connection_id: 'a', seat: LOUNGE[1]!}).expect(200).execute(),
		).toEqual({
			seat: LOUNGE[1],
		});
	});

	it('null seat → server picks or standing (seat null)', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [
			{user: room.member, connectionId: 'a'},
			{user: room.member, connectionId: 'b'},
		]);
		expect(await put(room.member, room.channelId, {connection_id: 'a', seat: null}).expect(200).execute()).toEqual({
			seat: LOUNGE[0],
		});
		await joined(room, room.member, 'b');
		expect(await put(room.member, room.channelId, {connection_id: 'b', seat: null}).expect(200).execute()).toEqual({
			seat: null,
		});
	});

	it('table seat name → 400 (rejected by the request schema)', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await put(room.member, room.channelId, {connection_id: 'a', seat: 'seat_T01_1'}).expect(400).execute();
	});

	it('seat not in theme → VOICE_SEAT_UNKNOWN', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await put(room.member, room.channelId, {connection_id: 'a', seat: 'seat_Z_99'})
			.expect(400, APIErrorCodes.VOICE_SEAT_UNKNOWN)
			.execute();
	});

	it('occupied → VOICE_SEAT_TAKEN', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [
			{user: room.member, connectionId: 'a'},
			{user: room.owner, connectionId: 'o'},
		]);
		await joined(room, room.owner, 'o');
		await joined(room, room.member, 'a');
		await put(room.owner, room.channelId, {connection_id: 'o', seat: LOUNGE[2]!}).expect(200).execute();
		await put(room.member, room.channelId, {connection_id: 'a', seat: LOUNGE[2]!})
			.expect(409, APIErrorCodes.VOICE_SEAT_TAKEN)
			.execute();
	});

	it('not in this voice channel → USER_NOT_IN_VOICE', async () => {
		const room = await themedRoom();
		await put(room.member, room.channelId, {connection_id: 'a', seat: null})
			.expect(400, APIErrorCodes.USER_NOT_IN_VOICE)
			.execute();
	});

	it('connection_id of another user → USER_NOT_IN_VOICE', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.owner, connectionId: 'x'}]);
		await put(room.member, room.channelId, {connection_id: 'x', seat: null})
			.expect(400, APIErrorCodes.USER_NOT_IN_VOICE)
			.execute();
	});

	it('in another voice channel of the same guild → USER_NOT_IN_VOICE', async () => {
		const room = await themedRoom();
		const other = await createChannel(harness, room.owner.token, room.guildId, 'other', ChannelTypes.GUILD_VOICE);
		inVoice(room, other.id, [{user: room.member, connectionId: 'a'}]);
		await put(room.member, room.channelId, {connection_id: 'a', seat: null})
			.expect(400, APIErrorCodes.USER_NOT_IN_VOICE)
			.execute();
	});

	it('no VIEW_CHANNEL → 403', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await createPermissionOverwrite(harness, room.owner.token, room.channelId, room.guildId, {
			type: 0,
			allow: '0',
			deny: Permissions.VIEW_CHANNEL.toString(),
		});
		await put(room.member, room.channelId, {connection_id: 'a', seat: null}).expect(403).execute();
	});

	it('rooms off → FEATURE_TEMPORARILY_DISABLED; rate limit and flag are checked before any KV or RPC', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await getInstanceConfigRepository().updateVoiceRoomConfig(() => ({
			rooms_enabled: false,
			games_enabled: false,
			room_cameras_enabled: false,
			default_room_theme: null,
		}));
		const kv = harness.kvProvider as MockKVProvider;
		kv.evalScriptSpy.mockClear();
		kv.hgetSpy.mockClear();
		await put(room.member, room.channelId, {connection_id: 'a', seat: null})
			.expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
			.execute();
		expect(kv.evalScriptSpy.mock.calls.filter(([command]) => String(command).startsWith('voiceSeat'))).toEqual([]);
		expect(kv.hgetSpy.mock.calls.filter(([key]) => String(key).startsWith('{voice_seats:'))).toEqual([]);
	});

	it('seated in an active game moving away → TABLE_GAME_CONFLICT', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await put(room.member, room.channelId, {connection_id: 'a', seat: null}).expect(200).execute();
		await getVoiceSeatRepository().take({
			channelId: createChannelID(BigInt(room.channelId)),
			identity: `user_${room.member.userId}_a`,
			userId: createUserID(BigInt(room.member.userId)),
			mode: 'explicit',
			seats: ['seat_T01_2'],
		});
		await put(room.member, room.channelId, {connection_id: 'a', seat: LOUNGE[4]!})
			.expect(409, APIErrorCodes.TABLE_GAME_CONFLICT)
			.execute();
	});

	it('rate limit bucket per user+channel', async () => {
		const room = await themedRoom();
		const second = await createChannel(harness, room.owner.token, room.guildId, 'second', ChannelTypes.GUILD_VOICE);
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await joined(room, room.member, 'a');
		const limited = (user: TestAccount, channelId: string, seat: string | null) =>
			put(user, channelId, {connection_id: 'a', seat}).header(RATE_LIMIT_TEST_HEADER, 'true');
		for (let i = 0; i < 10; i++) {
			await limited(room.member, room.channelId, LOUNGE[i % 3]!)
				.expect(200)
				.execute();
		}
		await limited(room.member, room.channelId, null)
			.expect(HTTP_TOO_MANY_REQUESTS, APIErrorCodes.RATE_LIMITED)
			.execute();
		await limited(room.owner, room.channelId, null).expect(400, APIErrorCodes.USER_NOT_IN_VOICE).execute();
		await limited(room.member, second.id, null).expect(400, APIErrorCodes.VOICE_SEAT_UNKNOWN).execute();
	});

	it('PUT seat_T01_Y2 seats me', async () => {
		const room = await themedRoom();
		await gamesOn();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		expect(await put(room.member, room.channelId, {connection_id: 'a', seat: WATCH[1]!}).expect(200).execute()).toEqual(
			{seat: WATCH[1]},
		);
	});

	it('watch seat not in the theme → VOICE_SEAT_UNKNOWN', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		for (const seat of ['seat_T01_Y3', 'seat_T09_Y1']) {
			await put(room.member, room.channelId, {connection_id: 'a', seat})
				.expect(400, APIErrorCodes.VOICE_SEAT_UNKNOWN)
				.execute();
		}
	});

	it('games off → a watch seat of the theme → VOICE_SEAT_UNKNOWN (D4)', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await put(room.member, room.channelId, {connection_id: 'a', seat: WATCH[0]!})
			.expect(400, APIErrorCodes.VOICE_SEAT_UNKNOWN)
			.execute();
	});

	it('table seat names and malformed watch seat names → 400 (request schema)', async () => {
		const room = await themedRoom();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		for (const seat of ['seat_T01_4', 'seat_T01_Y5', 'seat_T01_Y0', 'seat_T1_Y1']) {
			await put(room.member, room.channelId, {connection_id: 'a', seat})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		}
	});

	it('player in an active game cannot move to a watch seat → TABLE_GAME_CONFLICT', async () => {
		const room = await themedRoom();
		await gamesOn();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await put(room.member, room.channelId, {connection_id: 'a', seat: null}).expect(200).execute();
		await getVoiceSeatRepository().take({
			channelId: createChannelID(BigInt(room.channelId)),
			identity: `user_${room.member.userId}_a`,
			userId: createUserID(BigInt(room.member.userId)),
			mode: 'explicit',
			seats: ['seat_T01_2'],
		});
		await put(room.member, room.channelId, {connection_id: 'a', seat: WATCH[0]!})
			.expect(409, APIErrorCodes.TABLE_GAME_CONFLICT)
			.execute();
	});

	it('connection_id of another user → USER_NOT_IN_VOICE (IDOR), watch seat too', async () => {
		const room = await themedRoom();
		await gamesOn();
		inVoice(room, room.channelId, [{user: room.owner, connectionId: 'x'}]);
		await joined(room, room.owner, 'x');
		await put(room.member, room.channelId, {connection_id: 'x', seat: WATCH[0]!})
			.expect(400, APIErrorCodes.USER_NOT_IN_VOICE)
			.execute();
	});

	// every seat change reaches the whole LiveKit room, so the channel caps them, whoever asks. The fake clock
	// keeps the 1 s window open for the whole loop.
	it('21st seat change in a channel within 1 s → 429 RateLimitError; webhook joins are not counted', async () => {
		const room = await themedRoom();
		await gamesOn();
		const guildId = createGuildID(BigInt(room.guildId));
		const channelId = createChannelID(BigInt(room.channelId));
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		const webhookJoin = (userId: string, connectionId: string) =>
			getVoiceSeatService().onParticipantJoined(
				{guildId, channelId, userId: createUserID(BigInt(userId)), connectionId, regionId: 'eu', serverId: 'eu-1'},
				{roomTheme: async () => THEME, tableSeat: async () => null},
			);
		vi.useFakeTimers({toFake: ['Date']});
		try {
			for (let i = 0; i < 5; i++) await webhookJoin(`${9000 + i}`, 'w');
			await webhookJoin(room.member.userId, 'a');
			for (let i = 0; i < VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW; i++) {
				await put(room.member, room.channelId, {connection_id: 'a', seat: i % 2 === 0 ? WATCH[0]! : LOUNGE[10]!})
					.expect(200)
					.execute();
			}
			const {response, json} = await put(room.member, room.channelId, {connection_id: 'a', seat: LOUNGE[11]!})
				.expect(HTTP_TOO_MANY_REQUESTS)
				.executeWithResponse();
			expect(json).toMatchObject({code: APIErrorCodes.RATE_LIMITED, retry_after: VOICE_SEAT_CHANNEL_WINDOW_S});
			expect(response.headers.get('x-ratelimit-scope')).toBe('shared');
			vi.setSystemTime(Date.now() + VOICE_SEAT_CHANNEL_WINDOW_S * 1000);
			expect(
				await put(room.member, room.channelId, {connection_id: 'a', seat: LOUNGE[11]!}).expect(200).execute(),
			).toEqual({seat: LOUNGE[11]});
		} finally {
			vi.useRealTimers();
		}
	});

	it("a non-member's request never counts; channel limit checked after membership", async () => {
		const room = await themedRoom();
		await gamesOn();
		inVoice(room, room.channelId, [{user: room.member, connectionId: 'a'}]);
		await joined(room, room.member, 'a');
		vi.useFakeTimers({toFake: ['Date']});
		try {
			for (let i = 0; i <= VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW; i++) {
				await put(room.owner, room.channelId, {connection_id: 'o', seat: WATCH[0]!})
					.expect(400, APIErrorCodes.USER_NOT_IN_VOICE)
					.execute();
			}
			for (let i = 0; i < VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW; i++) {
				await put(room.member, room.channelId, {connection_id: 'a', seat: LOUNGE[i % 2]!})
					.expect(200)
					.execute();
			}
			await put(room.member, room.channelId, {connection_id: 'a', seat: null})
				.expect(HTTP_TOO_MANY_REQUESTS, APIErrorCodes.RATE_LIMITED)
				.execute();
		} finally {
			vi.useRealTimers();
		}
	});
});
