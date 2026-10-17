// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {ChannelAuthService} from '@app/api/channel/services/channel_data/ChannelAuthService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ILiveKitService} from '@app/api/infrastructure/ILiveKitService';
import type {IVoiceRoomStore} from '@app/api/infrastructure/IVoiceRoomStore';
import {LiveKitService, SERVER_MUTE_ATTRIBUTE} from '@app/api/infrastructure/LiveKitService';
import {LiveKitWebhookService} from '@app/api/infrastructure/LiveKitWebhookService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import type {VoiceRepository} from '@app/api/voice/VoiceRepository';
import {VoiceTopology} from '@app/api/voice/VoiceTopology';
import {registerVoiceSeatMockScripts} from '@app/api/voice_seat/tests/VoiceSeatMockScripts';
import {createVoiceMembershipHooks, type VoiceMembershipHooks} from '@app/api/voice_seat/VoiceMembershipHooks';
import {VoiceSeatRepository} from '@app/api/voice_seat/VoiceSeatRepository';
import {VoiceSeatService} from '@app/api/voice_seat/VoiceSeatService';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {TrackSource, type WebhookEvent} from 'livekit-server-sdk';
import {describe, expect, it, vi} from 'vitest';

const GUILD_ID = createGuildID(1n);
const CHANNEL_ID = createChannelID(2n);

function roomFinished(name: string): WebhookEvent {
	return {
		event: 'room_finished',
		room: {name, sid: 'RM_test', emptyTimeout: 300, creationTime: 0n},
	} as unknown as WebhookEvent;
}

function fakeHooks() {
	return {
		onJoined: vi.fn(async () => {}),
		onLeft: vi.fn(async () => {}),
		onRoomFinished: vi.fn(async () => {}),
	} satisfies typeof VoiceMembershipHooks;
}

function harness(pinnedServerId: string | null) {
	const deleteRoomServer = vi.fn(async () => {});
	const voiceRoomStore = {
		getPinnedRoomServer: vi.fn(async () => (pinnedServerId ? {regionId: 'eu', serverId: pinnedServerId} : null)),
		deleteRoomServer,
	} as unknown as IVoiceRoomStore;
	const gatewayService = {} as unknown as IGatewayService;
	const liveKitService = {} as unknown as ILiveKitService;
	const hooks = fakeHooks();
	const service = new LiveKitWebhookService(
		voiceRoomStore,
		gatewayService,
		liveKitService,
		new VoiceTopology({} as unknown as VoiceRepository, null),
		hooks,
	);
	return {service, deleteRoomServer, hooks};
}

describe('LiveKitWebhookService room_finished', () => {
	it('clears the guild pin without disconnecting anybody', async () => {
		const {service, deleteRoomServer, hooks} = harness('eu-1');

		await service.handleRoomFinished(roomFinished(`guild_${GUILD_ID}_channel_${CHANNEL_ID}`), 'unknown-key');

		expect(deleteRoomServer).toHaveBeenCalledTimes(1);
		expect(hooks.onRoomFinished).toHaveBeenCalledWith(CHANNEL_ID);
	});

	it('clears the pin even when no server is pinned, and still disconnects nobody', async () => {
		const {service, deleteRoomServer} = harness(null);

		await service.handleRoomFinished(roomFinished(`guild_${GUILD_ID}_channel_${CHANNEL_ID}`), 'unknown-key');

		expect(deleteRoomServer).toHaveBeenCalledTimes(1);
	});

	it('ignores a room name it cannot parse', async () => {
		const {service, deleteRoomServer, hooks} = harness('eu-1');

		await service.handleRoomFinished(roomFinished('not_a_voice_room'), 'unknown-key');

		expect(deleteRoomServer).not.toHaveBeenCalled();
		expect(hooks.onRoomFinished).not.toHaveBeenCalled();
	});
});

function participantLeft(tokenNonce: string): WebhookEvent {
	return {
		event: 'participant_left',
		room: {name: `guild_${GUILD_ID}_channel_${CHANNEL_ID}`},
		participant: {
			identity: 'user_3_crayfish-cirius',
			metadata: JSON.stringify({
				user_id: '3',
				channel_id: CHANNEL_ID.toString(),
				guild_id: GUILD_ID.toString(),
				connection_id: 'crayfish-cirius',
				token_nonce: tokenNonce,
				issued_at: '1',
				region_id: 'eu',
				server_id: 'eu-1',
			}),
		},
	} as unknown as WebhookEvent;
}

describe('LiveKitWebhookService participant_left', () => {
	it('tells the gateway which token the leaving connection joined with', async () => {
		const disconnectVoiceUserIfInChannel = vi.fn(async () => ({success: true, ignored: true}));
		const voiceRoomStore = {
			getPinnedRoomServer: vi.fn(async () => ({regionId: 'eu', serverId: 'eu-1'})),
		} as unknown as IVoiceRoomStore;
		const liveKitService = {
			listParticipants: vi.fn(async () => ({status: 'ok', participants: []})),
		} as unknown as ILiveKitService;
		const service = new LiveKitWebhookService(
			voiceRoomStore,
			{disconnectVoiceUserIfInChannel} as unknown as IGatewayService,
			liveKitService,
			new VoiceTopology({} as unknown as VoiceRepository, null),
			fakeHooks(),
		);

		await service.handleParticipantLeft(participantLeft('nonce-a1'));

		expect(disconnectVoiceUserIfInChannel).toHaveBeenCalledWith(
			expect.objectContaining({channelId: CHANNEL_ID, connectionId: 'crayfish-cirius', tokenNonce: 'nonce-a1'}),
		);
	});
});

function participantEvent(
	event: 'participant_joined' | 'participant_left' | 'participant_connection_aborted',
	options: {dm?: boolean; serverId?: string} = {},
): WebhookEvent {
	const metadata: Record<string, string> = {
		user_id: '3',
		channel_id: CHANNEL_ID.toString(),
		connection_id: 'conn',
		token_nonce: 'nonce',
		issued_at: '1',
		region_id: 'eu',
		server_id: options.serverId ?? 'eu-1',
	};
	if (options.dm) metadata['dm_call'] = 'true';
	else metadata['guild_id'] = GUILD_ID.toString();
	return {
		event,
		room: {name: options.dm ? `dm_channel_${CHANNEL_ID}` : `guild_${GUILD_ID}_channel_${CHANNEL_ID}`},
		participant: {identity: 'user_3_conn', metadata: JSON.stringify(metadata)},
	} as unknown as WebhookEvent;
}

const JOINED_CTX = {
	guildId: GUILD_ID,
	channelId: CHANNEL_ID,
	userId: createUserID(3n),
	connectionId: 'conn',
	regionId: 'eu',
	serverId: 'eu-1',
};

function membershipHarness(options: {
	confirm?: {success: boolean; error?: string};
	participants?: Array<{identity: string}> | 'error';
	hooks?: typeof VoiceMembershipHooks;
}) {
	const hooks = options.hooks ?? fakeHooks();
	const disconnectVoiceUserIfInChannel = vi.fn(async () => ({success: true}));
	const disconnectParticipant = vi.fn(async () => {});
	const participants = options.participants ?? [];
	const service = new LiveKitWebhookService(
		{getPinnedRoomServer: vi.fn(async () => ({regionId: 'eu', serverId: 'eu-1'}))} as unknown as IVoiceRoomStore,
		{
			confirmVoiceConnection: vi.fn(async () => options.confirm ?? {success: true}),
			disconnectVoiceUserIfInChannel,
		} as unknown as IGatewayService,
		{
			disconnectParticipant,
			listParticipants: vi.fn(async () =>
				participants === 'error'
					? {status: 'error', errorCode: 'unavailable', retryable: true}
					: {status: 'ok', participants},
			),
		} as unknown as ILiveKitService,
		new VoiceTopology({} as unknown as VoiceRepository, null),
		hooks,
	);
	return {service, hooks, disconnectVoiceUserIfInChannel, disconnectParticipant};
}

describe('LiveKitWebhookService voice membership hooks', () => {
	it('confirmed join calls VoiceMembershipHooks.onJoined after confirm', async () => {
		const {service, hooks} = membershipHarness({});
		await service.handleParticipantJoined(participantEvent('participant_joined'));
		expect(hooks.onJoined).toHaveBeenCalledWith(JOINED_CTX);
	});

	it('rejected join does not call hooks', async () => {
		for (const error of ['connection_not_found', 'nonce_mismatch']) {
			const {service, hooks} = membershipHarness({confirm: {success: false, error}});
			await service.handleParticipantJoined(participantEvent('participant_joined'));
			expect(hooks.onJoined).not.toHaveBeenCalled();
		}
	});

	it('DM calls never reach the seat hooks', async () => {
		const {service, hooks} = membershipHarness({});
		await service.handleParticipantJoined(participantEvent('participant_joined', {dm: true}));
		await service.handleParticipantLeft(participantEvent('participant_left', {dm: true}));
		expect(hooks.onJoined).not.toHaveBeenCalled();
		expect(hooks.onLeft).not.toHaveBeenCalled();
	});

	it('hook failure does not change webhook outcome', async () => {
		const hooks = fakeHooks();
		hooks.onJoined.mockRejectedValue(new Error('boom'));
		hooks.onLeft.mockRejectedValue(new Error('boom'));
		const {service, disconnectVoiceUserIfInChannel} = membershipHarness({hooks});
		await expect(service.handleParticipantJoined(participantEvent('participant_joined'))).resolves.toBeUndefined();
		await expect(service.handleParticipantLeft(participantEvent('participant_left'))).resolves.toBeUndefined();
		expect(disconnectVoiceUserIfInChannel).toHaveBeenCalledTimes(1);
	});

	it('participant_left/aborted call onLeft(webhook)', async () => {
		for (const event of ['participant_left', 'participant_connection_aborted'] as const) {
			const {service, hooks} = membershipHarness({});
			await service.handleParticipantLeft(participantEvent(event));
			expect(hooks.onLeft).toHaveBeenCalledWith(JOINED_CTX, 'webhook');
		}
	});

	it('leave hook still releases when the gateway disconnect throws', async () => {
		const {service, hooks, disconnectVoiceUserIfInChannel} = membershipHarness({});
		disconnectVoiceUserIfInChannel.mockRejectedValueOnce(new Error('gateway down'));
		await service.handleParticipantLeft(participantEvent('participant_left'));
		expect(disconnectVoiceUserIfInChannel).toHaveBeenCalledTimes(1);
		expect(hooks.onLeft).toHaveBeenCalledWith(JOINED_CTX, 'webhook');
	});

	it('stale participant_left (still present) does not release the seat', async () => {
		const {service, hooks} = membershipHarness({participants: [{identity: 'user_3_conn'}]});
		await service.handleParticipantLeft(participantEvent('participant_left'));
		expect(hooks.onLeft).not.toHaveBeenCalled();
	});

	it('unknown presence does not release', async () => {
		const {service, hooks} = membershipHarness({participants: 'error'});
		await service.handleParticipantLeft(participantEvent('participant_left'));
		expect(hooks.onLeft).not.toHaveBeenCalled();
	});

	it('stale-server participant_left does not release', async () => {
		const {service, hooks} = membershipHarness({});
		await service.handleParticipantLeft(participantEvent('participant_left', {serverId: 'eu-old'}));
		expect(hooks.onLeft).not.toHaveBeenCalled();
	});

	it("webhook resolves before the hook's LiveKit call", async () => {
		registerVoiceSeatMockScripts();
		let finishAttributeWrite: () => void = () => {};
		const setParticipantAttributes = vi.fn(
			() =>
				new Promise<'ok'>((resolve) => {
					finishAttributeWrite = () => resolve('ok');
				}),
		);
		const seatService = new VoiceSeatService({
			repository: new VoiceSeatRepository(new MockKVProvider()),
			instanceConfigRepository: {
				getVoiceRoomConfig: async () => ({rooms_enabled: true, games_enabled: false}),
			} as unknown as InstanceConfigRepository,
			channelAuthService: {} as ChannelAuthService,
			gatewayService: {} as IGatewayService,
			liveKitService: {setParticipantAttributes} as unknown as ILiveKitService,
		});
		const hooks = createVoiceMembershipHooks({
			voiceSeatService: () => seatService,
			tableGameService: () => ({
				onVoiceJoined: async () => {},
				onVoiceLeft: async () => {},
				tableSeatFor: async () => null,
			}),
			voiceActivityService: () => ({onRoomFinished: async () => {}}),
			channelRepository: () => ({
				findUnique: async () => ({roomTheme: VOICE_ROOM_THEME_IDS[0], type: ChannelTypes.GUILD_VOICE}),
			}),
			instanceConfigRepository: () => ({
				getVoiceRoomConfig: async () => ({
					rooms_enabled: true,
					games_enabled: false,
					room_cameras_enabled: false,
					default_room_theme: null,
				}),
			}),
		});
		const {service} = membershipHarness({hooks});
		await service.handleParticipantJoined(participantEvent('participant_joined'));
		await vi.waitFor(() => expect(setParticipantAttributes).toHaveBeenCalledTimes(1));
		finishAttributeWrite();
	});
});

function trackPublished(source: TrackSource, attributes: Record<string, string>): WebhookEvent {
	return {
		event: 'track_published',
		room: {name: `guild_${GUILD_ID}_channel_${CHANNEL_ID}`},
		participant: {
			identity: 'user_3_conn-1',
			attributes,
			metadata: JSON.stringify({
				user_id: '3',
				channel_id: CHANNEL_ID.toString(),
				guild_id: GUILD_ID.toString(),
				connection_id: 'conn-1',
				region_id: 'eu',
				server_id: 'eu-1',
				token_nonce: 'nonce',
				issued_at: '0',
			}),
		},
		track: {sid: 'TR_new', source},
	} as unknown as WebhookEvent;
}

describe('LiveKitWebhookService track_published', () => {
	it('does not remute a microphone from a stale publication snapshot after moderator unmute', async () => {
		const participant = {
			identity: 'user_3_conn-1',
			attributes: {[SERVER_MUTE_ATTRIBUTE]: 'true'},
			tracks: [{sid: 'TR_new', source: TrackSource.MICROPHONE, muted: true}],
		};
		const delayedEvent = trackPublished(TrackSource.MICROPHONE, {...participant.attributes});
		const mutePublishedTrack = vi.fn(async (_room: string, _identity: string, _sid: string, muted: boolean) => {
			participant.tracks[0].muted = muted;
		});
		const roomServiceClient = {
			listParticipants: async () => [participant],
			getParticipant: async () => participant,
			updateParticipant: async (_room: string, _identity: string, update: {attributes: Record<string, string>}) => {
				Object.assign(participant.attributes, update.attributes);
				return participant;
			},
			mutePublishedTrack,
		};
		const liveKitService = Object.create(LiveKitService.prototype) as LiveKitService;
		Reflect.set(liveKitService, 'serverClients', new Map([['eu', new Map([['eu-1', {roomServiceClient}]])]]));
		const service = new LiveKitWebhookService(
			{} as unknown as IVoiceRoomStore,
			{} as unknown as IGatewayService,
			liveKitService,
			new VoiceTopology({} as unknown as VoiceRepository, null),
			fakeHooks(),
		);

		await liveKitService.updateParticipant({
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			userId: createUserID(3n),
			connectionId: 'conn-1',
			regionId: 'eu',
			serverId: 'eu-1',
			mute: false,
		});
		expect(participant.attributes[SERVER_MUTE_ATTRIBUTE]).toBe('');
		expect(participant.tracks[0].muted).toBe(false);
		expect(mutePublishedTrack).toHaveBeenCalledWith('guild_1_channel_2', 'user_3_conn-1', 'TR_new', false);
		mutePublishedTrack.mockClear();

		await service.processEvent({event: delayedEvent, apiKey: 'key'});

		expect(mutePublishedTrack).not.toHaveBeenCalled();
		expect(participant.tracks[0].muted).toBe(false);
	});
});

function trackHarness() {
	const muteMicrophoneTrack = vi.fn(async () => {});
	const service = new LiveKitWebhookService(
		{} as unknown as IVoiceRoomStore,
		{} as unknown as IGatewayService,
		{muteMicrophoneTrack} as unknown as ILiveKitService,
		new VoiceTopology({} as unknown as VoiceRepository, null),
		fakeHooks(),
	);
	return {service, muteMicrophoneTrack};
}

describe('LiveKitWebhookService track_published', () => {
	it('mutes a microphone published by a participant the guild has muted', async () => {
		const {service, muteMicrophoneTrack} = trackHarness();

		await service.processEvent({
			event: trackPublished(TrackSource.MICROPHONE, {[SERVER_MUTE_ATTRIBUTE]: 'true'}),
			apiKey: 'key',
		});

		expect(muteMicrophoneTrack).toHaveBeenCalledWith({
			guildId: GUILD_ID,
			channelId: CHANNEL_ID,
			userId: 3n,
			connectionId: 'conn-1',
			regionId: 'eu',
			serverId: 'eu-1',
			trackSid: 'TR_new',
		});
	});

	it('leaves a microphone alone when the participant is not muted by the guild', async () => {
		const {service, muteMicrophoneTrack} = trackHarness();

		await service.processEvent({event: trackPublished(TrackSource.MICROPHONE, {}), apiKey: 'key'});

		expect(muteMicrophoneTrack).not.toHaveBeenCalled();
	});

	it('leaves other track sources alone', async () => {
		const {service, muteMicrophoneTrack} = trackHarness();

		await service.processEvent({
			event: trackPublished(TrackSource.CAMERA, {[SERVER_MUTE_ATTRIBUTE]: 'true'}),
			apiKey: 'key',
		});

		expect(muteMicrophoneTrack).not.toHaveBeenCalled();
	});
});
