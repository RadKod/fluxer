// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChannelID, createChannelID, createGuildID, createUserID, type UserID} from '@app/api/BrandedTypes';
import type {ChannelAuthService} from '@app/api/channel/services/channel_data/ChannelAuthService';
import type {GatewayVoiceStateEntry, IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ILiveKitService} from '@app/api/infrastructure/ILiveKitService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {registerVoiceSeatMockScripts} from '@app/api/voice_seat/tests/VoiceSeatMockScripts';
import {useThemeWatchSeats} from '@app/api/voice_seat/tests/VoiceSeatTestThemes';
import {VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW, VOICE_SEAT_CHANNEL_WINDOW_S} from '@app/api/voice_seat/VoiceSeatLimits';
import {VoiceSeatRepository, voiceSeatsKey} from '@app/api/voice_seat/VoiceSeatRepository';
import {type VoiceParticipantContext, VoiceSeatService} from '@app/api/voice_seat/VoiceSeatService';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {themeLoungeSeats, VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const THEME = VOICE_ROOM_THEME_IDS[0];
const LOUNGE = themeLoungeSeats(THEME);
const WATCH = ['seat_T01_Y1', 'seat_T01_Y2'];
const GUILD = createGuildID(1n);
const ME: UserID = createUserID(7n);
const OTHER: UserID = createUserID(8n);

let nextChannel = 5000n;

interface Harness {
	service: VoiceSeatService;
	repo: VoiceSeatRepository;
	kv: MockKVProvider;
	channelId: ChannelID;
	attributes: ReturnType<typeof vi.fn>;
	voiceStates: Array<GatewayVoiceStateEntry>;
	getVoiceStates: ReturnType<typeof vi.fn>;
	config: {rooms_enabled: boolean; games_enabled: boolean; default_room_theme?: typeof THEME | null};
	theme: string | null;
}

function harness(options: {rooms?: boolean; games?: boolean; theme?: string | null} = {}): Harness {
	const kv = new MockKVProvider();
	const repo = new VoiceSeatRepository(kv);
	const channelId = createChannelID(nextChannel++);
	const h = {
		kv,
		repo,
		channelId,
		voiceStates: [] as Array<GatewayVoiceStateEntry>,
		config: {rooms_enabled: options.rooms ?? true, games_enabled: options.games ?? false},
		theme: options.theme === undefined ? THEME : options.theme,
	} as Harness;
	h.attributes = vi.fn(async () => 'ok' as const);
	h.getVoiceStates = vi.fn(async () => ({voiceStates: h.voiceStates}));
	h.service = new VoiceSeatService({
		repository: repo,
		instanceConfigRepository: {getVoiceRoomConfig: async () => h.config} as unknown as InstanceConfigRepository,
		channelAuthService: {
			getChannelAuthenticated: async () => ({
				channel: {id: channelId, guildId: GUILD, type: ChannelTypes.GUILD_VOICE, roomTheme: h.theme},
				checkPermission: async () => {},
			}),
		} as unknown as ChannelAuthService,
		gatewayService: {getVoiceStatesForChannel: h.getVoiceStates} as unknown as IGatewayService,
		liveKitService: {setParticipantAttributes: h.attributes} as unknown as ILiveKitService,
	});
	return h;
}

function ctx(h: Harness, userId: UserID, connectionId: string, located = true): VoiceParticipantContext {
	return {
		guildId: GUILD,
		channelId: h.channelId,
		userId,
		connectionId,
		regionId: located ? 'eu' : null,
		serverId: located ? 'eu-1' : null,
	};
}

function lookups(h: Harness, tableSeat: string | null = null) {
	return {roomTheme: async () => h.theme, tableSeat: async () => tableSeat};
}

function present(h: Harness, userId: UserID, connectionId: string) {
	h.voiceStates.push({
		userId: userId.toString(),
		connectionId,
		channelId: h.channelId.toString(),
		regionId: 'eu',
		serverId: 'eu-1',
	});
}

function seatWrites(h: Harness): Array<[string, string]> {
	return h.attributes.mock.calls.map(([p]) => [`user_${p.userId}_${p.connectionId}`, p.attributes['micup.seat']]);
}

const identity = (userId: UserID, connectionId: string) => `user_${userId}_${connectionId}`;

// A themed channel with someone in it has a seat hash; only there does a leave write its tombstone.
const someoneInside = (h: Harness) =>
	h.repo.markPresent(h.channelId, [{identity: identity(createUserID(9n), 'inside'), value: '9|eu|eu-1'}]);

beforeAll(() => {
	registerVoiceSeatMockScripts();
});
useThemeWatchSeats(THEME, WATCH);

afterEach(() => {
	vi.restoreAllMocks();
});

describe('VoiceSeatService voice hooks', () => {
	it('participant_joined with theme seats and writes micup.seat', async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
		expect(h.attributes).toHaveBeenCalledWith({
			userId: ME,
			guildId: GUILD,
			channelId: h.channelId,
			connectionId: 'a',
			regionId: 'eu',
			serverId: 'eu-1',
			attributes: {'micup.seat': LOUNGE[0]},
		});
		expect(await h.repo.joinMark(h.channelId, identity(ME, 'a'))).toBe(`${ME}|eu|eu-1`);
	});

	it('joined while rooms off → nothing written (Ş18)', async () => {
		const h = harness({rooms: false});
		const roomTheme = vi.fn(async () => THEME);
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), {roomTheme, tableSeat: async () => null});
		expect(roomTheme).not.toHaveBeenCalled();
		expect(await h.kv.exists(voiceSeatsKey(h.channelId))).toBe(0);
		expect(h.attributes).not.toHaveBeenCalled();
	});

	it('joined without theme → nothing', async () => {
		for (const theme of [null, 'retired-room']) {
			const h = harness({theme});
			await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
			expect(await h.kv.exists(voiceSeatsKey(h.channelId))).toBe(0);
			expect(h.attributes).not.toHaveBeenCalled();
		}
	});

	it('user with an active table is seated at its table seat (tableSeatFor)', async () => {
		const h = harness({games: true});
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h, 'seat_T01_2'));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe('seat_T01_2');
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), 'seat_T01_2']]);
	});

	it('the table seat lookup is skipped while games are off', async () => {
		const h = harness({games: false});
		const tableSeat = vi.fn(async () => 'seat_T01_2');
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), {roomTheme: async () => THEME, tableSeat});
		expect(tableSeat).not.toHaveBeenCalled();
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
	});

	it('participant_joined for an identity already holding a seat rewrites the attribute without moving it', async () => {
		const h = harness();
		await h.repo.take({
			channelId: h.channelId,
			identity: identity(ME, 'a'),
			userId: ME,
			mode: 'explicit',
			seats: [LOUNGE[3]!],
		});
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[3]);
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), LOUNGE[3]]]);
	});

	it('a held seat absent from the new theme is replaced on auto/join', async () => {
		const h = harness();
		const oldSeat = 'seat_RETIRED_01';
		await h.repo.take({
			channelId: h.channelId,
			identity: identity(ME, 'a'),
			userId: ME,
			mode: 'explicit',
			seats: [oldSeat],
		});
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), LOUNGE[0]]]);

		await h.repo.take({
			channelId: h.channelId,
			identity: identity(ME, 'a'),
			userId: ME,
			mode: 'explicit',
			seats: [oldSeat],
		});
		present(h, ME, 'a');
		h.attributes.mockClear();
		expect(await h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'a', seat: null})).toEqual({
			seat: LOUNGE[0],
		});
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), LOUNGE[0]]]);
	});

	it('a held seat absent from the new theme with the new lounge full: the old attribute is removed once', async () => {
		const h = harness();
		for (const [index, seat] of LOUNGE.entries()) {
			const userId = createUserID(600n + BigInt(index));
			await h.repo.take({
				channelId: h.channelId,
				identity: identity(userId, 'x'),
				userId,
				mode: 'explicit',
				seats: [seat],
			});
			present(h, userId, 'x');
		}
		await h.repo.take({
			channelId: h.channelId,
			identity: identity(ME, 'a'),
			userId: ME,
			mode: 'explicit',
			seats: ['seat_RETIRED_01'],
		});
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBeNull();
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), '']]);
	});

	it('a second connection of a seated user stays standing on join (no attribute)', async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		h.attributes.mockClear();
		await h.service.onParticipantJoined(ctx(h, ME, 'b'), lookups(h));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'b'))).toBeNull();
		expect(h.attributes).not.toHaveBeenCalled();
	});

	it('left releases the seat; no attribute write', async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		h.attributes.mockClear();
		await h.service.onParticipantLeft(ctx(h, ME, 'a'));
		expect(await h.repo.holderOf(h.channelId, LOUNGE[0]!)).toBeNull();
		expect(await h.repo.joinMark(h.channelId, identity(ME, 'a'))).toBeNull();
		expect(h.attributes).not.toHaveBeenCalled();
	});

	it('left releases the seat while rooms are off, and writes nothing to a channel with no seat hash', async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		h.config.rooms_enabled = false;
		await h.service.onParticipantLeft(ctx(h, ME, 'a'));
		expect(await h.repo.holderOf(h.channelId, LOUNGE[0]!)).toBeNull();
		expect(await h.repo.joinMark(h.channelId, identity(ME, 'a'))).toBeNull();
		const empty = harness({rooms: false});
		await empty.service.onParticipantLeft(ctx(empty, ME, 'a'));
		expect(await empty.kv.exists(voiceSeatsKey(empty.channelId))).toBe(0);
	});

	it('a leave from a channel without a room theme writes no tombstone', async () => {
		const h = harness({theme: null});
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		await h.service.onParticipantLeft(ctx(h, ME, 'a'));
		expect(await h.kv.exists(voiceSeatsKey(h.channelId))).toBe(0);
	});

	it('leave before join for the same identity leaves no j: and no seat', async () => {
		const h = harness();
		await someoneInside(h);
		await h.service.onParticipantLeft(ctx(h, ME, 'a'));
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBeNull();
		expect(await h.repo.joinMark(h.channelId, identity(ME, 'a'))).toBeNull();
		expect(h.attributes).not.toHaveBeenCalled();
	});

	it('the leave tombstone lasts 120 s; a join after that seats the identity', async () => {
		const h = harness();
		vi.useFakeTimers({now: 1_000_000, toFake: ['Date']});
		try {
			await someoneInside(h);
			await h.service.onParticipantLeft(ctx(h, ME, 'a'));
			vi.setSystemTime(1_000_000 + 119_000);
			await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
			expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBeNull();
			vi.setSystemTime(1_000_000 + 121_000);
			await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
			expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("page reload: the old identity's left hands the seat to the new identity and writes its attribute", async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'old'), lookups(h));
		await h.service.onParticipantJoined(ctx(h, ME, 'new'), lookups(h));
		h.attributes.mockClear();
		await h.service.onParticipantLeft(ctx(h, ME, 'old'));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'new'))).toBe(LOUNGE[0]);
		expect(seatWrites(h)).toEqual([[identity(ME, 'new'), LOUNGE[0]]]);
	});

	it('full room auto-seat reconciles stale holders at most once per 30 s per channel', async () => {
		const h = harness();
		for (const [index, seat] of LOUNGE.entries()) {
			const userId = createUserID(100n + BigInt(index));
			await h.repo.take({
				channelId: h.channelId,
				identity: identity(userId, 'x'),
				userId,
				mode: 'explicit',
				seats: [seat],
			});
			if (index > 0) present(h, userId, 'x');
		}
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);

		await h.service.onParticipantJoined(ctx(h, OTHER, 'b'), lookups(h));
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
		expect(await h.repo.seatOf(h.channelId, identity(OTHER, 'b'))).toBeNull();
	});

	it('the full-room reconcile reads every lounge seat holder in one KV call', async () => {
		const h = harness();
		for (const [index, seat] of LOUNGE.entries()) {
			const userId = createUserID(500n + BigInt(index));
			await h.repo.take({
				channelId: h.channelId,
				identity: identity(userId, 'x'),
				userId,
				mode: 'explicit',
				seats: [seat],
			});
			present(h, userId, 'x');
		}
		const holderOf = vi.spyOn(h.repo, 'holderOf');
		h.kv.evalScriptSpy.mockClear();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
		expect(holderOf).not.toHaveBeenCalled();
		expect(h.kv.evalScriptSpy.mock.calls.filter(([command]) => command === 'voiceSeatHolders')).toHaveLength(1);
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBeNull();
	});

	it('regionId/serverId missing → seat kept, attribute skipped with debug log', async () => {
		const h = harness();
		const debug = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'debug');
		await h.service.onParticipantJoined(ctx(h, ME, 'a', false), lookups(h));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
		expect(h.attributes).not.toHaveBeenCalled();
		expect(debug).toHaveBeenCalledWith(expect.anything(), 'voice seat attribute skipped: no LiveKit server');
	});

	it('an aborted join (hook timeout) writes nothing', async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		await expect(h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h), controller.signal)).rejects.toBe(
			controller.signal.reason,
		);
		expect(await h.kv.exists(voiceSeatsKey(h.channelId))).toBe(0);
		expect(h.attributes).not.toHaveBeenCalled();
	});

	it('an aborted leave writes nothing', async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		const controller = new AbortController();
		controller.abort();
		await expect(h.service.onParticipantLeft(ctx(h, ME, 'a'), controller.signal)).rejects.toBe(
			controller.signal.reason,
		);
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
	});

	it('a join aborted during its reconciliation read releases no stale holder', async () => {
		const h = harness();
		for (const [index, seat] of LOUNGE.entries()) {
			const userId = createUserID(400n + BigInt(index));
			await h.repo.take({
				channelId: h.channelId,
				identity: identity(userId, 'x'),
				userId,
				mode: 'explicit',
				seats: [seat],
			});
		}
		const controller = new AbortController();
		h.getVoiceStates.mockImplementationOnce(async () => {
			controller.abort();
			return {voiceStates: []};
		});
		await expect(h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h), controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(await h.repo.holderOf(h.channelId, LOUNGE[0]!)).toBe(identity(createUserID(400n), 'x'));
		expect(h.attributes).not.toHaveBeenCalled();
	});

	it('a hook aborted during its own seat attribute write skips the corrective rewrite', async () => {
		const h = harness();
		const controller = new AbortController();
		h.attributes.mockImplementationOnce(async () => {
			controller.abort();
			await h.repo.take({
				channelId: h.channelId,
				identity: identity(ME, 'a'),
				userId: ME,
				mode: 'explicit',
				seats: [LOUNGE[5]!],
			});
			return 'ok';
		});
		await expect(h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h), controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), LOUNGE[0]]]);
	});

	it('room_finished deletes the seat hash', async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		await h.repo.tryReconcileLock(h.channelId);
		await h.service.onRoomFinished(h.channelId);
		expect(await h.kv.exists(voiceSeatsKey(h.channelId))).toBe(0);
		expect(await h.kv.exists(`${voiceSeatsKey(h.channelId)}:rc`)).toBe(0);
	});
});

describe('VoiceSeatService membership', () => {
	it('membership uses j: with no gateway call', async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.service.membership({guildId: GUILD, channelId: h.channelId, userId: ME, connectionId: 'a'})).toEqual(
			{
				regionId: 'eu',
				serverId: 'eu-1',
			},
		);
		expect(h.getVoiceStates).not.toHaveBeenCalled();
	});

	it('missing j: falls back to voice states at most once per 30 s per channel and self-heals j:', async () => {
		const h = harness();
		present(h, ME, 'a');
		const membership = (userId: UserID, connectionId: string) =>
			h.service.membership({guildId: GUILD, channelId: h.channelId, userId, connectionId});
		expect(await membership(ME, 'a')).toEqual({regionId: 'eu', serverId: 'eu-1'});
		expect(await h.repo.joinMark(h.channelId, identity(ME, 'a'))).toBe(`${ME}|eu|eu-1`);
		present(h, OTHER, 'b');
		expect(await membership(OTHER, 'b')).toBeNull();
		expect(await membership(ME, 'a')).toEqual({regionId: 'eu', serverId: 'eu-1'});
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
	});

	const membershipOf = (h: Harness, userId: UserID, connectionId: string) =>
		h.service.membership({guildId: GUILD, channelId: h.channelId, userId, connectionId});
	const THIRD: UserID = createUserID(9n);

	it('switch turned on with people already in voice: the first fallback read marks every present connection, the next member needs no gateway call', async () => {
		const h = harness({rooms: false});
		for (const [userId, conn] of [
			[ME, 'a'],
			[OTHER, 'b'],
			[THIRD, 'c'],
		] as const) {
			present(h, userId, conn);
			await h.service.onParticipantJoined(ctx(h, userId, conn), lookups(h));
		}
		expect(await h.kv.exists(voiceSeatsKey(h.channelId))).toBe(0);
		h.config.rooms_enabled = true;
		expect(await membershipOf(h, ME, 'a')).toEqual({regionId: 'eu', serverId: 'eu-1'});
		expect(await membershipOf(h, OTHER, 'b')).toEqual({regionId: 'eu', serverId: 'eu-1'});
		expect(await membershipOf(h, THIRD, 'c')).toEqual({regionId: 'eu', serverId: 'eu-1'});
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
	});

	it('a theme set with people already in voice: the first fallback read marks every present connection', async () => {
		const h = harness({theme: null});
		for (const [userId, conn] of [
			[ME, 'a'],
			[OTHER, 'b'],
		] as const) {
			present(h, userId, conn);
			await h.service.onParticipantJoined(ctx(h, userId, conn), lookups(h));
		}
		h.theme = THEME;
		expect(await membershipOf(h, OTHER, 'b')).not.toBeNull();
		expect(await membershipOf(h, ME, 'a')).not.toBeNull();
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
	});

	it('switch off and on: connections that joined while it was off get their marks on the first fallback read', async () => {
		const h = harness();
		present(h, ME, 'a');
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		h.config.rooms_enabled = false;
		for (const [userId, conn] of [
			[OTHER, 'b'],
			[THIRD, 'c'],
		] as const) {
			present(h, userId, conn);
			await h.service.onParticipantJoined(ctx(h, userId, conn), lookups(h));
		}
		h.config.rooms_enabled = true;
		expect(await membershipOf(h, OTHER, 'b')).not.toBeNull();
		expect(await membershipOf(h, THIRD, 'c')).not.toBeNull();
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
	});

	it("the fallback repair keeps a present connection's existing j: mark, writes no l: and no seat", async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		h.voiceStates.push({userId: ME.toString(), connectionId: 'a', channelId: h.channelId.toString(), regionId: 'us'});
		present(h, OTHER, 'b');
		expect(await membershipOf(h, OTHER, 'b')).not.toBeNull();
		expect(await h.repo.joinMark(h.channelId, identity(ME, 'a'))).toBe(`${ME}|eu|eu-1`);
		expect(await h.kv.hget(voiceSeatsKey(h.channelId), `l:${OTHER}`)).toBeNull();
		expect(await h.repo.seatOf(h.channelId, identity(OTHER, 'b'))).toBeNull();
	});

	it('the fallback repair skips a connection with a leave tombstone', async () => {
		const h = harness();
		await someoneInside(h);
		await h.service.onParticipantLeft(ctx(h, OTHER, 'b'));
		present(h, OTHER, 'b');
		present(h, ME, 'a');
		expect(await membershipOf(h, ME, 'a')).not.toBeNull();
		expect(await h.repo.joinMark(h.channelId, identity(OTHER, 'b'))).toBeNull();
	});

	it('the fallback repair writes a large channel in chunks of 500', async () => {
		const h = harness();
		for (let i = 0; i < 1200; i++) present(h, createUserID(10_000n + BigInt(i)), 'x');
		h.kv.evalScriptSpy.mockClear();
		expect(await membershipOf(h, createUserID(10_000n), 'x')).not.toBeNull();
		expect(h.kv.evalScriptSpy.mock.calls.filter(([command]) => command === 'voiceSeatMark')).toHaveLength(3);
		expect(await membershipOf(h, createUserID(11_199n), 'x')).not.toBeNull();
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
	});

	it('a connection that is not in the channel is not a member', async () => {
		const h = harness();
		present(h, OTHER, 'a');
		expect(
			await h.service.membership({guildId: GUILD, channelId: h.channelId, userId: ME, connectionId: 'a'}),
		).toBeNull();
	});
});

describe('VoiceSeatService REST seat', () => {
	it('inherits the instance default for joins and explicit seat claims', async () => {
		const h = harness({theme: null});
		h.config.default_room_theme = THEME;
		present(h, ME, 'a');
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
		expect(await h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'a', seat: LOUNGE[1]!})).toEqual(
			{seat: LOUNGE[1]},
		);
	});

	it('leaving a table returns to the inherited lounge', async () => {
		const h = harness({games: true});
		present(h, ME, 'a');
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		await h.service.seatAtTable({
			userId: ME,
			guildId: GUILD,
			channelId: h.channelId,
			slot: 'T01',
			position: 2,
			voiceStates: h.voiceStates,
		});
		h.theme = null;
		h.config.default_room_theme = THEME;
		await h.service.leaveTableSeat({userId: ME, guildId: GUILD, channelId: h.channelId, voiceStates: h.voiceStates});
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
	});

	it('a missing channel lookup does not inherit a room or write a seat', async () => {
		const h = harness({theme: null});
		h.config.default_room_theme = THEME;
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), {
			roomTheme: async () => undefined,
			tableSeat: async () => null,
		});
		expect(await h.kv.exists(voiceSeatsKey(h.channelId))).toBe(0);
		expect(h.attributes).not.toHaveBeenCalled();
	});

	it('explicit none rejects seats even with an instance default', async () => {
		const h = harness({theme: 'none'});
		h.config.default_room_theme = THEME;
		present(h, ME, 'a');
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.kv.exists(voiceSeatsKey(h.channelId))).toBe(0);
		await expect(
			h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'a', seat: LOUNGE[0]!}),
		).rejects.toMatchObject({code: 'VOICE_SEAT_UNKNOWN'});
	});

	async function joined(h: Harness, userId: UserID, connectionId: string) {
		present(h, userId, connectionId);
		await h.service.onParticipantJoined(ctx(h, userId, connectionId), lookups(h));
	}

	const pick = (h: Harness, seat: string) =>
		h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'a', seat});

	it('explicit pick of a seat held by an identity without j: frees it when the voice states do not list it, or while the 30 s lock is held', async () => {
		const h = harness();
		await joined(h, ME, 'a');
		const ghost = (connectionId: string, seat: string) =>
			h.repo.take({
				channelId: h.channelId,
				identity: identity(OTHER, connectionId),
				userId: OTHER,
				mode: 'explicit',
				seats: [seat],
			});
		await ghost('ghost', LOUNGE[2]!);
		expect(await pick(h, LOUNGE[2]!)).toEqual({seat: LOUNGE[2]});
		expect(await h.repo.seatOf(h.channelId, identity(OTHER, 'ghost'))).toBeNull();
		await ghost('ghost-2', LOUNGE[3]!);
		expect(await pick(h, LOUNGE[3]!)).toEqual({seat: LOUNGE[3]});
		expect(await h.repo.seatOf(h.channelId, identity(OTHER, 'ghost-2'))).toBeNull();
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
	});

	it('a holder without j: but present in voice states keeps its seat', async () => {
		const h = harness();
		await joined(h, ME, 'a');
		present(h, OTHER, 'b');
		await h.repo.take({
			channelId: h.channelId,
			identity: identity(OTHER, 'b'),
			userId: OTHER,
			mode: 'explicit',
			seats: [LOUNGE[2]!],
		});
		await expect(pick(h, LOUNGE[2]!)).rejects.toMatchObject({code: 'VOICE_SEAT_TAKEN'});
		expect(await h.repo.seatOf(h.channelId, identity(OTHER, 'b'))).toBe(LOUNGE[2]);
	});

	it("a released ghost holder's seat attribute is cleared once", async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, OTHER, 'gone'), lookups(h));
		await h.service.takeSeat({userId: OTHER, channelId: h.channelId, connectionId: 'gone', seat: LOUNGE[2]!});
		await joined(h, ME, 'a');
		h.attributes.mockClear();
		expect(await pick(h, LOUNGE[2]!)).toEqual({seat: LOUNGE[2]});
		expect(seatWrites(h)).toEqual([
			[identity(OTHER, 'gone'), ''],
			[identity(ME, 'a'), LOUNGE[2]],
		]);
	});

	it('explicit pick of a seat whose holder is gone from voice states frees it and seats me', async () => {
		const h = harness();
		await h.service.onParticipantJoined(ctx(h, OTHER, 'gone'), lookups(h));
		await h.service.takeSeat({userId: OTHER, channelId: h.channelId, connectionId: 'gone', seat: LOUNGE[2]!});
		await joined(h, ME, 'a');
		expect(await pick(h, LOUNGE[2]!)).toEqual({seat: LOUNGE[2]});
		expect(await h.repo.joinMark(h.channelId, identity(OTHER, 'gone'))).toBeNull();
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
	});

	it('explicit pick of a seat whose holder is in voice, or while the 30 s lock is held → VOICE_SEAT_TAKEN', async () => {
		const h = harness();
		await joined(h, OTHER, 'b');
		await h.service.takeSeat({userId: OTHER, channelId: h.channelId, connectionId: 'b', seat: LOUNGE[2]!});
		await joined(h, ME, 'a');
		await expect(pick(h, LOUNGE[2]!)).rejects.toMatchObject({code: 'VOICE_SEAT_TAKEN'});
		h.voiceStates.splice(0, h.voiceStates.length);
		await expect(pick(h, LOUNGE[2]!)).rejects.toMatchObject({code: 'VOICE_SEAT_TAKEN'});
		expect(h.getVoiceStates).toHaveBeenCalledTimes(1);
		expect(await h.repo.seatOf(h.channelId, identity(OTHER, 'b'))).toBe(LOUNGE[2]);
	});

	it('second connection of a seated user stays standing on auto and takes over on explicit move, clearing the old attribute once', async () => {
		const h = harness();
		await joined(h, ME, 'a');
		await joined(h, ME, 'b');
		h.attributes.mockClear();
		expect(await h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'b', seat: null})).toEqual({
			seat: null,
		});
		expect(h.attributes).not.toHaveBeenCalled();
		expect(await h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'b', seat: LOUNGE[2]!})).toEqual(
			{
				seat: LOUNGE[2],
			},
		);
		expect(seatWrites(h)).toEqual([
			[identity(ME, 'b'), LOUNGE[2]],
			[identity(ME, 'a'), ''],
		]);
	});

	it('REST fallback with user_elsewhere and the other identity gone from voice states takes over', async () => {
		const h = harness();
		await joined(h, ME, 'old');
		await joined(h, ME, 'new');
		h.voiceStates.splice(0, h.voiceStates.length);
		present(h, ME, 'new');
		h.attributes.mockClear();
		expect(await h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'new', seat: null})).toEqual({
			seat: LOUNGE[0],
		});
		expect(await h.repo.joinMark(h.channelId, identity(ME, 'old'))).toBeNull();
		expect(seatWrites(h)).toEqual([[identity(ME, 'new'), LOUNGE[0]]]);
	});

	it('PUT seat_T01_Y2 seats me and writes micup.seat', async () => {
		const h = harness({games: true});
		await joined(h, ME, 'a');
		h.attributes.mockClear();
		expect(await pick(h, WATCH[1]!)).toEqual({seat: WATCH[1]});
		expect(await h.repo.holderOf(h.channelId, LOUNGE[0]!)).toBeNull();
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), WATCH[1]]]);
	});

	it('a held watch seat survives a duplicate join webhook and a null-seat PUT', async () => {
		const h = harness({games: true});
		await joined(h, ME, 'a');
		await pick(h, WATCH[0]!);
		h.attributes.mockClear();
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		expect(await h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'a', seat: null})).toEqual({
			seat: WATCH[0],
		});
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(WATCH[0]);
		expect(seatWrites(h)).toEqual([
			[identity(ME, 'a'), WATCH[0]],
			[identity(ME, 'a'), WATCH[0]],
		]);
	});

	// Watch seats are the table games'; while games are off they are no seat of the room, picked or not.
	it('while games are off an explicit watch seat pick → VOICE_SEAT_UNKNOWN', async () => {
		const h = harness();
		await joined(h, ME, 'a');
		await expect(pick(h, WATCH[0]!)).rejects.toMatchObject({code: 'VOICE_SEAT_UNKNOWN'});
		expect(await h.repo.holderOf(h.channelId, WATCH[0]!)).toBeNull();
		h.config.games_enabled = true;
		expect(await pick(h, WATCH[0]!)).toEqual({seat: WATCH[0]});
	});

	// The channel budget bounds what reaches the whole room, so only a real seat change spends it.
	// The frozen clock keeps the 1 s window open.
	describe('channel seat change budget', () => {
		const THIRD = createUserID(10n);
		const limit = VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW;

		beforeEach(() => {
			vi.useFakeTimers({toFake: ['Date']});
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		// Moves me between LOUNGE[0] and LOUNGE[1] `count` times, starting from LOUNGE[0].
		async function changes(h: Harness, count: number) {
			for (let i = 1; i <= count; i++) {
				const seat = LOUNGE[i % 2]!;
				expect(await pick(h, seat)).toEqual({seat});
			}
		}

		it('same/taken/full never spend the channel budget', async () => {
			const h = harness();
			for (const [index, seat] of LOUNGE.slice(2).entries()) {
				const userId = createUserID(300n + BigInt(index));
				present(h, userId, 'x');
				await h.repo.markPresent(h.channelId, [{identity: identity(userId, 'x'), value: `${userId}|eu|eu-1`}]);
				await h.repo.take({
					channelId: h.channelId,
					identity: identity(userId, 'x'),
					userId,
					mode: 'explicit',
					seats: [seat],
				});
			}
			await joined(h, ME, 'a');
			await joined(h, OTHER, 'b');
			await joined(h, THIRD, 'c');
			expect(await h.repo.seatOf(h.channelId, identity(THIRD, 'c'))).toBeNull(); // the lounge is full
			for (let i = 0; i < limit; i++) {
				expect(await pick(h, LOUNGE[0]!)).toEqual({seat: LOUNGE[0]});
				await expect(pick(h, LOUNGE[1]!)).rejects.toMatchObject({code: 'VOICE_SEAT_TAKEN'});
				expect(
					await h.service.takeSeat({userId: THIRD, channelId: h.channelId, connectionId: 'c', seat: null}),
				).toEqual({seat: null});
			}
			await h.repo.release({channelId: h.channelId, identity: identity(OTHER, 'b'), userId: OTHER});
			await changes(h, limit);
			await expect(pick(h, LOUNGE[(limit + 1) % 2]!)).rejects.toBeInstanceOf(RateLimitError);
		});

		it('20 real changes then 429', async () => {
			const h = harness();
			await joined(h, ME, 'a');
			await changes(h, limit);
			const next = LOUNGE[(limit + 1) % 2]!;
			await expect(pick(h, next)).rejects.toBeInstanceOf(RateLimitError);
			expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[limit % 2]);
			vi.setSystemTime(Date.now() + VOICE_SEAT_CHANNEL_WINDOW_S * 1000);
			expect(await pick(h, next)).toEqual({seat: next});
		});
	});

	it('two quick seat requests: the final attribute matches p:<identity>', async () => {
		const h = harness();
		await joined(h, ME, 'a');
		h.attributes.mockClear();
		let releaseFirst: () => void = () => {};
		h.attributes.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseFirst = () => resolve('ok');
				}),
		);
		const first = h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'a', seat: LOUNGE[4]!});
		await vi.waitFor(() => expect(h.attributes).toHaveBeenCalledTimes(1));
		await h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'a', seat: LOUNGE[5]!});
		releaseFirst();
		await first;
		const writes = seatWrites(h);
		expect(writes.at(-1)).toEqual([identity(ME, 'a'), LOUNGE[5]]);
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[5]);
	});
});

describe('VoiceSeatService table seats', () => {
	it('seatAtTable moves the player to the table seat and frees the lounge seat', async () => {
		const h = harness({games: true});
		present(h, ME, 'a');
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		h.attributes.mockClear();
		await h.service.seatAtTable({
			userId: ME,
			guildId: GUILD,
			channelId: h.channelId,
			slot: 'T01',
			position: 2,
			voiceStates: h.voiceStates,
		});
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe('seat_T01_2');
		expect(await h.repo.holderOf(h.channelId, LOUNGE[0]!)).toBeNull();
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), 'seat_T01_2']]);
	});

	it('seatAtTable clears a stale holder of the table seat', async () => {
		const h = harness({games: true});
		const stale = identity(OTHER, 'gone');
		await h.repo.take({
			channelId: h.channelId,
			identity: stale,
			userId: OTHER,
			mode: 'explicit',
			seats: ['seat_T01_2'],
		});
		present(h, ME, 'a');
		await h.service.seatAtTable({
			userId: ME,
			guildId: GUILD,
			channelId: h.channelId,
			slot: 'T01',
			position: 2,
			voiceStates: h.voiceStates,
		});
		expect(await h.repo.holderOf(h.channelId, 'seat_T01_2')).toBe(identity(ME, 'a'));
		expect(await h.repo.seatOf(h.channelId, stale)).toBeNull();
	});

	it('leaveTableSeat returns the player to a free lounge seat, or standing when the lounge is full', async () => {
		const h = harness({games: true});
		present(h, ME, 'a');
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		await h.service.seatAtTable({
			userId: ME,
			guildId: GUILD,
			channelId: h.channelId,
			slot: 'T01',
			position: 2,
			voiceStates: h.voiceStates,
		});
		h.attributes.mockClear();
		await h.service.leaveTableSeat({userId: ME, guildId: GUILD, channelId: h.channelId, voiceStates: null});
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'a'))).toBe(LOUNGE[0]);
		expect(seatWrites(h)).toEqual([[identity(ME, 'a'), LOUNGE[0]]]);

		const full = harness({games: true});
		for (const [index, seat] of LOUNGE.entries()) {
			const userId = createUserID(300n + BigInt(index));
			await full.repo.take({
				channelId: full.channelId,
				identity: identity(userId, 'x'),
				userId,
				mode: 'explicit',
				seats: [seat],
			});
		}
		present(full, ME, 'a');
		await full.repo.markPresent(full.channelId, [{identity: identity(ME, 'a'), value: `${ME}|eu|eu-1`}]);
		await full.service.seatAtTable({
			userId: ME,
			guildId: GUILD,
			channelId: full.channelId,
			slot: 'T01',
			position: 1,
			voiceStates: full.voiceStates,
		});
		full.attributes.mockClear();
		await full.service.leaveTableSeat({
			userId: ME,
			guildId: GUILD,
			channelId: full.channelId,
			voiceStates: full.voiceStates,
		});
		expect(await full.repo.seatOf(full.channelId, identity(ME, 'a'))).toBeNull();
		expect(seatWrites(full)).toEqual([[identity(ME, 'a'), '']]);
	});

	it('leaveTableSeat for an identity without j: only vacates the table seat', async () => {
		const h = harness({games: true});
		await h.repo.take({
			channelId: h.channelId,
			identity: identity(ME, 'gone'),
			userId: ME,
			mode: 'explicit',
			seats: ['seat_T01_2'],
		});
		await h.service.leaveTableSeat({userId: ME, guildId: GUILD, channelId: h.channelId, voiceStates: null});
		expect(await h.repo.seatOf(h.channelId, identity(ME, 'gone'))).toBeNull();
		expect(await h.repo.holderOf(h.channelId, LOUNGE[0]!)).toBeNull();
		expect(h.attributes).not.toHaveBeenCalled();
	});

	it('an explicit lounge move while seated at a table → TABLE_GAME_CONFLICT', async () => {
		const h = harness({games: true});
		present(h, ME, 'a');
		await h.service.onParticipantJoined(ctx(h, ME, 'a'), lookups(h));
		await h.service.seatAtTable({
			userId: ME,
			guildId: GUILD,
			channelId: h.channelId,
			slot: 'T01',
			position: 2,
			voiceStates: h.voiceStates,
		});
		await expect(
			h.service.takeSeat({userId: ME, channelId: h.channelId, connectionId: 'a', seat: LOUNGE[1]!}),
		).rejects.toMatchObject({code: 'TABLE_GAME_CONFLICT'});
	});
});
