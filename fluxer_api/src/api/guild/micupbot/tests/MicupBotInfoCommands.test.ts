// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMessageID, createRoleID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_COMMAND_NAMES, MICUPBOT_EMBED_COLOR, MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {leaderboardReplace} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import {useCommandFixture} from '@app/api/guild/micupbot/tests/MicupBotCommandTestUtils';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {expect, it, vi} from 'vitest';

const fixture = useCommandFixture();

it('#rank and #top need levels on', async () => {
	const f = await fixture();
	for (const command of ['#rank', '#top']) {
		await f.run(command);
		expect(f.reply()?.content).toBe(MICUPBOT_TEXT.levelsOff);
	}
});

it('#help lists every command', async () => {
	const f = await fixture();
	await f.run('#help');
	const embed = f.reply()?.embeds?.[0];
	expect(embed?.title).toBe(MICUPBOT_TEXT.helpTitle);
	expect(embed?.color).toBe(MICUPBOT_EMBED_COLOR);
	for (const name of MICUPBOT_COMMAND_NAMES) expect(embed?.description).toContain(`#${name}`);
});

it('a deleted command message runs nothing', async () => {
	const f = await fixture();
	const payload = await f.command(`#ban ${f.target.userId}`);
	await f.deps.channelRepository.messages.bulkDeleteMessages(f.channelId, [
		createMessageID(BigInt(payload.message_id)),
	]);
	const ban = vi.spyOn(f.deps.guildService.moderation, 'banMember');
	await expect(f.runner.run(payload)).resolves.toBeUndefined();
	expect(ban).not.toHaveBeenCalled();
	expect(f.send).not.toHaveBeenCalled();
});

it('commands stop when the bot is not a member', async () => {
	const f = await fixture();
	const payload = await f.command(`#ban ${f.target.userId}`);
	await f.deps.guildRepository.deleteMember(f.guildId, f.botId);
	await expect(f.runner.run(payload)).resolves.toBeUndefined();
	expect(await f.deps.guildRepository.getBan(f.guildId, f.targetId)).toBeNull();
	expect(f.send).not.toHaveBeenCalled();
});

it('per-community and heavy-command rate limits drop extra commands silently', async () => {
	const f = await fixture();
	for (const [content, key, limit, window] of [
		['#help', `micupbot:cmd:g:${f.guildId}`, 30, 10000],
		['#slowmode off', `micupbot:cmd:h:${f.guildId}`, 10, 60000],
	] as const) {
		await f.deps.kvClient.del(`micupbot:cmd:g:${f.guildId}`);
		for (let index = 0; index < limit; index++) await f.deps.kvClient.checkLeakyBucketLimit(key, limit, window, 1);
		const payload = await f.command(content);
		const member = vi.spyOn(f.deps.guildRepository, 'getMember');
		await f.runner.run(payload);
		expect(member).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
		member.mockRestore();
	}
});

it('replies never ping (allowed_mentions parse [])', async () => {
	const f = await fixture();
	const payload = await f.run('#help');
	expect(f.reply()?.allowed_mentions).toEqual({parse: [], replied_user: false});
	expect(f.reply()?.message_reference).toMatchObject({
		message_id: BigInt(payload.message_id),
		channel_id: f.channelId,
		guild_id: f.guildId,
	});
	expect(f.send.mock.calls.at(-1)?.[0].user.id).toBe(f.botId);
});

it('disabled instance and community switches stop commands', async () => {
	const f = await fixture();
	const payload = await f.command(`#ban ${f.target.userId}`);
	const guild = (await f.deps.guildRepository.findUnique(f.guildId))!;
	await f.deps.guildRepository.upsert({...guild.toRow(), features: new Set()});
	await f.runner.run(payload);
	expect(f.send).not.toHaveBeenCalled();
	Config.instance.micupBotApplicationId = undefined;
	const rate = vi.spyOn(f.deps.kvClient, 'checkLeakyBucketLimit');
	await f.runner.run(payload);
	expect(rate).not.toHaveBeenCalled();
	Config.instance.micupBotApplicationId = f.bot.application.id;
	overrideLimits({feature_micupbot: 0});
	await f.runner.run(payload);
	expect(rate).not.toHaveBeenCalled();
	expect(await f.deps.guildRepository.getBan(f.guildId, f.targetId)).toBeNull();
});

it('the worker consumes no per-user bucket and claims delivery before reading Cassandra', async () => {
	const f = await fixture();
	const payload = await f.command('#help');
	const rate = vi.spyOn(f.deps.kvClient, 'checkLeakyBucketLimit');
	const claim = vi.spyOn(f.deps.kvClient, 'setnx');
	const member = vi.spyOn(f.deps.guildRepository, 'getMember');
	await f.runner.run(payload);
	expect(rate.mock.calls.filter(([key]) => key.startsWith('micupbot:cmd:'))).toEqual([
		[`micupbot:cmd:g:${f.guildId}`, 30, 10000, 1],
	]);
	expect(claim).toHaveBeenCalledWith(`micupbot:cmd:run:${payload.message_id}`, '1', 86400);
	expect(rate.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]);
	expect(claim.mock.invocationCallOrder[0]).toBeLessThan(member.mock.invocationCallOrder[0]);
});

it('missing leaderboard queues one rebuild and returns the empty text', async () => {
	const f = await fixture();
	const guild = (await f.deps.guildRepository.findUnique(f.guildId))!;
	await f.deps.guildRepository.upsert({
		...guild.toRow(),
		features: new Set([...guild.features, GuildFeatures.MICUPBOT_LEVELS]),
	});
	const jobs = vi.spyOn(f.deps.workerService, 'addJob');
	for (const command of ['#rank', '#top']) {
		await f.run(command);
		expect(f.reply()?.content).toBe(MICUPBOT_TEXT.topEmpty);
	}
	expect(jobs).toHaveBeenCalledWith('rebuildMicupBotLeaderboard', {guild_id: f.guild.id}, {jobKey: `lbr:${f.guildId}`});
	await f.repository.setMemberXp(f.guildId, f.authorId, 150n);
	await leaderboardReplace(f.deps.kvClient, f.guildId, [{userId: f.author.userId, xp: 150}]);
	await f.run('#rank');
	expect(f.reply()?.content).toContain('50/155 XP');
	await f.run('#top');
	expect(f.reply()?.embeds?.[0]?.title).toBe(MICUPBOT_TEXT.topTitle);
	expect(f.reply()?.embeds?.[0]?.description).toContain('150');
});

it('user server and avatar commands return bounded public information', async () => {
	const f = await fixture();
	await f.run(`#user <@!${f.target.userId}>`);
	expect(f.reply()?.embeds?.[0]?.fields?.map((field) => field.name)).toEqual(MICUPBOT_TEXT.userFields);
	await f.run('#server');
	expect(f.reply()?.embeds?.[0]?.fields?.map((field) => field.name)).toEqual(MICUPBOT_TEXT.serverFields);
	await f.run('#avatar');
	expect(f.reply()?.embeds?.[0]?.image?.url).toMatch(/^https?:\/\//);
});

it('runner failures and unsendable replies never retry moderation', async () => {
	const f = await fixture();
	const payload = await f.command(`#ban ${f.target.userId}`);
	f.send.mockRejectedValueOnce(new Error('cannot reply'));
	await expect(f.runner.run(payload)).resolves.toBeUndefined();
	expect(await f.deps.guildRepository.getBan(f.guildId, f.targetId)).not.toBeNull();
	vi.spyOn(f.deps.kvClient, 'checkLeakyBucketLimit').mockRejectedValueOnce(new Error('offline'));
	await expect(f.runner.run(payload)).resolves.toBeUndefined();
});

it('a bot-authored payload never moderates even when the bot has permission', async () => {
	const f = await fixture();
	const role = (await f.deps.guildRepository.getRole(createRoleID(BigInt(f.bot.botRoleId)), f.guildId))!;
	await f.deps.guildRepository.upsertRole({...role.toRow(), permissions: role.permissions | Permissions.BAN_MEMBERS});
	await f.run(`#ban ${f.target.userId}`, {...f.author, userId: f.bot.botUserId});
	expect(await f.deps.guildRepository.getBan(f.guildId, f.targetId)).toBeNull();
	expect(f.send).not.toHaveBeenCalled();
});
