// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {TableGameService} from '@app/api/table_game/TableGameService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {VoiceMembershipHooks} from '@app/api/voice_seat/VoiceMembershipHooks';
import {VOICE_MEMBERSHIP_HOOK_CONCURRENCY} from '@app/api/voice_seat/VoiceSeatLimits';
import {voiceSeatsKey} from '@app/api/voice_seat/VoiceSeatRepository';
import {VoiceSeatService} from '@app/api/voice_seat/VoiceSeatService';
import type {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const GUILD_ID = '900000000000000001';
const CHANNEL_ID = '900000000000000002';
const OTHER_CHANNEL_ID = '900000000000000003';
const USER_ID = '900000000000000004';

function voiceState(channelId: string, selfMute = false) {
	return {
		guild_id: GUILD_ID,
		channel_id: channelId,
		user_id: USER_ID,
		connection_id: 'conn-1',
		mute: false,
		deaf: false,
		self_mute: selfMute,
		self_deaf: false,
	};
}

describe('RpcService voice state membership hooks', () => {
	let harness: ApiTestHarness;

	async function rpc(body: Record<string, unknown>) {
		await createBuilder(harness, '').post('/test/rpc-session-init').body(body).expect(HTTP_STATUS.OK).execute();
	}

	async function setGames(on: boolean) {
		await getInstanceConfigRepository().updateVoiceRoomConfig(() => ({
			rooms_enabled: on,
			games_enabled: on,
			room_cameras_enabled: false,
			default_room_theme: null,
		}));
	}

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('voice_state_remove reads the stored state and calls only TableGameService.onVoiceLeft', async () => {
		await setGames(true);
		const onLeft = vi.spyOn(VoiceMembershipHooks, 'onLeft');
		const onVoiceLeft = vi.spyOn(TableGameService.prototype, 'onVoiceLeft');
		const onParticipantLeft = vi.spyOn(VoiceSeatService.prototype, 'onParticipantLeft');
		await rpc({type: 'voice_state_upsert', guild_id: GUILD_ID, voice_state: voiceState(CHANNEL_ID)});
		await rpc({type: 'voice_state_remove', guild_id: GUILD_ID, connection_id: 'conn-1'});
		expect(onLeft).toHaveBeenCalledTimes(1);
		expect(onLeft).toHaveBeenCalledWith(
			{
				guildId: createGuildID(BigInt(GUILD_ID)),
				channelId: createChannelID(BigInt(CHANNEL_ID)),
				userId: createUserID(BigInt(USER_ID)),
				connectionId: 'conn-1',
				regionId: null,
				serverId: null,
			},
			'rpc',
		);
		await vi.waitFor(() =>
			expect(onVoiceLeft).toHaveBeenCalledWith({
				userId: createUserID(BigInt(USER_ID)),
				guildId: createGuildID(BigInt(GUILD_ID)),
				channelId: createChannelID(BigInt(CHANNEL_ID)),
			}),
		);
		expect(onParticipantLeft).not.toHaveBeenCalled();
	});

	it("rpc voice_state_remove clears the leaver's j: mark even when the hook pool drops the leave", async () => {
		await setGames(true);
		const kv = harness.kvProvider as MockKVProvider;
		const key = voiceSeatsKey(createChannelID(BigInt(CHANNEL_ID)));
		const me = `user_${USER_ID}_conn-1`;
		await kv.hset(key, `j:${me}`, `${USER_ID}|eu|eu-1`);
		await kv.hset(key, 's:seat_A_01', me);
		await kv.hset(key, `p:${me}`, 'seat_A_01');
		await kv.hset(key, `l:${USER_ID}`, me);
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		vi.spyOn(VoiceSeatService.prototype, 'onRoomFinished').mockImplementation(() => gate);
		const onVoiceLeft = vi.spyOn(TableGameService.prototype, 'onVoiceLeft');
		try {
			for (let i = 0; i < VOICE_MEMBERSHIP_HOOK_CONCURRENCY; i++) {
				await VoiceMembershipHooks.onRoomFinished(createChannelID(BigInt(i + 1)));
			}
			await rpc({type: 'voice_state_upsert', guild_id: GUILD_ID, voice_state: voiceState(CHANNEL_ID)});
			await rpc({type: 'voice_state_remove', guild_id: GUILD_ID, connection_id: 'conn-1'});
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(onVoiceLeft).not.toHaveBeenCalled();
			expect(await kv.hget(key, `j:${me}`)).toBeNull();
			expect(await kv.hget(key, `p:${me}`)).toBe('seat_A_01');
			expect(await kv.hget(key, 's:seat_A_01')).toBe(me);
			expect(await kv.hget(key, `l:${USER_ID}`)).toBe(me);
		} finally {
			open();
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	});

	it('remove drops only the j: mark: no seat script and no seat hash read', async () => {
		await setGames(true);
		const kv = harness.kvProvider as MockKVProvider;
		await rpc({type: 'voice_state_upsert', guild_id: GUILD_ID, voice_state: voiceState(CHANNEL_ID)});
		kv.evalScriptSpy.mockClear();
		kv.hgetSpy.mockClear();
		await rpc({type: 'voice_state_remove', guild_id: GUILD_ID, connection_id: 'conn-1'});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(kv.evalScriptSpy.mock.calls.filter(([command]) => String(command).startsWith('voiceSeat'))).toEqual([]);
		expect(kv.hgetSpy.mock.calls.filter(([key]) => String(key).startsWith('{voice_seats:'))).toEqual([]);
	});

	it('upsert calls no hook', async () => {
		await setGames(true);
		const onJoined = vi.spyOn(VoiceMembershipHooks, 'onJoined');
		const onLeft = vi.spyOn(VoiceMembershipHooks, 'onLeft');
		const kv = harness.kvProvider as MockKVProvider;
		kv.hgetSpy.mockClear();
		await rpc({type: 'voice_state_upsert', guild_id: GUILD_ID, voice_state: voiceState(CHANNEL_ID)});
		await rpc({type: 'voice_state_upsert', guild_id: GUILD_ID, voice_state: voiceState(CHANNEL_ID, true)});
		await rpc({type: 'voice_state_upsert', guild_id: GUILD_ID, voice_state: voiceState(OTHER_CHANNEL_ID)});
		expect(onJoined).not.toHaveBeenCalled();
		expect(onLeft).not.toHaveBeenCalled();
		expect(kv.hgetSpy).not.toHaveBeenCalled();
	});

	it('games off → remove skips the stored-state read and calls no hook', async () => {
		await setGames(false);
		const onLeft = vi.spyOn(VoiceMembershipHooks, 'onLeft');
		const kv = harness.kvProvider as MockKVProvider;
		await rpc({type: 'voice_state_upsert', guild_id: GUILD_ID, voice_state: voiceState(CHANNEL_ID)});
		kv.hgetSpy.mockClear();
		await rpc({type: 'voice_state_remove', guild_id: GUILD_ID, connection_id: 'conn-1'});
		expect(kv.hgetSpy).not.toHaveBeenCalled();
		expect(onLeft).not.toHaveBeenCalled();
		expect(await kv.hgetall(`voice:guild:states:${GUILD_ID}`)).toEqual({});
	});
});
