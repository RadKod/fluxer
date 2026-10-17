// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, UserID} from '@app/api/BrandedTypes';
import {createChannelID, createUserID} from '@app/api/BrandedTypes';
import type {UpdateRoomMetadataParams} from '@app/api/infrastructure/ILiveKitService';
import {VoiceActivityRepository} from '@app/api/voice_activity/VoiceActivityRepository';
import {VoiceActivityService, type VoiceActivityServiceDeps} from '@app/api/voice_activity/VoiceActivityService';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ACTIVITY_METADATA_KEY, VOICE_ACTIVITY_SESSION_TTL_MS} from '@fluxer/constants/src/VoiceActivityConstants';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {UserNotInVoiceError} from '@fluxer/errors/src/domains/user/UserNotInVoiceError';
import {VoiceActivityConflictError} from '@fluxer/errors/src/domains/voice/VoiceActivityConflictError';
import type {VoiceRoomConfig} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {describe, expect, it, vi} from 'vitest';

const GUILD = 500n;
const CHANNEL = '9001';
const A = '101';
const B = '102';
const conn = (userId: string) => `c${userId}`;
const uid = (userId: string): UserID => createUserID(BigInt(userId));
const cid = (channelId: string): ChannelID => createChannelID(BigInt(channelId));
const ref = (userId: string) => ({userId: uid(userId), channelId: cid(CHANNEL), connectionId: conn(userId)});

function createFixture() {
	const kv = new MockKVProvider();
	const repository = new VoiceActivityRepository(kv);
	const config: VoiceRoomConfig = {
		rooms_enabled: true,
		games_enabled: true,
		room_cameras_enabled: false,
		default_room_theme: null,
	};
	const guildFeatures: Array<string> = ['VOICE_ACTIVITIES'];
	const inVoice = new Set<string>();
	// The room metadata as LiveKit would hold it after the merge.
	let roomMetadata: Record<string, unknown> = {other: 'kept'};
	const liveKit = {
		updateRoomMetadata: vi.fn(async (p: UpdateRoomMetadataParams): Promise<'ok' | 'not_found' | 'error'> => {
			for (const [key, value] of Object.entries(p.entries)) {
				if (value === null) delete roomMetadata[key];
				else roomMetadata[key] = value;
			}
			return 'ok';
		}),
	};
	let nextSnowflake = 7000n;
	const deps = {
		repository,
		instanceConfigRepository: {getVoiceRoomConfig: async () => ({...config})},
		channelAuthService: {
			async getChannelAuthenticated({channelId}: {channelId: ChannelID}) {
				return {
					channel: {id: channelId, guildId: GUILD, type: ChannelTypes.GUILD_VOICE},
					guild: {features: guildFeatures},
					checkPermission: async () => {},
				};
			},
		},
		voiceSeatService: {
			membership: vi.fn(async (p: {userId: UserID; connectionId: string}) =>
				inVoice.has(`${p.userId}:${p.connectionId}`) ? {regionId: 'eu', serverId: 'lk-1'} : null,
			),
		},
		liveKitService: liveKit,
		snowflakeService: {generate: async () => nextSnowflake++},
	} as unknown as VoiceActivityServiceDeps;
	return {
		kv,
		repository,
		config,
		guildFeatures,
		liveKit,
		service: new VoiceActivityService(deps),
		metadata: () => roomMetadata,
		resetMetadata(value: Record<string, unknown>) {
			roomMetadata = value;
		},
		join(userId: string) {
			inVoice.add(`${userId}:${conn(userId)}`);
		},
	};
}

describe('VoiceActivityService', () => {
	it('starts a session, stores it with the TTL and writes it into the room metadata next to other keys', async () => {
		const f = createFixture();
		f.join(A);
		const before = Date.now();
		const session = await f.service.start({...ref(A), activityId: 'band'});
		expect(session).toEqual({activity_id: 'band', session_id: '7000', started_by: A, started_at: expect.any(Number)});
		expect(session.started_at).toBeGreaterThanOrEqual(before);
		expect(await f.repository.load(CHANNEL)).toEqual(session);
		expect(f.kv.setnxSpy).toHaveBeenCalledWith(
			`{voice_activity:${CHANNEL}}`,
			JSON.stringify(session),
			VOICE_ACTIVITY_SESSION_TTL_MS / 1000,
		);
		expect(f.metadata()).toEqual({other: 'kept', [VOICE_ACTIVITY_METADATA_KEY]: session});
		expect(f.liveKit.updateRoomMetadata).toHaveBeenCalledWith(
			expect.objectContaining({guildId: GUILD, channelId: cid(CHANNEL), regionId: 'eu', serverId: 'lk-1'}),
		);
		expect(await f.service.get(ref(A))).toEqual(session);
	});

	it('a second start while a session runs → VOICE_ACTIVITY_CONFLICT, the first session stays', async () => {
		const f = createFixture();
		f.join(A);
		f.join(B);
		const first = await f.service.start({...ref(A), activityId: 'band'});
		await expect(f.service.start({...ref(B), activityId: 'band'})).rejects.toBeInstanceOf(VoiceActivityConflictError);
		expect(await f.repository.load(CHANNEL)).toEqual(first);
		expect(f.metadata()[VOICE_ACTIVITY_METADATA_KEY]).toEqual(first);
	});

	it('any member ends it: the key and our metadata key go, other keys stay, and a new start works', async () => {
		const f = createFixture();
		f.join(A);
		f.join(B);
		await f.service.start({...ref(A), activityId: 'band'});
		await f.service.end(ref(B));
		expect(await f.repository.load(CHANNEL)).toBeNull();
		expect(f.metadata()).toEqual({other: 'kept'});
		expect(await f.service.get(ref(A))).toBeNull();
		expect((await f.service.start({...ref(B), activityId: 'band'})).started_by).toBe(B);
	});

	it('end with no session still clears leftover metadata; a room gone from LiveKit is not an error', async () => {
		const f = createFixture();
		f.join(A);
		f.resetMetadata({[VOICE_ACTIVITY_METADATA_KEY]: {activity_id: 'band'}});
		await f.service.end(ref(A));
		expect(f.metadata()).toEqual({});
		f.liveKit.updateRoomMetadata.mockResolvedValueOnce('not_found');
		await expect(f.service.end(ref(A))).resolves.toBeUndefined();
	});

	it('every route needs the caller in this voice channel', async () => {
		const f = createFixture();
		f.join(A);
		await f.service.start({...ref(A), activityId: 'band'});
		await expect(f.service.get(ref(B))).rejects.toBeInstanceOf(UserNotInVoiceError);
		await expect(f.service.start({...ref(B), activityId: 'band'})).rejects.toBeInstanceOf(UserNotInVoiceError);
		await expect(f.service.end(ref(B))).rejects.toBeInstanceOf(UserNotInVoiceError);
		await expect(f.service.end({...ref(A), connectionId: 'other'})).rejects.toBeInstanceOf(UserNotInVoiceError);
		expect(await f.repository.load(CHANNEL)).not.toBeNull();
	});

	it('the switch off answers FEATURE_TEMPORARILY_DISABLED before any read or write', async () => {
		const f = createFixture();
		f.join(A);
		f.config.games_enabled = false;
		await expect(f.service.get(ref(A))).rejects.toBeInstanceOf(FeatureTemporarilyDisabledError);
		await expect(f.service.start({...ref(A), activityId: 'band'})).rejects.toBeInstanceOf(
			FeatureTemporarilyDisabledError,
		);
		await expect(f.service.end(ref(A))).rejects.toBeInstanceOf(FeatureTemporarilyDisabledError);
		f.config.games_enabled = true;
		f.config.rooms_enabled = false;
		await expect(f.service.start({...ref(A), activityId: 'band'})).rejects.toBeInstanceOf(
			FeatureTemporarilyDisabledError,
		);
		expect(f.liveKit.updateRoomMetadata).not.toHaveBeenCalled();
		expect(await f.repository.load(CHANNEL)).toBeNull();
	});

	it('a guild without VOICE_ACTIVITIES answers FEATURE_TEMPORARILY_DISABLED', async () => {
		const f = createFixture();
		f.join(A);
		f.guildFeatures.length = 0;
		await expect(f.service.start({...ref(A), activityId: 'band'})).rejects.toBeInstanceOf(
			FeatureTemporarilyDisabledError,
		);
		await expect(f.service.get(ref(A))).rejects.toBeInstanceOf(FeatureTemporarilyDisabledError);
		expect(f.liveKit.updateRoomMetadata).not.toHaveBeenCalled();
	});

	it('a failed metadata write on start releases the channel', async () => {
		const f = createFixture();
		f.join(A);
		for (const outcome of ['error', 'not_found'] as const) {
			f.liveKit.updateRoomMetadata.mockResolvedValueOnce(outcome);
			await expect(f.service.start({...ref(A), activityId: 'band'})).rejects.toBeInstanceOf(ServiceUnavailableError);
			expect(await f.repository.load(CHANNEL)).toBeNull();
		}
		await expect(f.service.start({...ref(A), activityId: 'band'})).resolves.toMatchObject({activity_id: 'band'});
	});

	it('a failed metadata write on end still drops the key and answers 503 so the client retries', async () => {
		const f = createFixture();
		f.join(A);
		await f.service.start({...ref(A), activityId: 'band'});
		f.liveKit.updateRoomMetadata.mockResolvedValueOnce('error');
		await expect(f.service.end(ref(A))).rejects.toBeInstanceOf(ServiceUnavailableError);
		expect(await f.repository.load(CHANNEL)).toBeNull();
	});

	it('room finished clears the session key', async () => {
		const f = createFixture();
		f.join(A);
		await f.service.start({...ref(A), activityId: 'band'});
		await f.service.onRoomFinished(cid(CHANNEL));
		expect(await f.repository.load(CHANNEL)).toBeNull();
		expect(f.liveKit.updateRoomMetadata).toHaveBeenCalledTimes(1);
	});
});
