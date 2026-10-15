// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createUserID, type GuildID} from '@app/api/BrandedTypes';
import {GUILD_BOOST_COUNT_COUNTER} from '@app/api/guild/boost/GuildBoostCounters';
import {guildBoostFeatures} from '@app/api/guild/boost/GuildBoostLevels';
import {GuildBoostRepository} from '@app/api/guild/boost/GuildBoostRepository';
import {
	GUILD_BOOST_SLOT_COOLDOWN_MS,
	GUILD_BOOST_TIMER_ENTITLEMENT_ID,
	GuildBoostService,
	guildEntitlementDay,
	guildEntitlementShard,
	parsePremiumSlotIndex,
} from '@app/api/guild/boost/GuildBoostService';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {acceptInvite, createChannelInvite, createGuild, leaveGuild} from '@app/api/guild/tests/GuildTestUtils';
import {
	getGuildBoostService,
	getKVCounterService,
	getPremiumLedgerService,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {registerMicupUserLifecycleHooks} from '@app/api/user/lifecycle/MicupUserLifecycleHooks';
import {runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {
	deleteAccount,
	grantPremium,
	setPendingDeletionAt,
	triggerDeletionWorker,
	waitForDeletionCompletion,
} from '@app/api/user/tests/UserTestUtils';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import processGuildEntitlementExpirations from '@app/api/worker/tasks/ProcessGuildEntitlementExpirations';
import rebuildCounter from '@app/api/worker/tasks/RebuildCounter';
import recomputeGuildBoost from '@app/api/worker/tasks/RecomputeGuildBoost';
import removeMemberBoosts from '@app/api/worker/tasks/RemoveMemberBoosts';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {DiscoveryCategories} from '@fluxer/constants/src/DiscoveryConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {GuildBoostResponse, UserBoostSlotResponse} from '@fluxer/schema/src/domains/boost/BoostResponseSchemas';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {ms} from 'itty-time';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

describe('guild boosts', () => {
	let harness: ApiTestHarness;
	let owner: TestAccount;
	let guild: GuildResponse;
	let guildId: GuildID;
	let inviteCode: string;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		owner = await createTestAccount(harness);
		guild = await createGuild(harness, owner.token, 'Boosted Guild');
		guildId = createGuildID(BigInt(guild.id));
		inviteCode = (await createChannelInvite(harness, owner.token, guild.system_channel_id!)).code;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function premiumMember(): Promise<TestAccount> {
		const account = await createTestAccount(harness);
		await grantPremium(harness, account.userId, UserPremiumTypes.SUBSCRIPTION);
		await acceptInvite(harness, account.token, inviteCode);
		return account;
	}

	async function boost(account: TestAccount, slotId = 'premium:0'): Promise<GuildBoostResponse> {
		return createBuilder<GuildBoostResponse>(harness, account.token)
			.put(`/guilds/${guild.id}/boosts`)
			.body({slot_id: slotId})
			.expect(HTTP_STATUS.OK)
			.execute();
	}

	async function unboost(account: TestAccount, boostId: string): Promise<void> {
		await createBuilder(harness, account.token)
			.delete(`/guilds/${guild.id}/boosts/${boostId}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
	}

	async function slots(account: TestAccount): Promise<Array<UserBoostSlotResponse>> {
		return createBuilder<Array<UserBoostSlotResponse>>(harness, account.token).get('/users/@me/boost-slots').execute();
	}

	async function liveCount(): Promise<number> {
		return getKVCounterService().get(GUILD_BOOST_COUNT_COUNTER, guild.id);
	}

	async function recompute(): Promise<void> {
		await recomputeGuildBoost({guildId: guild.id}, helpers);
	}

	async function storedGuild(id: GuildID = guildId) {
		const stored = await new GuildRepository().findUnique(id);
		if (!stored) throw new Error('guild missing');
		return stored;
	}

	async function setFeatures(change: (features: Set<string>) => void, id: GuildID = guildId): Promise<void> {
		const stored = await storedGuild(id);
		const features = new Set(stored.features);
		change(features);
		await new GuildRepository().upsertPartial(id, {features}, stored.toRow());
	}

	function useClock(): (advanceMs: number) => void {
		let now = Date.now();
		vi.useFakeTimers({toFake: ['Date'], now});
		return (advanceMs) => {
			now += advanceMs;
			vi.setSystemTime(now);
		};
	}

	it('gives a premium account two free slots and a free account none', async () => {
		const free = await createTestAccount(harness);
		expect(await slots(free)).toEqual([]);
		const member = await premiumMember();
		expect(await slots(member)).toEqual([
			{id: 'premium:0', guild_id: null, boost_id: null, assigned_at: null},
			{id: 'premium:1', guild_id: null, boost_id: null, assigned_at: null},
		]);
	});

	it('gives no slot for premium that only the card-free trial pays for (S-5)', async () => {
		const account = await createTestAccount(harness);
		await getPremiumLedgerService().grant({
			userId: createUserID(BigInt(account.userId)),
			grantKey: 'trial',
			duration: {unit: 'days', quantity: 7},
			source: 'trial',
		});
		await acceptInvite(harness, account.token, inviteCode);
		expect(await slots(account)).toEqual([]);
		await createBuilder(harness, account.token)
			.put(`/guilds/${guild.id}/boosts`)
			.body({slot_id: 'premium:0'})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
	});

	it('boosts, lists newest first and returns the live count from GET /guilds/:guild_id', async () => {
		const member = await premiumMember();
		const first = await boost(member, 'premium:0');
		const second = await boost(member, 'premium:1');
		expect(first).toMatchObject({guild_id: guild.id, user: {id: member.userId}});
		const newest = await createBuilder<Array<GuildBoostResponse>>(harness, owner.token)
			.get(`/guilds/${guild.id}/boosts?limit=1`)
			.execute();
		expect(newest.map((row) => row.id)).toEqual([second.id]);
		const older = await createBuilder<Array<GuildBoostResponse>>(harness, owner.token)
			.get(`/guilds/${guild.id}/boosts?limit=50&before=${second.id}`)
			.execute();
		expect(older.map((row) => row.id)).toEqual([first.id]);
		expect((await slots(member)).map((slot) => slot.guild_id)).toEqual([guild.id, guild.id]);
		// Nothing has flushed the counter to the guild row yet; the route still answers with the live count.
		expect((await storedGuild()).premiumSubscriptionCount).toBeNull();
		const fetched = await createBuilder<GuildResponse>(harness, owner.token).get(`/guilds/${guild.id}`).execute();
		expect(fetched).toMatchObject({premium_tier: 0, premium_subscription_count: 2});
		await flushCounters({}, helpers);
		expect((await storedGuild()).premiumSubscriptionCount).toBe(2);
	});

	it('still answers GET /guilds/:guild_id when the live boost count cannot be read', async () => {
		vi.spyOn(GuildBoostService.prototype, 'getLiveBoostCount').mockRejectedValue(new Error('kv down'));
		const fetched = await createBuilder<GuildResponse>(harness, owner.token).get(`/guilds/${guild.id}`).execute();
		expect(fetched.id).toBe(guild.id);
	});

	it('answers a repeated boost with the same boost and counts it once', async () => {
		const member = await premiumMember();
		const results = await Promise.all([boost(member), boost(member), boost(member)]);
		expect(new Set(results.map((row) => row.id)).size).toBe(1);
		expect(await liveCount()).toBe(1);
	});

	it('lets exactly one of two guilds take the same slot at once', async () => {
		const member = await premiumMember();
		const other = await createGuild(harness, owner.token, 'Other Guild');
		const otherInvite = (await createChannelInvite(harness, owner.token, other.system_channel_id!)).code;
		await acceptInvite(harness, member.token, otherInvite);
		const responses = await Promise.all(
			[guild.id, other.id].map((target) =>
				createBuilder(harness, member.token).put(`/guilds/${target}/boosts`).body({slot_id: 'premium:0'}).executeRaw(),
			),
		);
		expect(responses.map(({response}) => response.status).sort()).toEqual([HTTP_STATUS.OK, HTTP_STATUS.CONFLICT]);
		const counts = await Promise.all(
			[guild.id, other.id].map((id) => getKVCounterService().get(GUILD_BOOST_COUNT_COUNTER, id)),
		);
		expect(counts.sort()).toEqual([0, 1]);
	});

	it('refuses a slot the account does not hold, a non-member and an unavailable guild', async () => {
		const member = await premiumMember();
		await createBuilder(harness, member.token)
			.put(`/guilds/${guild.id}/boosts`)
			.body({slot_id: 'premium:2'})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		const outsider = await createTestAccount(harness);
		await grantPremium(harness, outsider.userId, UserPremiumTypes.SUBSCRIPTION);
		const refused = await createBuilder(harness, outsider.token)
			.put(`/guilds/${guild.id}/boosts`)
			.body({slot_id: 'premium:0'})
			.executeRaw();
		expect([HTTP_STATUS.FORBIDDEN, HTTP_STATUS.NOT_FOUND]).toContain(refused.response.status);
		await setFeatures((features) => features.add(GuildFeatures.UNAVAILABLE_FOR_EVERYONE_BUT_STAFF));
		await createBuilder(harness, member.token)
			.put(`/guilds/${guild.id}/boosts`)
			.body({slot_id: 'premium:0'})
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		expect(await liveCount()).toBe(0);
	});

	it('takes only the standard slot IDs, so zero-padded aliases give no extra slot and skip no cooldown', async () => {
		const member = await premiumMember();
		await boost(member, 'premium:0');
		for (const slotId of ['premium:00', 'premium:01', 'premium:000', 'premium:001']) {
			const {response} = await createBuilder(harness, member.token)
				.put(`/guilds/${guild.id}/boosts`)
				.body({slot_id: slotId})
				.executeRaw();
			expect([HTTP_STATUS.BAD_REQUEST, HTTP_STATUS.NOT_FOUND]).toContain(response.status);
		}
		expect(parsePremiumSlotIndex('premium:00')).toBeNull();
		expect(parsePremiumSlotIndex('premium:01')).toBeNull();
		expect(await liveCount()).toBe(1);
		const rows = await new GuildBoostRepository().listSlots(createUserID(BigInt(member.userId)));
		expect(rows.map((row) => row.slot_id)).toEqual(['premium:0']);
	});

	it('takes a boost off a non-standard slot row at the next expiration run', async () => {
		const member = await premiumMember();
		const userId = createUserID(BigInt(member.userId));
		const repository = new GuildBoostRepository();
		await repository.createSlotIfAbsent(userId, 'premium:00', 'premium');
		const slot = (await repository.getSlot(userId, 'premium:00'))!;
		const now = new Date();
		expect(await repository.claimSlot(slot, {guildId, boostId: 77n, at: now})).toBe(true);
		await repository.putBoost({
			guild_id: guildId,
			boost_id: 77n,
			user_id: userId,
			slot_id: 'premium:00',
			created_at: now,
		});
		await getKVCounterService().add(GUILD_BOOST_COUNT_COUNTER, guild.id, 1);
		await repository.addExpiration({
			day: guildEntitlementDay(now),
			shard: guildEntitlementShard(guildId),
			guild_id: guildId,
			entitlement_id: 77n,
		});
		await processGuildEntitlementExpirations({}, helpers);
		expect(await repository.listBoostsNewestFirst(guildId, 10)).toEqual([]);
		expect(await liveCount()).toBe(0);
	});

	it('lets only the owner take a boost off, then holds the slot for the move cooldown', async () => {
		const advance = useClock();
		const member = await premiumMember();
		const created = await boost(member);
		await createBuilder(harness, owner.token)
			.delete(`/guilds/${guild.id}/boosts/${created.id}`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		await createBuilder(harness, member.token)
			.delete(`/guilds/${guild.id}/boosts/1`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		await unboost(member, created.id);
		expect((await slots(member))[0]).toMatchObject({guild_id: null, boost_id: null});
		expect(await liveCount()).toBe(0);
		await createBuilder(harness, member.token)
			.put(`/guilds/${guild.id}/boosts`)
			.body({slot_id: 'premium:0'})
			.expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT)
			.execute();
		advance(GUILD_BOOST_SLOT_COOLDOWN_MS + ms('1 minute'));
		await boost(member);
		expect(await liveCount()).toBe(1);
	});

	it('takes the boost off when the member leaves the guild (S-3)', async () => {
		const member = await premiumMember();
		await boost(member);
		await leaveGuild(harness, member.token, guild.id);
		expect(await new GuildBoostRepository().listBoostsNewestFirst(guildId, 10)).toEqual([]);
		expect((await slots(member))[0]).toMatchObject({guild_id: null});
		expect(await liveCount()).toBe(0);
	});

	it('kicks, bans and deletes accounts even when the boost cleanup fails, and retries the cleanup in the worker', async () => {
		const addJob = vi.spyOn(NoopWorkerService.prototype as IWorkerService, 'addJob');
		const leave = vi.spyOn(NoopGatewayService.prototype, 'leaveGuild');
		const dispatchGuild = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild');
		const kicked = await premiumMember();
		const banned = await premiumMember();
		const deleted = await premiumMember();
		for (const account of [kicked, banned, deleted]) {
			await boost(account);
		}
		vi.spyOn(GuildBoostRepository.prototype, 'listSlots').mockRejectedValue(new Error('slot read failed'));
		await createBuilder(harness, owner.token)
			.delete(`/guilds/${guild.id}/members/${kicked.userId}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await createBuilder(harness, owner.token)
			.put(`/guilds/${guild.id}/bans/${banned.userId}`)
			.body({})
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await deleteAccount(harness, deleted.token, deleted.password);
		await setPendingDeletionAt(harness, deleted.userId, new Date(Date.now() - 60_000));
		await triggerDeletionWorker(harness);
		await waitForDeletionCompletion(harness, deleted.userId);
		for (const account of [kicked, banned, deleted]) {
			const userId = createUserID(BigInt(account.userId));
			expect(leave).toHaveBeenCalledWith({userId, guildId});
			expect(dispatchGuild).toHaveBeenCalledWith(
				expect.objectContaining({event: 'GUILD_MEMBER_REMOVE', data: {user: {id: account.userId}}}),
			);
		}
		vi.mocked(GuildBoostRepository.prototype.listSlots).mockRestore();
		const retries = addJob.mock.calls.filter(([taskType]) => taskType === 'removeMemberBoosts');
		expect(retries.map(([, payload]) => (payload as {userId: string}).userId).sort()).toEqual(
			[kicked.userId, banned.userId, deleted.userId].sort(),
		);
		for (const [, payload] of retries) {
			await removeMemberBoosts(payload, helpers);
			await removeMemberBoosts(payload, helpers);
		}
		expect(await liveCount()).toBe(0);
		expect(await new GuildBoostRepository().listBoostsNewestFirst(guildId, 10)).toEqual([]);
	});

	it('leaves a boost made after the member came back when a late cleanup retry runs', async () => {
		const member = await premiumMember();
		await boost(member, 'premium:0');
		const leftAt = new Date(Date.now() - 1000);
		await removeMemberBoosts({guildId: guild.id, userId: member.userId, leftAt: leftAt.toISOString()}, helpers);
		expect(await liveCount()).toBe(1);
	});

	it('reaches level 1 with two boosts and sends GUILD_UPDATE only when the level changes', async () => {
		const dispatchGuild = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild');
		const member = await premiumMember();
		await boost(member, 'premium:0');
		await recompute();
		expect((await storedGuild()).premiumTier).toBeNull();
		await boost(member, 'premium:1');
		await recompute();
		await recompute();
		const stored = await storedGuild();
		expect(stored.premiumTier).toBe(1);
		expect(stored.features).toContain(GuildFeatures.AUDIO_BITRATE_128_KBPS);
		expect(stored.features).toContain(GuildFeatures.MORE_EMOJI);
		const updates = dispatchGuild.mock.calls.filter(([call]) => call.event === 'GUILD_UPDATE');
		expect(updates).toHaveLength(1);
		expect(updates[0]![0].data).toMatchObject({premium_tier: 1, premium_subscription_count: 2});
	});

	// Starts `write` while the recompute is about to write the guild features and lets it read the guild first (unless
	// a lock holds it back for a second), then recomputes once more.
	async function recomputeRacing(write: () => Promise<unknown>): Promise<void> {
		const {upsertPartial, findUnique} = GuildRepository.prototype;
		let racing: Promise<unknown> | null = null;
		let racerRead = () => {};
		const read = new Promise<void>((resolve) => {
			racerRead = resolve;
		});
		vi.spyOn(GuildRepository.prototype, 'findUnique').mockImplementation(async function (
			this: GuildRepository,
			...args: Parameters<GuildRepository['findUnique']>
		) {
			const result = await findUnique.apply(this, args);
			if (racing) racerRead();
			return result;
		});
		vi.spyOn(GuildRepository.prototype, 'upsertPartial').mockImplementation(async function (
			this: GuildRepository,
			...args: Parameters<GuildRepository['upsertPartial']>
		) {
			if (!racing && args[1].features?.has(GuildFeatures.MORE_EMOJI)) {
				racing = write();
				await Promise.race([read, new Promise((resolve) => setTimeout(resolve, 1000))]);
			}
			return upsertPartial.apply(this, args);
		});
		const member = await premiumMember();
		await boost(member, 'premium:0');
		await boost(member, 'premium:1');
		await recompute();
		await racing;
		vi.mocked(GuildRepository.prototype.upsertPartial).mockRestore();
		vi.mocked(GuildRepository.prototype.findUnique).mockRestore();
		await recompute();
	}

	async function expectBoostAndOtherFeature(feature: string): Promise<void> {
		const stored = await storedGuild();
		expect(stored.features).toContain(feature);
		expect(stored.features).toContain(GuildFeatures.MORE_EMOJI);
		expect(stored.features).toContain(GuildFeatures.AUDIO_BITRATE_128_KBPS);
		expect([...((await new GuildBoostRepository().getState(guildId))?.suppressed_features ?? [])]).toEqual([]);
	}

	it('keeps both writes when a discovery approval races the recompute (guild update lock)', async () => {
		await createBuilderWithoutAuth(harness)
			.post(`/test/guilds/${guild.id}/member-count`)
			.body({member_count: 10})
			.execute();
		await createBuilder(harness, owner.token)
			.post(`/guilds/${guild.id}/discovery`)
			.body({description: 'Valid discovery description', category_type: DiscoveryCategories.GAMING})
			.expect(HTTP_STATUS.OK)
			.execute();
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			'admin:authenticate',
			'discovery:review',
		]);
		await recomputeRacing(() =>
			createBuilder(harness, admin.token)
				.patch(`/admin/discovery/applications/${guild.id}`)
				.body({status: 'approved'})
				.expect(HTTP_STATUS.OK)
				.execute(),
		);
		await expectBoostAndOtherFeature(GuildFeatures.DISCOVERABLE);
	});

	it('keeps both writes when an admin feature change races the recompute (guild update lock)', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			'admin:authenticate',
			'guild:update:features',
		]);
		await recomputeRacing(() =>
			createBuilder(harness, admin.token)
				.patch(`/admin/guilds/${guild.id}`)
				.body({add_features: [GuildFeatures.VERIFIED]})
				.expect(HTTP_STATUS.OK)
				.execute(),
		);
		await expectBoostAndOtherFeature(GuildFeatures.VERIFIED);
	});

	it('still counts added features as the boosts own when the recompute stopped before its state write', async () => {
		const member = await premiumMember();
		await boost(member, 'premium:0');
		await boost(member, 'premium:1');
		const writeState = GuildBoostRepository.prototype.putState;
		const putState = vi
			.spyOn(GuildBoostRepository.prototype, 'putState')
			.mockImplementationOnce(function (this: GuildBoostRepository, row) {
				return writeState.call(this, row);
			})
			.mockRejectedValueOnce(new Error('stopped after the guild write'));
		await expect(recompute()).rejects.toThrow('stopped after the guild write');
		putState.mockRestore();
		expect((await storedGuild()).features).toContain(GuildFeatures.MORE_EMOJI);

		await recompute();

		const granted = (await new GuildBoostRepository().getState(guildId))?.granted_features ?? new Set<string>();
		expect(granted).toEqual(guildBoostFeatures(1));
	});

	it('keeps features an admin gave and never adds back one an admin took away', async () => {
		const advance = useClock();
		await setFeatures((features) => features.add(GuildFeatures.MORE_EMOJI));
		const member = await premiumMember();
		const boosts = [await boost(member, 'premium:0'), await boost(member, 'premium:1')];
		await recompute();
		expect((await storedGuild()).features).toContain(GuildFeatures.AUDIO_BITRATE_128_KBPS);
		for (const row of boosts) {
			await unboost(member, row.id);
		}
		await recompute();
		expect((await storedGuild()).premiumTier).toBe(1);
		advance(ms('3 days') + ms('1 minute'));
		// The level grace ends through the guild's timer row, not through another boost event.
		await processGuildEntitlementExpirations({}, helpers);
		await recompute();
		const dropped = await storedGuild();
		expect(dropped.premiumTier).toBe(0);
		expect(dropped.features).not.toContain(GuildFeatures.AUDIO_BITRATE_128_KBPS);
		expect(dropped.features).toContain(GuildFeatures.MORE_EMOJI);
		expect(dropped.features).toContain(GuildFeatures.BANNER);

		const second = await premiumMember();
		await boost(second, 'premium:0');
		await boost(second, 'premium:1');
		await recompute();
		expect((await storedGuild()).features).toContain(GuildFeatures.AUDIO_BITRATE_128_KBPS);
		await setFeatures((features) => features.delete(GuildFeatures.AUDIO_BITRATE_128_KBPS));
		const third = await premiumMember();
		await boost(third);
		await recompute();
		const suppressed = await storedGuild();
		expect(suppressed.features).not.toContain(GuildFeatures.AUDIO_BITRATE_128_KBPS);
		expect(suppressed.premiumTier).toBe(1);
	});

	it('holds a lost level for three days, then drops VANITY_URL and holds the code for thirty days', async () => {
		const advance = useClock();
		const members = await Promise.all(Array.from({length: 7}, () => premiumMember()));
		const boosts = await Promise.all(
			members.flatMap((member) => [boost(member, 'premium:0'), boost(member, 'premium:1')]),
		);
		await recompute();
		expect((await storedGuild()).premiumTier).toBe(3);
		await createBuilder(harness, owner.token)
			.patch(`/guilds/${guild.id}/vanity-url`)
			.body({code: 'boosted-guild'})
			.expect(HTTP_STATUS.OK)
			.execute();
		const own = boosts.find((row) => row.user.id === members[0]!.userId)!;
		await unboost(members[0]!, own.id);
		await recompute();
		expect((await storedGuild()).premiumTier).toBe(3);

		advance(ms('3 days') + ms('1 minute'));
		await processGuildEntitlementExpirations({}, helpers);
		await recompute();
		const dropped = await storedGuild();
		expect(dropped.premiumTier).toBe(2);
		expect(dropped.features).not.toContain(GuildFeatures.VANITY_URL);
		expect(dropped.vanityUrlCode).toBe('boosted-guild');

		const rival = await createTestAccount(harness);
		const rivalGuild = await createGuild(harness, rival.token, 'Rival Guild');
		await setFeatures((features) => features.add(GuildFeatures.VANITY_URL), createGuildID(BigInt(rivalGuild.id)));
		await createBuilder(harness, rival.token)
			.patch(`/guilds/${rivalGuild.id}/vanity-url`)
			.body({code: 'boosted-guild'})
			.expect(HTTP_STATUS.BAD_REQUEST)
			.execute();

		advance(ms('30 days') + ms('1 minute'));
		await processGuildEntitlementExpirations({}, helpers);
		await recompute();
		expect((await storedGuild()).vanityUrlCode).toBeNull();
		await createBuilder(harness, rival.token)
			.patch(`/guilds/${rivalGuild.id}/vanity-url`)
			.body({code: 'boosted-guild'})
			.expect(HTTP_STATUS.OK)
			.execute();
	});

	it('keeps a held custom invite code closed for joins until the level comes back (S-4)', async () => {
		const advance = useClock();
		const members = await Promise.all(Array.from({length: 7}, () => premiumMember()));
		const boosts = await Promise.all(
			members.flatMap((member) => [boost(member, 'premium:0'), boost(member, 'premium:1')]),
		);
		await recompute();
		await createBuilder(harness, owner.token)
			.patch(`/guilds/${guild.id}/vanity-url`)
			.body({code: 'held-guild'})
			.expect(HTTP_STATUS.OK)
			.execute();
		const own = boosts.find((row) => row.user.id === members[0]!.userId)!;
		await unboost(members[0]!, own.id);
		await recompute();
		advance(ms('3 days') + ms('1 minute'));
		await processGuildEntitlementExpirations({}, helpers);
		await recompute();
		expect((await storedGuild()).features).not.toContain(GuildFeatures.VANITY_URL);

		// A vanity invite names no channel; the stock no-op gateway resolves none, which would fail every vanity join.
		vi.spyOn(NoopGatewayService.prototype, 'getFirstViewableTextChannel').mockResolvedValue(
			createChannelID(BigInt(guild.system_channel_id!)),
		);
		const joiner = await createTestAccount(harness);
		await createBuilder(harness, joiner.token)
			.post('/invites/held-guild')
			.body(null)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_INVITE)
			.execute();
		const returning = await premiumMember();
		await boost(returning);
		await recompute();
		expect((await storedGuild()).features).toContain(GuildFeatures.VANITY_URL);
		const joined = await acceptInvite(harness, joiner.token, 'held-guild');
		expect(joined.guild.id).toBe(guild.id);
	});

	it('takes a boost off once its premium and grace have ended', async () => {
		const advance = useClock();
		const account = await createTestAccount(harness);
		await acceptInvite(harness, account.token, inviteCode);
		await createBuilderWithoutAuth(harness)
			.post(`/test/users/${account.userId}/premium`)
			.body({
				premium_type: UserPremiumTypes.SUBSCRIPTION,
				premium_until: new Date(Date.now() + ms('1 day')).toISOString(),
			})
			.execute();
		await boost(account);
		await processGuildEntitlementExpirations({}, helpers);
		expect(await liveCount()).toBe(1);
		advance(ms('6 days'));
		await processGuildEntitlementExpirations({}, helpers);
		expect(await liveCount()).toBe(0);
		expect(await new GuildBoostRepository().listBoostsNewestFirst(guildId, 10)).toEqual([]);
	});

	it('rechecks a boost whose premium has no end every thirty days and takes it off once premium is gone', async () => {
		const advance = useClock();
		const account = await createTestAccount(harness);
		await grantPremium(harness, account.userId, UserPremiumTypes.LIFETIME);
		await acceptInvite(harness, account.token, inviteCode);
		await boost(account);
		advance(ms('31 days'));
		await processGuildEntitlementExpirations({}, helpers);
		expect(await liveCount()).toBe(1);
		await grantPremium(harness, account.userId, UserPremiumTypes.NONE);
		advance(ms('30 days'));
		await processGuildEntitlementExpirations({}, helpers);
		expect(await liveCount()).toBe(0);
		expect(await new GuildBoostRepository().listBoostsNewestFirst(guildId, 10)).toEqual([]);
	});

	it('removes the boosts and slots of a deleted account, and runs again safely', async () => {
		registerMicupUserLifecycleHooks();
		const member = await premiumMember();
		await boost(member);
		const userId = createUserID(BigInt(member.userId));
		expect(await getGuildBoostService().harvestUserBoosts(userId)).toMatchObject({
			slots: [{id: 'premium:0', guild_id: guild.id}],
		});
		await runUserDeletionHook('boosts', {userId});
		await runUserDeletionHook('boosts', {userId});
		expect(await new GuildBoostRepository().listSlots(userId)).toEqual([]);
		expect(await liveCount()).toBe(0);
	});

	it('drops boost rows no slot backs when the counter is rebuilt', async () => {
		const member = await premiumMember();
		await boost(member);
		const repository = new GuildBoostRepository();
		await repository.putBoost({
			guild_id: guildId,
			boost_id: 42n,
			user_id: createUserID(BigInt(member.userId)),
			slot_id: 'premium:1',
			created_at: new Date(),
		});
		await getKVCounterService().add(GUILD_BOOST_COUNT_COUNTER, guild.id, 5);
		await rebuildCounter({namespace: GUILD_BOOST_COUNT_COUNTER, id: guild.id}, helpers);
		expect(await liveCount()).toBe(1);
		expect((await repository.listBoostsNewestFirst(guildId, 10)).map((row) => row.boost_id)).not.toContain(42n);
	});

	it('repairs a drifted count and drops rows no slot backs once a day from the recompute', async () => {
		const member = await premiumMember();
		await boost(member, 'premium:0');
		// A PUT that lost to a DELETE on the same slot rewrote the row after the DELETE removed it, and a request that
		// died between its slot write and its counter delta left the count one short.
		await new GuildBoostRepository().putBoost({
			guild_id: guildId,
			boost_id: 43n,
			user_id: createUserID(BigInt(member.userId)),
			slot_id: 'premium:1',
			created_at: new Date(),
		});
		await boost(member, 'premium:1');
		await getKVCounterService().add(GUILD_BOOST_COUNT_COUNTER, guild.id, -1);
		expect(await liveCount()).toBe(1);
		await recompute();
		expect(await liveCount()).toBe(2);
		expect((await storedGuild()).premiumTier).toBe(1);
		const rows = await new GuildBoostRepository().listBoostsNewestFirst(guildId, 10);
		expect(rows.map((row) => row.boost_id)).not.toContain(43n);
	});

	it('queues the recompute again when a boost removal is retried after the queue failed', async () => {
		const member = await premiumMember();
		const created = await boost(member);
		await recompute();
		const addJob = vi.spyOn(NoopWorkerService.prototype as IWorkerService, 'addJob');
		addJob.mockRejectedValueOnce(new Error('queue down'));
		const failed = await createBuilder(harness, member.token)
			.delete(`/guilds/${guild.id}/boosts/${created.id}`)
			.executeRaw();
		expect(failed.response.status).toBe(HTTP_STATUS.INTERNAL_SERVER_ERROR);
		await unboost(member, created.id);
		expect(addJob).toHaveBeenLastCalledWith('recomputeGuildBoost', {guildId: guild.id}, expect.anything());
		expect(await liveCount()).toBe(0);
	});

	it('keeps a guild timer row when its recompute cannot be queued, so the next run wakes the guild', async () => {
		const repository = new GuildBoostRepository();
		const timer = {
			day: guildEntitlementDay(new Date()),
			shard: guildEntitlementShard(guildId),
			guild_id: guildId,
			entitlement_id: GUILD_BOOST_TIMER_ENTITLEMENT_ID,
		};
		await repository.addExpiration(timer);
		vi.spyOn(NoopWorkerService.prototype as IWorkerService, 'addJob').mockRejectedValueOnce(new Error('queue down'));
		await processGuildEntitlementExpirations({}, helpers);
		expect(await repository.listExpirations(timer.day, timer.shard, 10)).toContainEqual(timer);
		await processGuildEntitlementExpirations({}, helpers);
		expect(await repository.listExpirations(timer.day, timer.shard, 10)).toEqual([]);
	});
});
