// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {createMicupBotAutomodRunner, type MicupBotAutomodActionPayload} from '@app/api/guild/micupbot/MicupBotAutomod';
import {MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {captureHookWarnings, createHookFixture, NOW} from '@app/api/guild/micupbot/tests/MicupBotHookTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MfaNotEnabledError} from '@fluxer/errors/src/domains/auth/MfaNotEnabledError';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('MicupBotAutomodAction', () => {
	let harness: ApiTestHarness;
	let f: Awaited<ReturnType<typeof createHookFixture>>;
	let payload: MicupBotAutomodActionPayload;
	const originalBotId = Config.instance.micupBotApplicationId;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		f = await createHookFixture(harness);
		payload = {
			guild_id: f.guild.id,
			channel_id: f.systemChannel.id,
			message_id: '810000000000000004',
			author_id: f.members[0]!.userId,
			rule: 'words',
			action: 'delete',
			mute_seconds: 600,
			at: NOW,
		};
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
	});
	afterEach(() => {
		Config.instance.micupBotApplicationId = originalBotId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	function spies() {
		return {
			deletion: vi.spyOn(f.deps.channelService.messages.deletion, 'deleteMessage').mockResolvedValue(undefined),
			send: vi.spyOn(f.deps.channelService.messages.send, 'sendMessage').mockResolvedValue({} as never),
			update: vi.spyOn(f.deps.guildService.members, 'updateMember').mockResolvedValue({} as never),
			permissions: vi.spyOn(f.deps.gatewayService, 'getUserPermissions').mockResolvedValue(0n),
		};
	}
	it('deletes as the bot with the automod audit reason', async () => {
		const {deletion, permissions} = spies();
		await createMicupBotAutomodRunner(f.deps).run(payload);
		expect(deletion).toHaveBeenCalledExactlyOnceWith({
			userId: f.botId,
			viewer: {kind: 'user', userId: f.botId, bot: true, capable: true},
			channelId: createChannelID(BigInt(payload.channel_id)),
			messageId: createMessageID(BigInt(payload.message_id)),
			requestCache: expect.anything(),
			auditLogReason: MICUPBOT_TEXT.audit.automod('words'),
		});
		expect(permissions).toHaveBeenCalledWith({
			guildId: createGuildID(BigInt(payload.guild_id)),
			userId: createUserID(BigInt(payload.author_id)),
			channelId: createChannelID(BigInt(payload.channel_id)),
		});
	});
	it('delete_warn posts one warning that pings only the author', async () => {
		const {send} = spies();
		await createMicupBotAutomodRunner(f.deps).run({...payload, action: 'delete_warn'});
		expect(send).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				user: expect.objectContaining({id: f.botId}),
				channelId: BigInt(payload.channel_id),
				data: {
					content: MICUPBOT_TEXT.automodWarning(payload.author_id, MICUPBOT_TEXT.automodReason.words),
					allowed_mentions: {parse: [], users: [BigInt(payload.author_id)]},
				},
			}),
		);
	});
	it('delete_warn has a shared 30 second cooldown per guild and author', async () => {
		const {send, deletion} = spies();
		const run = (author_id = payload.author_id, guild_id = payload.guild_id) =>
			createMicupBotAutomodRunner(f.deps).run({...payload, author_id, guild_id, action: 'delete_warn'});
		await Promise.all([run(), run()]);
		expect(deletion).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledTimes(1);
		expect(await f.deps.kvClient.ttl(`micupbot:amw:${payload.guild_id}:${payload.author_id}`)).toBe(30);
		await run('810000000000000005');
		await run(payload.author_id, '810000000000000006');
		expect(send).toHaveBeenCalledTimes(3);
		vi.spyOn(Date, 'now').mockReturnValue(NOW + 30_001);
		await run();
		expect(send).toHaveBeenCalledTimes(4);
	});
	it('MANAGE_MESSAGES authors do not consume the circuit breaker', async () => {
		const {permissions, deletion, send} = spies();
		permissions.mockResolvedValue(Permissions.MANAGE_MESSAGES);
		const bucket = vi.spyOn(f.deps.kvClient, 'checkLeakyBucketLimit');
		const runner = createMicupBotAutomodRunner(f.deps);
		for (let i = 0; i < 61; i++) await runner.run(payload);
		expect(bucket).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(await f.deps.kvClient.get(`micupbot:amstop:${payload.guild_id}`)).toBeNull();
		permissions.mockResolvedValue(0n);
		await runner.run(payload);
		expect(deletion).toHaveBeenCalledTimes(1);
	});
	it('delete_mute times the author out for mute_seconds', async () => {
		const {update, send} = spies();
		await createMicupBotAutomodRunner(f.deps).run({...payload, action: 'delete_mute', mute_seconds: 120});
		expect(update).toHaveBeenCalledExactlyOnceWith(
			{
				userId: f.botId,
				targetId: BigInt(payload.author_id),
				guildId: BigInt(payload.guild_id),
				data: {
					communication_disabled_until: new Date(NOW + 120_000).toISOString(),
					timeout_reason: MICUPBOT_TEXT.audit.automod('words'),
				},
				requestCache: expect.anything(),
			},
			MICUPBOT_TEXT.audit.automod('words'),
		);
		expect(send).not.toHaveBeenCalled();
	});
	it('a MANAGE_MESSAGES author is left alone', async () => {
		const {permissions, deletion, send, update} = spies();
		permissions.mockResolvedValue(Permissions.MANAGE_MESSAGES);
		await createMicupBotAutomodRunner(f.deps).run({...payload, action: 'delete_mute'});
		expect(deletion).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});
	it('past 60 actions a minute automod pauses 10 minutes and warns once', async () => {
		const {deletion, send} = spies();
		const runner = createMicupBotAutomodRunner(f.deps);
		for (let i = 0; i < 65; i++) await runner.run(payload);
		expect(deletion).toHaveBeenCalledTimes(60);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]![0].data).toEqual({content: MICUPBOT_TEXT.automodPaused, allowed_mentions: {parse: []}});
		expect(await f.deps.kvClient.ttl(`micupbot:amstop:${payload.guild_id}`)).toBe(600);
		expect(await f.deps.kvClient.ttl(`micupbot:amwarn:${payload.guild_id}`)).toBe(600);
	});
	it('concurrent circuit trips warn once', async () => {
		const {deletion, send} = spies();
		const runner = createMicupBotAutomodRunner(f.deps);
		await Promise.all(Array.from({length: 70}, () => runner.run(payload)));
		expect(deletion).toHaveBeenCalledTimes(60);
		expect(send).toHaveBeenCalledTimes(1);
	});
	it('a disabled instance or a paused guild takes no action', async () => {
		const {deletion, send} = spies();
		const get = vi.spyOn(f.deps.kvClient, 'get');
		overrideLimits({feature_micupbot: 0});
		await createMicupBotAutomodRunner(f.deps).run(payload);
		expect(get).not.toHaveBeenCalled();
		overrideLimits({feature_micupbot: 1});
		await f.deps.kvClient.setnx(`micupbot:amstop:${payload.guild_id}`, '1', 600);
		await createMicupBotAutomodRunner(f.deps).run(payload);
		expect(deletion).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
	it('an already deleted message does not retry or duplicate a warning', async () => {
		const {deletion, send} = spies();
		deletion.mockRejectedValue(new UnknownMessageError());
		await expect(createMicupBotAutomodRunner(f.deps).run({...payload, action: 'delete_warn'})).resolves.toBeUndefined();
		expect(send).not.toHaveBeenCalled();
	});
	it('permission and MFA failures are counted in one summary and never retried', async () => {
		const {deletion, update} = spies();
		const warn = captureHookWarnings();
		for (const error of [new MissingPermissionsError(), new MfaNotEnabledError()]) {
			deletion.mockRejectedValueOnce(error);
			warn.mockClear();
			await expect(
				createMicupBotAutomodRunner(f.deps).run({...payload, action: 'delete_mute'}),
			).resolves.toBeUndefined();
			expect(update).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(expect.objectContaining({failed: 1}), expect.any(String));
		}
		update.mockRejectedValue(new MissingPermissionsError());
		warn.mockClear();
		await expect(createMicupBotAutomodRunner(f.deps).run({...payload, action: 'delete_mute'})).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
