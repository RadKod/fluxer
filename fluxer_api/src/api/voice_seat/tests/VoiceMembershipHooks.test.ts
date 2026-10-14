// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {ChannelAuthService} from '@app/api/channel/services/channel_data/ChannelAuthService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ILiveKitService} from '@app/api/infrastructure/ILiveKitService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {registerVoiceSeatMockScripts} from '@app/api/voice_seat/tests/VoiceSeatMockScripts';
import {createVoiceMembershipHooks, type VoiceMembershipHookServices} from '@app/api/voice_seat/VoiceMembershipHooks';
import {VoiceSeatRepository, voiceSeatsKey} from '@app/api/voice_seat/VoiceSeatRepository';
import {type VoiceParticipantContext, VoiceSeatService} from '@app/api/voice_seat/VoiceSeatService';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const CTX: VoiceParticipantContext = {
	guildId: createGuildID(1n),
	channelId: createChannelID(2n),
	userId: createUserID(3n),
	connectionId: 'conn',
	regionId: 'eu',
	serverId: 'eu-1',
};

function fakeServices(overrides: Partial<{games: boolean}> = {}) {
	const seat = {
		onParticipantJoined: vi.fn<VoiceSeatService['onParticipantJoined']>(async () => {}),
		onParticipantLeft: vi.fn(async () => {}),
		onVoiceStateRemoved: vi.fn(async () => {}),
		onRoomFinished: vi.fn(async () => {}),
	};
	const table = {
		onVoiceJoined: vi.fn(async () => {}),
		onVoiceLeft: vi.fn(async () => {}),
		tableSeatFor: vi.fn(async () => null),
	};
	const config = {
		rooms_enabled: true,
		games_enabled: overrides.games ?? true,
		room_cameras_enabled: false,
		default_room_theme: null,
	};
	const services: VoiceMembershipHookServices = {
		voiceSeatService: () => seat as unknown as VoiceSeatService,
		tableGameService: () => table as unknown as ReturnType<VoiceMembershipHookServices['tableGameService']>,
		channelRepository: () => ({
			findUnique: async () => ({roomTheme: VOICE_ROOM_THEME_IDS[0], type: ChannelTypes.GUILD_VOICE}),
		}),
		instanceConfigRepository: () => ({getVoiceRoomConfig: async () => config}),
	};
	return {seat, table, services};
}

beforeAll(() => {
	registerVoiceSeatMockScripts();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('VoiceMembershipHooks', () => {
	it.each([ChannelTypes.DM, ChannelTypes.GROUP_DM, ChannelTypes.GUILD_TEXT])(
		'channel type %s cannot inherit room seating from a join hook',
		async (type) => {
			const {seat, services} = fakeServices();
			services.channelRepository = () => ({findUnique: async () => ({roomTheme: null, type})});
			await createVoiceMembershipHooks(services).onJoined(CTX);
			await vi.waitFor(() => expect(seat.onParticipantJoined).toHaveBeenCalledTimes(1));
			expect(await seat.onParticipantJoined.mock.calls[0]![1].roomTheme()).toBeUndefined();
		},
	);

	it('a deleted channel lookup stays distinct from an inherited theme', async () => {
		const {seat, services} = fakeServices();
		services.channelRepository = () => ({findUnique: async () => null});
		await createVoiceMembershipHooks(services).onJoined(CTX);
		await vi.waitFor(() => expect(seat.onParticipantJoined).toHaveBeenCalledTimes(1));
		expect(await seat.onParticipantJoined.mock.calls[0]![1].roomTheme()).toBeUndefined();
	});

	it('onJoined returns while the seat work is still running, and the table service hears about the join', async () => {
		const {seat, table, services} = fakeServices();
		seat.onParticipantJoined.mockImplementation(() => new Promise(() => {}));
		await createVoiceMembershipHooks(services, {concurrency: 64, timeoutMs: 50}).onJoined(CTX);
		expect(seat.onParticipantJoined).toHaveBeenCalledWith(CTX, expect.anything(), expect.any(AbortSignal));
		await vi.waitFor(() =>
			expect(table.onVoiceJoined).toHaveBeenCalledWith({
				userId: CTX.userId,
				guildId: CTX.guildId,
				channelId: CTX.channelId,
			}),
		);
	});

	it('a failing seat write does not keep the table service from hearing about the join', async () => {
		const {seat, table, services} = fakeServices();
		seat.onParticipantJoined.mockRejectedValueOnce(new Error('livekit down'));
		await createVoiceMembershipHooks(services).onJoined(CTX);
		await vi.waitFor(() => expect(table.onVoiceJoined).toHaveBeenCalledTimes(1));
	});

	it('onLeft from the webhook releases the seat and tells the table service', async () => {
		const {seat, table, services} = fakeServices();
		await createVoiceMembershipHooks(services).onLeft(CTX, 'webhook');
		await vi.waitFor(() => expect(table.onVoiceLeft).toHaveBeenCalledTimes(1));
		expect(seat.onParticipantLeft).toHaveBeenCalledWith(CTX, expect.any(AbortSignal));
	});

	it('onLeft from the rpc drops the j: mark before the pool, tells the table service and leaves the seat to the webhook', async () => {
		const {seat, table, services} = fakeServices();
		await createVoiceMembershipHooks(services, {concurrency: 0, timeoutMs: 50}).onLeft(CTX, 'rpc');
		expect(seat.onVoiceStateRemoved).toHaveBeenCalledWith(CTX);
		expect(table.onVoiceLeft).not.toHaveBeenCalled();
		seat.onVoiceStateRemoved.mockRejectedValueOnce(new Error('kv down'));
		await createVoiceMembershipHooks(services).onLeft(CTX, 'rpc');
		await vi.waitFor(() =>
			expect(table.onVoiceLeft).toHaveBeenCalledWith({
				userId: CTX.userId,
				guildId: CTX.guildId,
				channelId: CTX.channelId,
			}),
		);
		expect(seat.onParticipantLeft).not.toHaveBeenCalled();
	});

	it('table hooks are skipped while games are off', async () => {
		const {seat, table, services} = fakeServices({games: false});
		const hooks = createVoiceMembershipHooks(services);
		await hooks.onJoined(CTX);
		await hooks.onLeft(CTX, 'webhook');
		await vi.waitFor(() => expect(seat.onParticipantLeft).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(table.onVoiceJoined).not.toHaveBeenCalled();
		expect(table.onVoiceLeft).not.toHaveBeenCalled();
	});

	it('onRoomFinished drops the channel seat state', async () => {
		const {seat, services} = fakeServices();
		await createVoiceMembershipHooks(services).onRoomFinished(CTX.channelId);
		await vi.waitFor(() => expect(seat.onRoomFinished).toHaveBeenCalledWith(CTX.channelId));
	});

	it('65th concurrent hook is dropped with a warning and no payload', async () => {
		const {seat, services} = fakeServices({games: false});
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		seat.onParticipantJoined.mockImplementation(() => gate);
		const warn = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
		const hooks = createVoiceMembershipHooks(services);
		for (let i = 0; i < 64; i++) await hooks.onJoined({...CTX, connectionId: `c${i}`});
		await vi.waitFor(() => expect(seat.onParticipantJoined).toHaveBeenCalledTimes(64));
		expect(warn).not.toHaveBeenCalled();
		await hooks.onJoined({...CTX, connectionId: 'c64'});
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith({hook: 'joined', hung: 0}, 'voice membership hook dropped');
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(seat.onParticipantJoined).toHaveBeenCalledTimes(64);
		open();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await hooks.onJoined({...CTX, connectionId: 'after'});
		await vi.waitFor(() => expect(seat.onParticipantJoined).toHaveBeenCalledTimes(65));
	});

	it('a timed-out hook keeps its slot until its work settles', async () => {
		const {seat, services} = fakeServices({games: false});
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		let firstSignal: AbortSignal | undefined;
		seat.onParticipantJoined.mockImplementationOnce(async (_ctx, _lookups, signal?: AbortSignal) => {
			firstSignal = signal;
			await gate;
		});
		const warn = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
		const hooks = createVoiceMembershipHooks(services, {concurrency: 1, timeoutMs: 20});
		await hooks.onJoined(CTX);
		await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
		await hooks.onJoined({...CTX, connectionId: 'second'});
		expect(seat.onParticipantJoined).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith({hook: 'joined', hung: 1}, 'voice membership hook dropped');
		open();
		await new Promise((resolve) => setTimeout(resolve, 10));
		await hooks.onJoined({...CTX, connectionId: 'third'});
		await vi.waitFor(() => expect(seat.onParticipantJoined).toHaveBeenCalledTimes(2));
	});

	it('a hook timeout leaves no half-written seat', async () => {
		const kv = new MockKVProvider();
		const attributes = vi.fn(async () => 'ok' as const);
		const voiceSeatService = new VoiceSeatService({
			repository: new VoiceSeatRepository(kv),
			instanceConfigRepository: {
				getVoiceRoomConfig: async () => ({rooms_enabled: true, games_enabled: false}),
			} as unknown as InstanceConfigRepository,
			channelAuthService: {} as ChannelAuthService,
			gatewayService: {} as IGatewayService,
			liveKitService: {setParticipantAttributes: attributes} as unknown as ILiveKitService,
		});
		let channelRead = false;
		const {services} = fakeServices({games: false});
		const hooks = createVoiceMembershipHooks(
			{
				...services,
				voiceSeatService: () => voiceSeatService,
				channelRepository: () => ({
					findUnique: async () => {
						await new Promise((resolve) => setTimeout(resolve, 60));
						channelRead = true;
						return {roomTheme: VOICE_ROOM_THEME_IDS[0], type: ChannelTypes.GUILD_VOICE};
					},
				}),
			},
			{concurrency: 64, timeoutMs: 20},
		);
		await hooks.onJoined(CTX);
		await vi.waitFor(() => expect(channelRead).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(await kv.exists(voiceSeatsKey(CTX.channelId))).toBe(0);
		expect(attributes).not.toHaveBeenCalled();
	});
});
