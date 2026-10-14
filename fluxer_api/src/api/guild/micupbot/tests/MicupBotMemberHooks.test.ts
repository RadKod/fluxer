// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {notifyMicupBotMemberJoin, notifyMicupBotMemberLeave} from '@app/api/guild/micupbot/MicupBotMemberHooks';
import * as SettingsCache from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {drainMemberHooks, useMemberFixture} from '@app/api/guild/micupbot/tests/MicupBotMemberTestUtils';
import {Logger} from '@app/api/Logger';
import * as Registry from '@app/api/middleware/ServiceRegistry';
import {removeGuildMemberCounted} from '@app/api/middleware/ServiceSingletons';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {expect, it, vi} from 'vitest';

const fixture = useMemberFixture();

it('a join in a community without MICUPBOT_JOIN queues nothing', async () => {
	const f = await fixture();
	notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.userId, user: f.user, isTemporary: false});
	expect(f.jobs).toHaveBeenCalledWith(
		'handleMicupBotMemberEvent',
		expect.objectContaining({kind: 'join', temporary: false}),
		expect.objectContaining({skipLedger: true}),
	);
	f.jobs.mockClear();
	f.guildModel.features.delete(GuildFeatures.MICUPBOT_JOIN);
	const config = vi.spyOn(SettingsCache, 'getMicupBotGuildConfig');
	const kv = vi.spyOn(Registry, 'getKVClient');
	notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.userId, user: f.user, isTemporary: false});
	expect(f.jobs).not.toHaveBeenCalled();
	expect(config).not.toHaveBeenCalled();
	expect(kv).not.toHaveBeenCalled();
});

it('a bot joining gets no welcome and no auto role', async () => {
	const f = await fixture();
	const bot = (await f.deps.userRepository.findUnique(f.botId))!;
	notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.botId, user: bot, isTemporary: false});
	expect(f.jobs).toHaveBeenCalledWith(
		'handleMicupBotMemberEvent',
		expect.objectContaining({kind: 'bot_join'}),
		expect.anything(),
	);
	await f.runner.run({...f.payload, user_id: String(f.botId)});
	expect(f.send).not.toHaveBeenCalled();
	expect(f.grant).not.toHaveBeenCalled();
	f.jobs.mockClear();
	vi.spyOn(f.deps.userRepository, 'findUnique').mockResolvedValue(bot);
	notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.userId, user: bot, isTemporary: false});
	expect(f.jobs).not.toHaveBeenCalled();
});

it('a temporary member gets no welcome and no goodbye', async () => {
	const f = await fixture();
	const config = vi.spyOn(SettingsCache, 'getMicupBotGuildConfig');
	await f.rejoin(true);
	await removeGuildMemberCounted(f.deps.guildRepository, f.guildId, f.userId);
	await drainMemberHooks();
	expect(f.jobs.mock.calls.filter(([name]) => name === 'handleMicupBotMemberEvent')).toHaveLength(0);
	expect(config).not.toHaveBeenCalled();
	await f.runner.run({...f.payload, temporary: true});
	await f.runner.run({...f.payload, kind: 'leave', temporary: true});
	expect(f.send).not.toHaveBeenCalled();
});

it('a join hook failure never fails the join', async () => {
	const f = await fixture();
	const warn = vi.spyOn(Logger.child({}), 'warn');
	// Only the MicupBOT queue fails; the member write's own thread-membership job still queues.
	f.jobs.mockImplementation((async (task: string) => {
		if (task === 'handleMicupBotMemberEvent') throw new Error('queue unavailable');
		return 0n;
	}) as never);
	await expect(f.rejoin()).resolves.toMatchObject({userId: f.userId});
	expect(warn).toHaveBeenCalledWith(expect.objectContaining({error: expect.any(Error)}), expect.any(String));
});

it('a leave hook failure never fails the leave', async () => {
	const f = await fixture();
	const warn = vi.spyOn(Logger.child({}), 'warn');
	const config = vi.spyOn(SettingsCache, 'getMicupBotGuildConfig').mockImplementation(() => {
		throw new Error('config unavailable');
	});
	await expect(removeGuildMemberCounted(f.deps.guildRepository, f.guildId, f.userId)).resolves.toBe(true);
	expect(config).toHaveBeenCalledOnce();
	expect(warn).toHaveBeenCalledWith(expect.objectContaining({error: expect.any(Error)}), expect.any(String));
	config.mockRejectedValue(new Error('async config failure'));
	expect(
		notifyMicupBotMemberLeave({guildId: f.guildId, userId: f.userId, removed: true, temporary: false}),
	).toBeUndefined();
	await drainMemberHooks();
	expect(warn).toHaveBeenCalledTimes(2);
});

it('a pending goodbye lookup never delays member removal and removed false reads nothing', async () => {
	const f = await fixture();
	const original = await SettingsCache.getMicupBotGuildConfig(f.guildId);
	let resolve!: (value: typeof original) => void;
	const config = vi.spyOn(SettingsCache, 'getMicupBotGuildConfig').mockReturnValue(
		new Promise((r) => {
			resolve = r;
		}),
	);
	await expect(removeGuildMemberCounted(f.deps.guildRepository, f.guildId, f.userId)).resolves.toBe(true);
	expect(f.jobs.mock.calls.filter(([name]) => name === 'handleMicupBotMemberEvent')).toHaveLength(0);
	resolve(original);
	await drainMemberHooks();
	expect(f.jobs).toHaveBeenCalledWith(
		'handleMicupBotMemberEvent',
		expect.objectContaining({kind: 'leave'}),
		expect.objectContaining({skipLedger: true}),
	);
	config.mockClear();
	notifyMicupBotMemberLeave({guildId: f.guildId, userId: f.userId, removed: false, temporary: false});
	expect(config).not.toHaveBeenCalled();
});

it('the bot joining writes the flags from the settings and leaving clears them', async () => {
	const f = await fixture({commands_enabled: true, levels_enabled: true, voice_xp_enabled: true});
	const voice = vi.spyOn(f.repository, 'setVoiceGuild');
	await f.runner.run({...f.payload, kind: 'bot_join', user_id: String(f.botId)});
	for (const flag of [GuildFeatures.MICUPBOT_JOIN, GuildFeatures.MICUPBOT_COMMANDS, GuildFeatures.MICUPBOT_LEVELS])
		expect((await f.deps.guildRepository.findUnique(f.guildId))!.features.has(flag)).toBe(true);
	expect(voice).toHaveBeenLastCalledWith(f.guildId, true);
	await f.runner.run({...f.payload, kind: 'bot_leave', user_id: String(f.botId)});
	expect(
		[...(await f.deps.guildRepository.findUnique(f.guildId))!.features].filter((flag) => flag.startsWith('MICUPBOT_')),
	).toEqual([]);
	expect(voice).toHaveBeenLastCalledWith(f.guildId, false);
	expect(f.send).not.toHaveBeenCalled();
});

it('bot membership hooks queue while disabled but ordinary member hooks do nothing', async () => {
	const f = await fixture();
	const bot = (await f.deps.userRepository.findUnique(f.botId))!;
	const config = vi.spyOn(SettingsCache, 'getMicupBotGuildConfig');
	overrideLimits({feature_micupbot: 0});
	notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.botId, user: bot, isTemporary: false});
	notifyMicupBotMemberLeave({guildId: f.guildId, userId: f.botId, removed: true, temporary: false});
	notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.userId, user: f.user, isTemporary: false});
	notifyMicupBotMemberLeave({guildId: f.guildId, userId: f.userId, removed: true, temporary: false});
	await drainMemberHooks();
	expect(f.jobs.mock.calls.map(([, payload]) => payload.kind)).toEqual(['bot_join', 'bot_leave']);
	expect(config).not.toHaveBeenCalled();
	f.jobs.mockClear();
	Config.instance.micupBotApplicationId = undefined;
	notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.botId, user: bot, isTemporary: false});
	notifyMicupBotMemberLeave({guildId: f.guildId, userId: f.botId, removed: true, temporary: false});
	expect(f.jobs).not.toHaveBeenCalled();
});

it.each(['bot_join', 'bot_leave'] as const)('disabled %s synchronizes flags and voice slots', async (kind) => {
	const f = await fixture({commands_enabled: true, levels_enabled: true, voice_xp_enabled: true});
	const voice = vi.spyOn(f.repository, 'setVoiceGuild');
	if (kind === 'bot_leave') await f.runner.run({...f.payload, kind: 'bot_join', user_id: String(f.botId)});
	voice.mockClear();
	overrideLimits({feature_micupbot: 0});
	await f.runner.run({...f.payload, kind, user_id: String(f.botId)});
	const flags = [...(await f.deps.guildRepository.findUnique(f.guildId))!.features].filter((flag) =>
		flag.startsWith('MICUPBOT_'),
	);
	expect(flags.sort()).toEqual(
		kind === 'bot_join'
			? [GuildFeatures.MICUPBOT_JOIN, GuildFeatures.MICUPBOT_COMMANDS, GuildFeatures.MICUPBOT_LEVELS].sort()
			: [],
	);
	expect(voice).toHaveBeenLastCalledWith(f.guildId, kind === 'bot_join');
	await f.runner.run(f.payload);
	await f.runner.run({...f.payload, kind: 'leave'});
	expect(f.send).not.toHaveBeenCalled();
	expect(f.grant).not.toHaveBeenCalled();
});

it('member hooks bound pending work and summarize overload once per minute', async () => {
	const f = await fixture();
	let resolve!: (value: bigint) => void;
	const pending = new Promise<bigint>((r) => {
		resolve = r;
	});
	f.jobs.mockReturnValue(pending);
	const warn = vi.spyOn(Logger.child({}), 'warn');
	const now = Date.now() + 120_000;
	const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
	try {
		for (let i = 0; i < 1002; i++)
			notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.userId, user: f.user, isTemporary: false});
		expect(f.jobs).toHaveBeenCalledTimes(1000);
		expect(warn).toHaveBeenCalledOnce();
		clock.mockReturnValue(now + 59_999);
		notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.userId, user: f.user, isTemporary: false});
		expect(warn).toHaveBeenCalledOnce();
		clock.mockReturnValue(now + 60_000);
		notifyMicupBotMemberJoin({guild: f.guildModel, userId: f.userId, user: f.user, isTemporary: false});
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenLastCalledWith({hook_skipped: 3}, 'MicupBOT hook capacity exceeded');
	} finally {
		resolve(0n);
		await drainMemberHooks();
	}
});
