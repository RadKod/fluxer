// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {checkGuildSoundboardPlayRateLimit} from '@app/api/guild/soundboard/GuildSoundboardPlayRateLimit';
import {GuildSoundboardPlayService} from '@app/api/guild/soundboard/GuildSoundboardPlayService';
import {fixture, GUILD_ID, play, savedSound} from '@app/api/guild/soundboard/tests/GuildSoundboardTestUtils';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {RateLimitService} from '@pkgs/rate_limit/src/RateLimitService';
import {afterEach, describe, expect, it, vi} from 'vitest';

function playFixture() {
	const f = fixture();
	const channels = {findUnique: vi.fn(async () => ({guildId: GUILD_ID}))};
	const kv = new MockKVProvider();
	const limiter = new RateLimitService(kv);
	const makeService = () =>
		new GuildSoundboardPlayService(
			f.repository,
			f.gateway as unknown as IGatewayService,
			channels as unknown as ChannelRepository['channelData'],
			limiter,
		);
	const rate = (userId = play.userId) =>
		checkGuildSoundboardPlayRateLimit(new RateLimitService(kv), userId, play.channelId);
	return {...f, channels, kv, makeService, rate, service: makeService()};
}
afterEach(() => vi.useRealTimers());

describe('Guild soundboard play trust boundary', () => {
	it.each([Permissions.VIEW_CHANNEL, Permissions.CONNECT, Permissions.SPEAK])(
		'rejects a missing channel permission %s before charging tokens or entering the voice owner',
		async (missing) => {
			const f = playFixture();
			await f.repository.upsertSound(savedSound());
			f.gateway.checkPermission.mockImplementation(async ({permission}) => (permission & missing) === 0n);
			await expect(f.service.play(play)).rejects.toThrow(MissingPermissionsError);
			expect(f.kv.checkLeakyBucketLimitSpy).not.toHaveBeenCalled();
			expect(f.gateway.playGuildSoundboardSound).not.toHaveBeenCalled();
		},
	);
	it('fails closed on shared limiter errors before entering the voice owner', async () => {
		const f = playFixture();
		await f.repository.upsertSound(savedSound());
		vi.spyOn(f.kv, 'checkLeakyBucketLimit').mockRejectedValue(new Error('limiter unavailable'));
		await expect(f.service.play(play)).rejects.toThrow('limiter unavailable');
		expect(f.gateway.playGuildSoundboardSound).not.toHaveBeenCalled();
	});
	it('shares playback tokens across service instances before entering the voice owner', async () => {
		const f = playFixture();
		await f.repository.upsertSound(savedSound());
		await f.service.play(play);
		await f.makeService().play({...play, sessionId: 'reconnected', connectionId: 'new-connection'});
		await f.makeService().play(play);
		await f.makeService().play(play);
		await expect(f.makeService().play(play)).rejects.toThrow(RateLimitError);
		expect(f.gateway.playGuildSoundboardSound).toHaveBeenCalledTimes(4);
	});
	it('rejects a sound absent from the channel guild', async () => {
		const f = playFixture();
		await expect(f.service.play(play)).rejects.toThrow();
		expect(f.gateway.playGuildSoundboardSound).not.toHaveBeenCalled();
	});
	it('makes one authoritative playback RPC carrying trusted metadata and actor connection', async () => {
		const f = playFixture();
		await f.repository.upsertSound(savedSound());
		await f.service.play(play);
		expect(f.gateway.checkPermission).toHaveBeenCalledWith({
			guildId: GUILD_ID,
			channelId: play.channelId,
			userId: play.userId,
			permission: Permissions.VIEW_CHANNEL | Permissions.CONNECT | Permissions.SPEAK,
		});
		expect(f.gateway.checkPermission.mock.invocationCallOrder[0]).toBeLessThan(
			f.kv.checkLeakyBucketLimitSpy.mock.invocationCallOrder[0],
		);
		expect(f.kv.checkLeakyBucketLimitSpy.mock.invocationCallOrder[1]).toBeLessThan(
			f.gateway.playGuildSoundboardSound.mock.invocationCallOrder[0],
		);
		expect(f.gateway.playGuildSoundboardSound).toHaveBeenCalledOnce();
		expect(f.gateway.playGuildSoundboardSound).toHaveBeenCalledWith(
			expect.objectContaining({
				guild_id: GUILD_ID.toString(),
				user_id: play.userId.toString(),
				session_id: play.sessionId,
				connection_id: play.connectionId,
				asset_version: 'a'.repeat(64),
				volume: 0.5,
			}),
		);
		expect(f.gateway.dispatchGuild).not.toHaveBeenCalled();
	});
	it.each(['forbidden', 'invalid_voice_state', 'wrong_session'])('propagates owner refusal %s', async (error) => {
		const f = playFixture();
		await f.repository.upsertSound(savedSound());
		f.gateway.playGuildSoundboardSound.mockResolvedValue({success: false, error});
		await expect(f.service.play(play)).rejects.toThrow();
	});
	it('shares user rate limits across API instances and reconnects', async () => {
		const f = playFixture();
		for (let i = 0; i < 4; i++) expect(await f.rate()).toEqual({allowed: true});
		expect(await f.rate()).toEqual({allowed: false});
	});
	it('shares channel burst four with eight-per-five-second drain across instances', async () => {
		vi.useFakeTimers();
		const f = playFixture();
		for (let id = 1; id <= 4; id++) expect(await f.rate(createUserID(BigInt(id)))).toEqual({allowed: true});
		expect(await f.rate(createUserID(5n))).toEqual({allowed: false});
		vi.advanceTimersByTime(625);
		expect(await f.rate(createUserID(6n))).toEqual({allowed: true});
	});
	it('plays saved sounds without a current upload entitlement check', async () => {
		const f = playFixture();
		await f.repository.upsertSound(savedSound());
		await expect(f.service.play(play)).resolves.toBeUndefined();
	});
});
