// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRoleID, createWebhookID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {createMicupBotAutomodRunner} from '@app/api/guild/micupbot/MicupBotAutomod';
import * as Bot from '@app/api/guild/micupbot/MicupBotBot';
import * as Hook from '@app/api/guild/micupbot/MicupBotMessageHook';
import * as Cache from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {
	CHANNEL_ID,
	captureHookWarnings,
	createHookFixture,
	drainHook,
	hookInput,
	NOW,
	rule,
	setHookFlags,
	settings,
} from '@app/api/guild/micupbot/tests/MicupBotHookTestUtils';
import * as Registry from '@app/api/middleware/ServiceRegistry';
import {getLimitConfigService, getMicupBotLevels, getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures, GuildMFALevel} from '@fluxer/constants/src/GuildConstants';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('MicupBotMessageHook', () => {
	let harness: ApiTestHarness;
	const originalBotId = Config.instance.micupBotApplicationId;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		Config.instance.micupBotApplicationId = '999';
		overrideLimits({feature_micupbot: 1});
	});
	afterEach(async () => {
		await drainHook();
		Config.instance.micupBotApplicationId = originalBotId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness.shutdown();
	});

	function spies() {
		const config = {settings: settings(), rules: [rule()]};
		return {
			config,
			read: vi.spyOn(Cache, 'getMicupBotGuildConfig').mockResolvedValue(config),
			award: vi.spyOn(getMicupBotLevels(), 'award').mockResolvedValue(null),
			jobs: vi.spyOn(Registry.getWorkerService(), 'addJob'),
		};
	}
	it("a bot's or webhook's #ban is not a command", async () => {
		const {read, award, jobs} = spies();
		const p = hookInput('#ban <@123>');
		Hook.notifyMicupBotMessage({...p, user: {...p.user, isBot: true} as typeof p.user});
		Hook.notifyMicupBotMessage({...p, message: {...p.message, webhookId: createWebhookID(12n)} as typeof p.message});
		await drainHook();
		expect(jobs).not.toHaveBeenCalled();
		expect(award).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
	});
	it('#ban queues one command job keyed by the message and gives no xp', async () => {
		const {read, jobs, award} = spies();
		const p = hookInput('#BaN <@123>');
		Hook.notifyMicupBotMessage(p);
		await drainHook();
		expect(jobs).toHaveBeenCalledExactlyOnceWith(
			'runMicupBotCommand',
			{
				guild_id: p.guild!.id,
				channel_id: p.channel.id.toString(),
				message_id: p.message.id.toString(),
				author_id: p.user.id.toString(),
				content: p.message.content,
				at: expect.any(Number),
			},
			{jobKey: p.message.id.toString(), skipLedger: true},
		);
		expect(read).toHaveBeenCalledTimes(1);
		expect(award).not.toHaveBeenCalled();
	});
	it("a member's sixth command within 10 s queues no job", async () => {
		const {jobs, award} = spies();
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const bucket = vi.spyOn(Registry.getKVClient(), 'checkLeakyBucketLimit');
		for (let i = 0; i < 6; i++) Hook.notifyMicupBotMessage(hookInput('#help'));
		await drainHook();
		expect(jobs).toHaveBeenCalledTimes(5);
		expect(award).not.toHaveBeenCalled();
		expect(bucket).toHaveBeenCalledWith(`micupbot:cmd:u:${hookInput().guild!.id}:${hookInput().user.id}`, 5, 10_000, 1);
	});
	it('a command message breaking a rule queues the automod job, not the command', async () => {
		const {jobs, award} = spies();
		Hook.notifyMicupBotMessage(hookInput('#help yasak'));
		await drainHook();
		expect(jobs).toHaveBeenCalledExactlyOnceWith(
			'applyMicupBotAutomodAction',
			expect.objectContaining({rule: 'words'}),
			expect.anything(),
		);
		expect(award).not.toHaveBeenCalled();
	});
	it('a full command bucket still checks the spam rule', async () => {
		const {config, jobs} = spies();
		config.rules = [rule({rule: 'spam', threshold: 6})];
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		for (let i = 0; i < 7; i++) {
			Hook.notifyMicupBotMessage(hookInput('#help'));
			await drainHook();
		}
		expect(jobs.mock.calls.filter(([task]) => task === 'runMicupBotCommand')).toHaveLength(5);
		expect(jobs.mock.calls.filter(([task]) => task === 'applyMicupBotAutomodAction')).toHaveLength(1);
		expect(jobs.mock.calls.at(-1)?.[1]).toMatchObject({rule: 'spam'});
	});
	it('endpoint parsing is reused until the settings snapshot changes', async () => {
		const {config, read} = spies();
		const parse = vi.spyOn(globalThis, 'URL');
		Hook.notifyMicupBotMessage(hookInput());
		await drainHook();
		expect(parse).toHaveBeenCalled();
		parse.mockClear();
		Hook.notifyMicupBotMessage(hookInput());
		await drainHook();
		expect(parse).not.toHaveBeenCalled();
		read.mockResolvedValue({...config, settings: {...config.settings, version: 1}});
		Hook.notifyMicupBotMessage(hookInput());
		await drainHook();
		expect(parse).toHaveBeenCalled();
	});
	it.each([
		['a #help with an invite is deleted by automod', false],
		['an edited message adding an invite is deleted by automod', true],
	] as const)('%s', async (_name, edited) => {
		const f = await createHookFixture(harness);
		await setHookFlags(f.guild.id, [
			GuildFeatures.MICUPBOT_COMMANDS,
			GuildFeatures.MICUPBOT_LEVELS,
			GuildFeatures.MICUPBOT_AUTOMOD,
		]);
		vi.spyOn(Cache, 'getMicupBotGuildConfig').mockResolvedValue({
			settings: settings(),
			rules: [rule({rule: 'invites', action: 'delete'})],
		});
		const award = vi.spyOn(getMicupBotLevels(), 'award').mockResolvedValue(null);
		const jobs = vi.spyOn(Registry.getWorkerService(), 'addJob');
		const path = `/channels/${f.systemChannel.id}/messages`;
		const content = '#help discord.gg/abc';
		const message = await createBuilder<MessageResponse>(harness, f.members[0]!.token)
			.post(path)
			.body({content: edited ? 'hello' : content})
			.expect(200)
			.execute();
		await drainHook();
		if (edited) {
			jobs.mockClear();
			award.mockClear();
			await createBuilder(harness, f.members[0]!.token)
				.patch(`${path}/${message.id}`)
				.body({content})
				.expect(200)
				.execute();
			await drainHook();
		}
		const botJobs = jobs.mock.calls.filter(([task]) => task.toLowerCase().includes('micupbot'));
		expect(botJobs).toHaveLength(1);
		expect(botJobs[0]![0]).toBe('applyMicupBotAutomodAction');
		expect(award).not.toHaveBeenCalled();
		const {guild_id, channel_id, message_id, author_id, rule: automodRule, action, mute_seconds, at} = botJobs[0]![1];
		if (
			typeof guild_id !== 'string' ||
			typeof channel_id !== 'string' ||
			typeof message_id !== 'string' ||
			typeof author_id !== 'string' ||
			automodRule !== 'invites' ||
			action !== 'delete' ||
			typeof mute_seconds !== 'number' ||
			typeof at !== 'number'
		) {
			throw new Error('Expected an invite deletion automod payload');
		}
		await createMicupBotAutomodRunner(f.deps).run({
			guild_id,
			channel_id,
			message_id,
			author_id,
			rule: automodRule,
			action,
			mute_seconds,
			at,
		});
		await createBuilder(harness, f.members[0]!.token).get(`${path}/${message.id}`).expect(404).execute();
	});
	it('an edited command checks automod without queuing commands or awarding xp', async () => {
		const f = await createHookFixture(harness);
		const path = `/channels/${f.systemChannel.id}/messages`;
		const message = await createBuilder<MessageResponse>(harness, f.members[0]!.token)
			.post(path)
			.body({content: 'hello'})
			.expect(200)
			.execute();
		await setHookFlags(f.guild.id, [
			GuildFeatures.MICUPBOT_COMMANDS,
			GuildFeatures.MICUPBOT_LEVELS,
			GuildFeatures.MICUPBOT_AUTOMOD,
		]);
		const {read, jobs, award} = spies();
		await createBuilder(harness, f.members[0]!.token)
			.patch(`${path}/${message.id}`)
			.body({content: '#help'})
			.expect(200)
			.execute();
		await drainHook();
		expect(read).toHaveBeenCalledTimes(1);
		expect(jobs.mock.calls.filter(([task]) => task.toLowerCase().includes('micupbot'))).toHaveLength(0);
		expect(award).not.toHaveBeenCalled();
	});
	it('a plain message gives xp through award once', async () => {
		const {award, jobs} = spies();
		const p = hookInput();
		Hook.notifyMicupBotMessage(p);
		await drainHook();
		expect(award).toHaveBeenCalledExactlyOnceWith({
			guildId: BigInt(p.guild!.id),
			userId: p.user.id,
			channelId: p.channel.id,
			xp: expect.any(Number),
			source: 'message',
		});
		expect(award.mock.calls[0]![0].xp).toBeGreaterThanOrEqual(15);
		expect(award.mock.calls[0]![0].xp).toBeLessThanOrEqual(25);
		expect(jobs).not.toHaveBeenCalled();
	});
	it('no-xp channels and roles get no xp', async () => {
		const {config, award} = spies();
		config.settings.no_xp_channel_ids = new Set([CHANNEL_ID]);
		Hook.notifyMicupBotMessage(hookInput());
		await drainHook();
		config.settings.no_xp_channel_ids = null;
		config.settings.no_xp_role_ids = new Set([createRoleID(12n)]);
		const p = hookInput();
		p.member!.roles = ['12'];
		Hook.notifyMicupBotMessage(p);
		await drainHook();
		expect(award).not.toHaveBeenCalled();
	});
	it('a message breaking a rule queues one automod job and gives no xp', async () => {
		const {jobs, award} = spies();
		const p = hookInput('yasak');
		Hook.notifyMicupBotMessage(p);
		await drainHook();
		expect(jobs).toHaveBeenCalledExactlyOnceWith(
			'applyMicupBotAutomodAction',
			{
				guild_id: p.guild!.id,
				channel_id: p.channel.id.toString(),
				message_id: p.message.id.toString(),
				author_id: p.user.id.toString(),
				rule: 'words',
				action: 'delete_warn',
				mute_seconds: 600,
				at: expect.any(Number),
			},
			{jobKey: `am:${p.message.id}`, skipLedger: true},
		);
		expect(award).not.toHaveBeenCalled();
	});
	it('exempt roles and channels are not checked', async () => {
		const {config, jobs, award} = spies();
		config.rules = [
			rule({rule: 'spam', exempt_channel_ids: new Set([CHANNEL_ID])}),
			rule({exempt_channel_ids: new Set([CHANNEL_ID])}),
		];
		const bucket = vi.spyOn(Registry.getKVClient(), 'checkLeakyBucketLimit');
		Hook.notifyMicupBotMessage(hookInput('yasak'));
		await drainHook();
		config.rules = [
			rule({rule: 'spam', exempt_role_ids: new Set([createRoleID(12n)])}),
			rule({exempt_role_ids: new Set([createRoleID(12n)])}),
		];
		const p = hookInput('yasak');
		p.member!.roles = ['12'];
		Hook.notifyMicupBotMessage(p);
		await drainHook();
		expect(jobs).not.toHaveBeenCalled();
		expect(bucket).not.toHaveBeenCalled();
		expect(award).toHaveBeenCalledTimes(2);
	});
	it('spam trips the leaky bucket', async () => {
		const {config, jobs, award} = spies();
		config.rules = [rule({rule: 'spam', threshold: 3})];
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		for (let i = 0; i < 4; i++) {
			Hook.notifyMicupBotMessage(hookInput());
			await drainHook();
		}
		expect(jobs).toHaveBeenCalledTimes(1);
		expect(jobs.mock.calls[0]![1]).toMatchObject({rule: 'spam'});
		expect(award).toHaveBeenCalledTimes(3);
	});
	it('an elevated-MFA community queues no automod job', async () => {
		const {config, jobs, award} = spies();
		config.rules.push(rule({rule: 'spam'}));
		const bucket = vi.spyOn(Registry.getKVClient(), 'checkLeakyBucketLimit');
		const p = hookInput('yasak');
		p.guild!.mfa_level = GuildMFALevel.ELEVATED;
		Hook.notifyMicupBotMessage(p);
		await drainHook();
		expect(jobs).not.toHaveBeenCalled();
		expect(bucket).not.toHaveBeenCalled();
		expect(award).toHaveBeenCalledTimes(1);
		Hook.notifyMicupBotMessage({...p, message: {...p.message, content: '#help'} as typeof p.message});
		await drainHook();
		expect(jobs).toHaveBeenCalledTimes(1);
	});
	it('past 1000 in-flight hook tasks new ones are dropped and counted', async () => {
		const {read, config, jobs} = spies();
		let release!: (value: Cache.MicupBotGuildConfig) => void;
		read.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const warn = captureHookWarnings();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
		try {
			for (let i = 0; i < 1000; i++) Hook.notifyMicupBotMessage(hookInput());
			Hook.notifyMicupBotMessage(hookInput('#help'));
			expect(read).toHaveBeenCalledTimes(1000);
			expect(jobs).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(expect.objectContaining({dropped: 1}), expect.any(String));
			Hook.notifyMicupBotMessage(hookInput());
			expect(warn).toHaveBeenCalledTimes(1);
			clock.mockReturnValue(NOW + 60_001);
			Hook.notifyMicupBotMessage(hookInput());
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			release(config);
			await drainHook();
		}
	});
	it('at 800 in-flight tasks xp is dropped but commands are admitted', async () => {
		const {award, jobs} = spies();
		let release!: () => void;
		const pending = new Promise<null>((resolve) => {
			release = () => resolve(null);
		});
		award.mockReturnValue(pending);
		const p = hookInput();
		p.guild!.features = [GuildFeatures.MICUPBOT_LEVELS];
		try {
			for (let i = 0; i < 800; i++) Hook.notifyMicupBotMessage(p);
			await drainHook();
			expect(award).toHaveBeenCalledTimes(800);
			Hook.notifyMicupBotMessage(p);
			Hook.notifyMicupBotMessage(hookInput('#help'));
			await drainHook();
			expect(award).toHaveBeenCalledTimes(800);
			expect(jobs).toHaveBeenCalledTimes(1);
		} finally {
			release();
			await drainHook();
		}
	});
	it('DMs, system messages and a disabled instance do no bot work', async () => {
		const {read, jobs, award} = spies();
		const p = hookInput();
		Hook.notifyMicupBotMessage({...p, guild: null});
		Hook.notifyMicupBotMessage({...p, message: {...p.message, type: MessageTypes.USER_JOIN} as typeof p.message});
		overrideLimits({feature_micupbot: 0});
		Hook.notifyMicupBotMessage(p);
		await drainHook();
		expect(read).not.toHaveBeenCalled();
		expect(jobs).not.toHaveBeenCalled();
		expect(award).not.toHaveBeenCalled();
	});
	it('a missing worker service is contained and releases its flight', async () => {
		spies();
		vi.spyOn(Registry, 'getWorkerService').mockImplementation(() => {
			throw new Error('worker unavailable');
		});
		const warn = captureHookWarnings();
		expect(() => Hook.notifyMicupBotMessage(hookInput('#help'))).not.toThrow();
		await drainHook();
		expect(warn).toHaveBeenCalled();
	});
	it('a message in a community without MicupBOT flags touches no KV, Cassandra or queue', async () => {
		const f = await createHookFixture(harness);
		const kv = Registry.getKVClient();
		const repository = getMicupBotRepository();
		const reads = vi.spyOn(repository, 'getSettings');
		const rules = vi.spyOn(repository, 'listRules');
		const jobs = vi.spyOn(Registry.getWorkerService(), 'addJob');
		const get = vi.spyOn(kv, 'get');
		const set = vi.spyOn(kv, 'setex');
		const nx = vi.spyOn(kv, 'setnx');
		const bucket = vi.spyOn(kv, 'checkLeakyBucketLimit');
		const counter = vi.spyOn(kv, 'counterAdd');
		const live = vi.spyOn(Bot, 'isMicupBotLive');
		const hook = vi.spyOn(Hook, 'notifyMicupBotMessage');
		await createBuilder(harness, f.members[0]!.token)
			.post(`/channels/${f.systemChannel.id}/messages`)
			.body({content: '#ban'})
			.expect(200)
			.execute();
		await drainHook();
		expect(reads).not.toHaveBeenCalled();
		expect(rules).not.toHaveBeenCalled();
		expect(live).not.toHaveBeenCalled();
		// The route itself persists the message; only MicupBOT must add zero IO.
		for (const spy of [get, set, nx, bucket, counter])
			expect(spy.mock.calls.filter(([key]) => key.includes('micupbot'))).toHaveLength(0);
		expect(jobs.mock.calls.filter(([task]) => task.toLowerCase().includes('micupbot'))).toHaveLength(0);
		expect(hook).toHaveBeenCalledTimes(1);
		const input = hook.mock.calls[0]![0];
		const io = [get, set, nx, bucket, counter, reads, rules, jobs];
		for (const spy of io) spy.mockClear();
		// Replay the exact route input so even IO under an unrelated key cannot hide among the route's own work.
		Hook.notifyMicupBotMessage(input);
		await drainHook();
		for (const spy of io) expect(spy).not.toHaveBeenCalled();
	});
	it('a throwing hook never fails the message route', async () => {
		const f = await createHookFixture(harness);
		await setHookFlags(f.guild.id, [GuildFeatures.MICUPBOT_LEVELS]);
		vi.spyOn(Cache, 'getMicupBotGuildConfig').mockResolvedValue({settings: settings(), rules: []});
		const award = vi.spyOn(getMicupBotLevels(), 'award').mockRejectedValue(new Error('award failed'));
		await createBuilder<MessageResponse>(harness, f.members[0]!.token)
			.post(`/channels/${f.systemChannel.id}/messages`)
			.body({content: 'hi'})
			.expect(200)
			.execute();
		await drainHook();
		expect(award).toHaveBeenCalledTimes(1);
	});
	it('a hook that throws synchronously never fails the message route', async () => {
		const f = await createHookFixture(harness);
		await setHookFlags(f.guild.id, [GuildFeatures.MICUPBOT_LEVELS]);
		const live = vi.spyOn(Bot, 'isMicupBotLive').mockImplementation(() => {
			throw new Error('synchronous failure');
		});
		await createBuilder(harness, f.members[0]!.token)
			.post(`/channels/${f.systemChannel.id}/messages`)
			.body({content: 'hi'})
			.expect(200)
			.execute();
		expect(live).toHaveBeenCalledTimes(1);
		expect(getLimitConfigService()).toBeDefined();
	});
});
