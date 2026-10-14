// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createChannelID,
	createGuildID,
	createRoleID,
	createUserID,
	type GuildID,
	type UserID,
} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {GuildMemberRow} from '@app/api/database/types/GuildTypes';
import type {MicupBotGuildSettingsRow} from '@app/api/database/types/MicupBotTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_VOICE} from '@app/api/guild/micupbot/MicupBotConstants';
import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {invalidateMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {createMicupBotVoiceRunner, type MicupBotVoiceCounts} from '@app/api/guild/micupbot/MicupBotVoice';
import {levelSettings} from '@app/api/guild/micupbot/tests/MicupBotLevelsTestUtils';
import {Logger} from '@app/api/Logger';
import {getGatewayService, getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getGuildRepository,
	getLimitConfigService,
	getMicupBotRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {VOICE_STATE_KV_KEY_PREFIX} from '@app/api/rpc/RpcService';
import {Users} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {afterAll, afterEach, beforeAll, beforeEach, expect, expectTypeOf, it, vi} from 'vitest';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const TURN = Math.floor(NOW / MICUPBOT_VOICE.turnMs);
const GUILD = createGuildID(20n << 22n);
const USER_A = createUserID(101n);
const USER_B = createUserID(102n);
const USER_C = createUserID(103n);
const NO_XP_ROLE = createRoleID(301n);
const CHANNEL = createChannelID(201n);
const AFK = createChannelID(202n);
const PAYLOAD = {turn: TURN, slot_start: 16};
const ZERO: MicupBotVoiceCounts = {guilds: 0, awarded: 0, capped: 0, failed: 0};
let harness: ApiTestHarness;
let applicationId: string | undefined;
let deps: WorkerDependencies;
const cachedGuilds = new Set<GuildID>();

beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	await harness.reset();
	applicationId = Config.instance.micupBotApplicationId;
	Config.instance.micupBotApplicationId = '900000000000000001';
	overrideLimits({feature_micupbot: 1});
	vi.spyOn(Date, 'now').mockReturnValue(NOW);
	deps = {
		kvClient: getKVClient(),
		workerService: getWorkerService(),
		guildRepository: getGuildRepository(),
		userRepository: getUserRepository(),
		limitConfigService: getLimitConfigService(),
		gatewayService: getGatewayService(),
	} as WorkerDependencies;
});
afterEach(async () => {
	vi.restoreAllMocks();
	Config.instance.micupBotApplicationId = applicationId;
	for (const guildId of cachedGuilds) await invalidateMicupBotGuildConfig(guildId);
	cachedGuilds.clear();
});
afterAll(async () => {
	await harness?.shutdown();
});

async function seedGuild(guildId = GUILD, patch: Partial<MicupBotGuildSettingsRow> = {}) {
	cachedGuilds.add(guildId);
	await invalidateMicupBotGuildConfig(guildId);
	await deps.guildRepository.upsertPartial(guildId, {
		owner_id: USER_A,
		name: 'Voice XP',
		features: new Set([GuildFeatures.MICUPBOT_LEVELS]),
		afk_channel_id: AFK,
	});
	await getMicupBotRepository().putSettings(levelSettings(guildId, {voice_xp_enabled: true, ...patch}), null);
	await getMicupBotRepository().setVoiceGuild(guildId, true);
	for (const userId of [USER_A, USER_B]) await seedMember(userId, guildId);
}

async function seedMember(userId: UserID, guildId = GUILD, patch: Partial<GuildMemberRow> = {}) {
	await upsertOne(
		Users.patchByPk(
			{user_id: userId},
			{username: Db.set(`voice${userId}`), discriminator: Db.set(0), bot: Db.set(false)},
		),
	);
	await deps.guildRepository.upsertMember({
		guild_id: guildId,
		user_id: userId,
		joined_at: new Date(NOW),
		nick: null,
		avatar_hash: null,
		banner_hash: null,
		bio: null,
		pronouns: null,
		accent_color: null,
		join_source_type: null,
		source_invite_code: null,
		inviter_id: null,
		deaf: false,
		mute: false,
		communication_disabled_until: null,
		role_ids: null,
		is_premium_sanitized: null,
		temporary: false,
		profile_flags: null,
		version: 0,
		...patch,
	});
}

async function voice(
	userId: UserID,
	patch: Record<string, unknown> = {},
	connection = String(userId),
	guildId = GUILD,
) {
	await deps.kvClient.hset(
		VOICE_STATE_KV_KEY_PREFIX + String(guildId),
		connection,
		JSON.stringify({
			guild_id: String(guildId),
			user_id: String(userId),
			channel_id: String(CHANNEL),
			deaf: false,
			self_deaf: false,
			mute: false,
			self_mute: false,
			...patch,
		}),
	);
}

function dailyKey(userId: UserID, guildId = GUILD, day = '2026-10-03') {
	return `micupbot:vday:${guildId}:${userId}:${day}`;
}

it('queueSlots enqueues 256 jobs keyed by turn and slot', async () => {
	const jobs = vi.spyOn(deps.workerService, 'addJob');
	expect(await createMicupBotVoiceRunner(deps).queueSlots(NOW + 299_999)).toBe(256);
	expect(jobs).toHaveBeenCalledTimes(256);
	for (const [index, call] of jobs.mock.calls.entries()) {
		expect(call).toEqual([
			'runMicupBotVoiceSlots',
			{turn: TURN, slot_start: index * 16},
			{jobKey: `v:${TURN}:${index * 16}`, skipLedger: true},
		]);
	}
});

it('flag off → no jobs', async () => {
	overrideLimits({feature_micupbot: 0});
	const jobs = vi.spyOn(deps.workerService, 'addJob');
	const slots = vi.spyOn(getMicupBotRepository(), 'listVoiceSlot');
	const hash = vi.spyOn(deps.kvClient, 'hgetall');
	const runner = createMicupBotVoiceRunner(deps);
	expect(await runner.queueSlots(NOW)).toBe(0);
	expect(await runner.runSlots(PAYLOAD)).toEqual(ZERO);
	expect(jobs).not.toHaveBeenCalled();
	expect(slots).not.toHaveBeenCalled();
	expect(hash).not.toHaveBeenCalled();
});

it('runSlots reads only its 16 slot partitions', async () => {
	const repository = getMicupBotRepository();
	const ids = Array.from({length: 501}, (_, i) => createGuildID((20n << 22n) + BigInt(i)));
	for (const id of ids) await repository.setVoiceGuild(id, true);
	const outside = createGuildID(32n << 22n);
	await repository.setVoiceGuild(outside, true);
	const slots = vi.spyOn(repository, 'listVoiceSlot');
	const find = vi.spyOn(deps.guildRepository, 'findUnique');
	const result = await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD);
	expectTypeOf(result).toEqualTypeOf<MicupBotVoiceCounts>();
	expect(result).toEqual({...ZERO, guilds: 501});
	expect(slots.mock.calls).toEqual(
		Array.from({length: 16}, (_, i) => i + 16).flatMap((slot) =>
			slot === 20
				? [
						[slot, null, 500],
						[slot, ids[499], 500],
					]
				: [[slot, null, 500]],
		),
	);
	expect(find.mock.calls.map(([id]) => id)).toEqual(ids);
	expect(await repository.listVoiceSlot(32, null, 500)).toEqual([outside]);
});

it('two listeners in a channel each get 10 xp', async () => {
	await seedGuild();
	await voice(USER_A, {mute: true, self_mute: true});
	await voice(USER_B);
	const gateway = vi.spyOn(deps.gatewayService, 'getVoiceState');
	const runner = createMicupBotVoiceRunner(deps);
	const levels = createMicupBotLevels(deps);
	expect(await runner.runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1, awarded: 2});
	for (const user of [USER_A, USER_B]) {
		expect((await levels.getMemberStats(GUILD, user)).xp).toBe(10);
		expect(await deps.kvClient.get(dailyKey(user))).toBe('1');
		expect(await deps.kvClient.ttl(dailyKey(user))).toBe(172800);
	}
	const expire = vi.spyOn(deps.kvClient, 'expire');
	const jobs = vi.spyOn(deps.workerService, 'addJob');
	for (let i = 1; i < 10; i++) await runner.runSlots({...PAYLOAD, turn: TURN + i});
	const levelJobs = jobs.mock.calls.filter(([task]) => task === 'handleMicupBotLevelUp');
	expect(levelJobs).toHaveLength(2);
	for (const [, payload] of levelJobs) expect(payload).toMatchObject({channel_id: null, level: 1});
	expect(expire.mock.calls.filter(([key]) => key.startsWith('micupbot:vday:'))).toHaveLength(0);
	expect(gateway).not.toHaveBeenCalled();
});

it('a lone member, a deafened member and the AFK channel get nothing', async () => {
	await seedGuild();
	for (const id of [103n, 104n, 105n, 106n]) await seedMember(createUserID(id));
	await voice(USER_A);
	await voice(USER_B, {deaf: true});
	await voice(createUserID(103n), {self_deaf: true});
	await voice(createUserID(104n), {channel_id: String(AFK)});
	await voice(createUserID(105n), {channel_id: String(AFK)});
	await voice(createUserID(106n), {channel_id: null});
	const incr = vi.spyOn(deps.kvClient, 'incr');
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1});
	expect(incr).not.toHaveBeenCalled();
});

it('no-xp channels get nothing', async () => {
	await seedGuild(GUILD, {no_xp_channel_ids: new Set([CHANNEL])});
	await voice(USER_A);
	await voice(USER_B);
	const incr = vi.spyOn(deps.kvClient, 'incr');
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1});
	expect(incr).not.toHaveBeenCalled();
});

it.each(['bot', 'temporary', 'no-xp role'])(
	'a %s listener and one eligible member get no voice XP',
	async (excluded) => {
		await seedGuild(GUILD, {no_xp_role_ids: new Set([NO_XP_ROLE])});
		await seedMember(USER_B, GUILD, {
			temporary: excluded === 'temporary',
			role_ids: excluded === 'no-xp role' ? new Set([NO_XP_ROLE]) : null,
		});
		if (excluded === 'bot') await deps.userRepository.patchUpsert(USER_B, {bot: true});
		await voice(USER_A);
		await voice(USER_B);
		const incr = vi.spyOn(deps.kvClient, 'incr');
		expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1});
		expect(incr).not.toHaveBeenCalled();
		for (const user of [USER_A, USER_B]) {
			expect((await createMicupBotLevels(deps).getMemberStats(GUILD, user)).xp).toBe(0);
		}
	},
);

it.each(['bot', 'temporary', 'no-xp role'])(
	'a %s listener gets no voice XP when two eligible members remain',
	async (excluded) => {
		await seedGuild(GUILD, {no_xp_role_ids: new Set([NO_XP_ROLE])});
		await seedMember(USER_C, GUILD, {
			temporary: excluded === 'temporary',
			role_ids: excluded === 'no-xp role' ? new Set([NO_XP_ROLE]) : null,
		});
		if (excluded === 'bot') await deps.userRepository.patchUpsert(USER_C, {bot: true});
		for (const user of [USER_A, USER_B, USER_C]) await voice(user);
		expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1, awarded: 2});
		const levels = createMicupBotLevels(deps);
		for (const user of [USER_A, USER_B]) expect((await levels.getMemberStats(GUILD, user)).xp).toBe(10);
		expect((await levels.getMemberStats(GUILD, USER_C)).xp).toBe(0);
		expect(await deps.kvClient.get(dailyKey(USER_C))).toBeNull();
	},
);

it('the 145th turn of a day gives nothing', async () => {
	await seedGuild();
	for (const user of [USER_A, USER_B]) {
		await voice(user);
		await deps.kvClient.setex(dailyKey(user), 172800, '143');
	}
	const runner = createMicupBotVoiceRunner(deps);
	expect(await runner.runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1, awarded: 2});
	expect(await runner.runSlots({...PAYLOAD, turn: TURN + 1})).toEqual({...ZERO, guilds: 1, capped: 2});
	for (const user of [USER_A, USER_B]) {
		expect((await createMicupBotLevels(deps).getMemberStats(GUILD, user)).xp).toBe(10);
		expect(await deps.kvClient.get(dailyKey(user))).toBe('145');
	}
});

it('a redelivered voice turn does not award completed guilds again', async () => {
	const laterGuild = createGuildID(22n << 22n);
	for (const guildId of [GUILD, laterGuild]) {
		await seedGuild(guildId);
		for (const user of [USER_A, USER_B]) await voice(user, {}, String(user), guildId);
	}
	const repository = getMicupBotRepository();
	const listVoiceSlot = repository.listVoiceSlot.bind(repository);
	const slots = vi.spyOn(repository, 'listVoiceSlot').mockImplementation((slot, after, limit) => {
		if (slot === 21) throw new Error('slot unavailable');
		return listVoiceSlot(slot, after, limit);
	});
	const runner = createMicupBotVoiceRunner(deps);
	await expect(runner.runSlots(PAYLOAD)).rejects.toThrow('slot unavailable');
	expect((await createMicupBotLevels(deps).getMemberStats(GUILD, USER_A)).xp).toBe(10);
	slots.mockRestore();
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 2, awarded: 2});
	for (const guildId of [GUILD, laterGuild]) {
		for (const user of [USER_A, USER_B]) {
			expect((await createMicupBotLevels(deps).getMemberStats(guildId, user)).xp).toBe(10);
			expect(await deps.kvClient.get(dailyKey(user, guildId))).toBe('1');
		}
		expect(await deps.kvClient.ttl(`micupbot:vturn:${guildId}:${TURN}`)).toBe(600);
	}
	expect(await runner.runSlots({...PAYLOAD, turn: TURN + 1})).toEqual({...ZERO, guilds: 2, awarded: 4});
	for (const guildId of [GUILD, laterGuild]) {
		expect((await createMicupBotLevels(deps).getMemberStats(guildId, USER_A)).xp).toBe(20);
		expect(await deps.kvClient.get(dailyKey(USER_A, guildId))).toBe('2');
	}
});

it('concurrent deliveries of one voice turn award each member once', async () => {
	await seedGuild();
	await voice(USER_A);
	await voice(USER_B);
	const results = await Promise.all([
		createMicupBotVoiceRunner(deps).runSlots(PAYLOAD),
		createMicupBotVoiceRunner(deps).runSlots(PAYLOAD),
	]);
	expect(results.reduce((total, result) => total + result.awarded, 0)).toBe(2);
	expect(results.reduce((total, result) => total + result.failed, 0)).toBe(0);
	for (const user of [USER_A, USER_B]) {
		expect((await createMicupBotLevels(deps).getMemberStats(GUILD, user)).xp).toBe(10);
		expect(await deps.kvClient.get(dailyKey(user))).toBe('1');
	}
});

it('a repeated voice turn skips member reads', async () => {
	await seedGuild();
	await voice(USER_A);
	await voice(USER_B);
	const runner = createMicupBotVoiceRunner(deps);
	await runner.runSlots(PAYLOAD);
	const hash = vi.spyOn(deps.kvClient, 'hgetall');
	const members = vi.spyOn(deps.guildRepository, 'getMember');
	const users = vi.spyOn(deps.userRepository, 'findUnique');
	expect(await runner.runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1});
	expect(hash).not.toHaveBeenCalled();
	expect(members).not.toHaveBeenCalled();
	expect(users).not.toHaveBeenCalled();
});

it('member eligibility reads are bounded and parallel within a guild', async () => {
	await seedGuild();
	for (let i = 0; i < 33; i++) {
		const userId = createUserID(101n + BigInt(i));
		await seedMember(userId);
		await voice(userId);
		await voice(userId, {channel_id: '203'}, `second-${userId}`);
	}
	let active = 0;
	let peak = 0;
	const getMember = deps.guildRepository.getMember.bind(deps.guildRepository);
	const members = vi.spyOn(deps.guildRepository, 'getMember').mockImplementation(async (guildId, userId) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const member = await getMember(guildId, userId);
		active--;
		return member;
	});
	const users = vi.spyOn(deps.userRepository, 'findUnique');
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1, awarded: 33});
	expect(peak).toBe(16);
	expect(members).toHaveBeenCalledTimes(33);
	expect(users).toHaveBeenCalledTimes(33);
});

it('a community without MICUPBOT_LEVELS is skipped and a deleted one leaves the slot table', async () => {
	await seedGuild();
	await deps.guildRepository.upsertPartial(GUILD, {features: new Set()});
	const deleted = createGuildID(21n << 22n);
	await getMicupBotRepository().setVoiceGuild(deleted, true);
	const remove = vi.spyOn(getMicupBotRepository(), 'setVoiceGuild');
	const hash = vi.spyOn(deps.kvClient, 'hgetall');
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 2});
	expect(remove).toHaveBeenCalledExactlyOnceWith(deleted, false);
	expect(await getMicupBotRepository().listVoiceSlot(21, null, 500)).toEqual([]);
	expect(hash).not.toHaveBeenCalled();
});

it('the walk summary counts awarded, capped and failed', async () => {
	await seedGuild();
	await voice(USER_A);
	await voice(USER_B);
	await deps.kvClient.setex(dailyKey(USER_B), 172800, '144');
	const broken = createGuildID(21n << 22n);
	const healthy = createGuildID(22n << 22n);
	await seedGuild(broken);
	await seedGuild(healthy);
	await voice(USER_A, {}, 'a', healthy);
	await voice(USER_B, {}, 'b', healthy);
	const readHash = deps.kvClient.hgetall.bind(deps.kvClient);
	vi.spyOn(deps.kvClient, 'hgetall').mockImplementation((key) => {
		if (key === VOICE_STATE_KV_KEY_PREFIX + String(broken)) throw new Error('hash unavailable');
		return readHash(key);
	});
	const info = vi.spyOn(Logger.child({}), 'info');
	const warn = vi.spyOn(Logger.child({}), 'warn');
	const counts = {guilds: 3, awarded: 3, capped: 1, failed: 1};
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual(counts);
	expect(info).toHaveBeenCalledExactlyOnceWith({...PAYLOAD, ...counts, lag_ms: 0}, expect.any(String));
	expect(warn).not.toHaveBeenCalled();
});

it('voice XP disabled in settings skips the hash', async () => {
	await seedGuild(GUILD, {voice_xp_enabled: false});
	const hash = vi.spyOn(deps.kvClient, 'hgetall');
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1});
	expect(hash).not.toHaveBeenCalled();
});

it('multiple connections count each member once for listeners and awards', async () => {
	await seedGuild();
	await voice(USER_A, {}, 'a1');
	await voice(USER_A, {}, 'a2');
	const runner = createMicupBotVoiceRunner(deps);
	expect(await runner.runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1});
	await voice(USER_B);
	await voice(USER_A, {channel_id: '203'}, 'a3');
	await voice(USER_B, {channel_id: '203'}, 'b3');
	expect(await runner.runSlots({...PAYLOAD, turn: TURN + 1})).toEqual({...ZERO, guilds: 1, awarded: 2});
	expect(await deps.kvClient.get(dailyKey(USER_A))).toBe('1');
	expect(await deps.kvClient.get(dailyKey(USER_B))).toBe('1');
});

it('malformed voice entries are skipped without losing valid listeners', async () => {
	await seedGuild();
	for (const userId of [USER_C, createUserID(104n)]) await seedMember(userId);
	for (const [i, value] of ['{', 'null', '[]', '1', '{}'].entries()) {
		await deps.kvClient.hset(VOICE_STATE_KV_KEY_PREFIX + String(GUILD), `bad${i}`, value);
	}
	await voice(USER_A, {user_id: 'not-an-id'}, 'bad-user');
	await voice(USER_A, {channel_id: {}}, 'bad-channel');
	await voice(createUserID(103n), {deaf: 'false'}, 'bad-deaf');
	await voice(createUserID(104n), {self_deaf: null}, 'missing-self-deaf');
	await voice(USER_A);
	await voice(USER_B);
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1, awarded: 2});
});

it('the daily cap resets at UTC midnight even for a delayed turn', async () => {
	await seedGuild();
	for (const user of [USER_A, USER_B]) {
		await voice(user);
		await deps.kvClient.setex(dailyKey(user), 172800, '144');
	}
	vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-04T00:00:01Z'));
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 1, awarded: 2});
	expect(await deps.kvClient.get(dailyKey(USER_A, GUILD, '2026-10-04'))).toBe('1');
});

it('a walk more than 60 seconds late warns once with its typed counts', async () => {
	vi.spyOn(Date, 'now').mockReturnValue(NOW + 60_001);
	const info = vi.spyOn(Logger.child({}), 'info');
	const warn = vi.spyOn(Logger.child({}), 'warn');
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual(ZERO);
	expect(warn).toHaveBeenCalledExactlyOnceWith({...PAYLOAD, ...ZERO, lag_ms: 60_001}, expect.any(String));
	expect(info).not.toHaveBeenCalled();
});

it('guild work is bounded to 16 concurrent reads', async () => {
	for (let i = 0; i < 33; i++) await getMicupBotRepository().setVoiceGuild(createGuildID(GUILD + BigInt(i)), true);
	let active = 0;
	let peak = 0;
	vi.spyOn(deps.guildRepository, 'findUnique').mockImplementation(async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => setImmediate(resolve));
		active--;
		return null;
	});
	expect(await createMicupBotVoiceRunner(deps).runSlots(PAYLOAD)).toEqual({...ZERO, guilds: 33});
	expect(peak).toBe(16);
});
