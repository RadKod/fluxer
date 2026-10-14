// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createChannel, updateRole} from '@app/api/channel/tests/ChannelTestUtils';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {invalidateMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {levelSettings, rewardFixture, taskHelpers} from '@app/api/guild/micupbot/tests/MicupBotLevelsTestUtils';
import {updateRolePositions} from '@app/api/guild/tests/GuildTestUtils';
import {Logger} from '@app/api/Logger';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import handleMicupBotLevelUp from '@app/api/worker/tasks/HandleMicupBotLevelUp';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
let previousId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	previousId = Config.instance.micupBotApplicationId;
	await harness.reset();
});
afterEach(() => {
	Config.instance.micupBotApplicationId = previousId;
	clearWorkerDependencies();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

it('level-up gives every reward up to the level (cumulative) as the bot', async () => {
	const f = await rewardFixture(harness);
	const lock = vi.spyOn(f.deps.kvClient, 'acquireLock');
	setWorkerDependenciesForTest(f.deps);
	await handleMicupBotLevelUp(f.payload, taskHelpers());
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))?.roleIds).toEqual(
		new Set(f.rewards.slice(0, 2).map((r) => r.role_id)),
	);
	for (const reward of f.rewards.slice(0, 2))
		expect(f.grant).toHaveBeenCalledWith(
			expect.objectContaining({userId: f.botId, targetId: f.userId, guildId: f.guildId, roleId: reward.role_id}),
			MICUPBOT_TEXT.audit.levelReward,
		);
	expect(lock).toHaveBeenCalledWith(`micupbot:mlock:${f.guildId}:${f.userId}`, expect.any(String), 5);
	f.grant.mockClear();
	await f.levels.handleLevelUp(f.payload);
	expect(f.grant).not.toHaveBeenCalled();
});

it('a reward role raised to an elevated permission later is skipped and logged', async () => {
	const f = await rewardFixture(harness);
	await updateRole(harness, f.owner.token, f.guild.id, f.rewards[0]!.role_id.toString(), {
		permissions: Permissions.ADMINISTRATOR.toString(),
	});
	const warn = vi.spyOn(Logger.child({}), 'warn');
	await f.levels.handleLevelUp({...f.payload, level: 1});
	expect(f.grant).not.toHaveBeenCalled();
	expect(warn).toHaveBeenCalledWith(expect.objectContaining({problem: 'elevated'}), expect.any(String));
});

it('a reward above the bot hierarchy is skipped and counted', async () => {
	const f = await rewardFixture(harness);
	await updateRolePositions(harness, f.owner.token, f.guild.id, [{id: f.rewards[0]!.role_id.toString(), position: 5}]);
	const info = vi.spyOn(Logger.child({}), 'info');
	await f.levels.handleLevelUp({...f.payload, level: 1});
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))?.roleIds.size).toBe(0);
	expect(info).toHaveBeenCalledWith(expect.objectContaining({skipped: 1}), expect.any(String));
});

it('a temporary member gets no reward role', async () => {
	const f = await rewardFixture(harness);
	const member = (await f.deps.guildRepository.getMember(f.guildId, f.userId))!;
	await f.deps.guildRepository.upsertMember({...member.toRow(), temporary: true});
	await f.levels.handleLevelUp(f.payload);
	expect(f.grant).not.toHaveBeenCalled();
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))?.isTemporary).toBe(true);
});

it("the level-up message goes to the level-up channel or the message's channel and pings only the member", async () => {
	const f = await rewardFixture(harness);
	const channel = await createChannel(harness, f.owner.token, f.guild.id, 'levels', 0);
	let version = 0;
	for (const target of [createChannelID(BigInt(channel.id)), null]) {
		await f.repository.putSettings(
			levelSettings(f.guildId, {
				level_up_message_enabled: true,
				level_up_channel_id: target,
				level_up_message: '{user} reached {level}',
			}),
			version++,
		);
		await invalidateMicupBotGuildConfig(f.guildId);
		await f.levels.handleLevelUp(f.payload);
		expect(f.send).toHaveBeenLastCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({id: f.botId}),
				channelId: target ?? f.channelId,
				data: expect.objectContaining({
					content: `<@${f.userId}> reached 2`,
					allowed_mentions: {parse: [], users: [f.userId]},
				}),
			}),
		);
	}
	f.send.mockClear();
	await f.levels.handleLevelUp({...f.payload, channel_id: null});
	expect(f.send).not.toHaveBeenCalled();
});

it('on an elevated-MFA community the reward is skipped and counted', async () => {
	const f = await rewardFixture(harness);
	const guild = (await f.deps.guildRepository.findUnique(f.guildId))!;
	await f.deps.guildRepository.upsert({...guild.toRow(), mfa_level: 1});
	const info = vi.spyOn(Logger.child({}), 'info');
	await f.levels.handleLevelUp({...f.payload, level: 1});
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))?.roleIds.size).toBe(0);
	expect(info).toHaveBeenCalledWith(expect.objectContaining({skipped: 1}), expect.any(String));
});

it('disabled levels or instance skip rewards and messages', async () => {
	const f = await rewardFixture(harness);
	await f.repository.putSettings(levelSettings(f.guildId, {levels_enabled: false}), 0);
	await invalidateMicupBotGuildConfig(f.guildId);
	await f.levels.handleLevelUp(f.payload);
	await f.repository.putSettings(levelSettings(f.guildId), 1);
	await invalidateMicupBotGuildConfig(f.guildId);
	overrideLimits({feature_micupbot: 0});
	await f.levels.handleLevelUp(f.payload);
	expect(f.grant).not.toHaveBeenCalled();
	expect(f.send).not.toHaveBeenCalled();
});

it('a reward failure does not stop the next reward and a message failure is logged', async () => {
	const f = await rewardFixture(harness);
	await f.repository.putSettings(levelSettings(f.guildId, {level_up_message_enabled: true}), 0);
	await invalidateMicupBotGuildConfig(f.guildId);
	f.grant.mockRejectedValueOnce(new Error('role unavailable'));
	f.send.mockRejectedValueOnce(new Error('channel unavailable'));
	const warn = vi.spyOn(Logger.child({}), 'warn');
	await expect(f.levels.handleLevelUp(f.payload)).resolves.toBeUndefined();
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))?.roleIds).toEqual(
		new Set([f.rewards[1]!.role_id]),
	);
	expect(warn).toHaveBeenCalledTimes(2);
});
