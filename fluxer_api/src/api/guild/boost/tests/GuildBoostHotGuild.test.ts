// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID} from '@app/api/BrandedTypes';
import {GUILD_BOOST_COUNT_COUNTER} from '@app/api/guild/boost/GuildBoostCounters';
import {GuildBoostRepository} from '@app/api/guild/boost/GuildBoostRepository';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {acceptInvite, createChannelInvite, createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {grantPremium} from '@app/api/user/tests/UserTestUtils';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import recomputeGuildBoost from '@app/api/worker/tasks/RecomputeGuildBoost';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

const MEMBERS = 100;
const SLOTS = ['premium:0', 'premium:1'];

// a burst of boosts on one guild must count exactly, never write the guild row on the request
// path and announce the new level at most twice. The in-memory executor runs LWTs one at a time, so the same test also
// has to pass against the rehearsal Cassandra (1.16), where the slot CAS really contends.
describe('hot guild boosting', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('counts 200 concurrent boosts exactly, reaches level 3 and sends at most two GUILD_UPDATEs', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Hot Guild');
		const guildId = createGuildID(BigInt(guild.id));
		const inviteCode = (await createChannelInvite(harness, owner.token, guild.system_channel_id!)).code;
		const members: Array<TestAccount> = await Promise.all(
			Array.from({length: MEMBERS}, async () => {
				const account = await createTestAccount(harness);
				await grantPremium(harness, account.userId, UserPremiumTypes.SUBSCRIPTION);
				await acceptInvite(harness, account.token, inviteCode);
				return account;
			}),
		);
		const guildWrites = vi.spyOn(GuildRepository.prototype, 'upsertPartial');
		const dispatchGuild = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild');

		let boosting = true;
		const recomputes = (async () => {
			while (boosting) {
				await recomputeGuildBoost({guildId: guild.id}, helpers);
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		})();
		const responses = await Promise.all(
			members.flatMap((member) =>
				SLOTS.map((slotId) =>
					createBuilder(harness, member.token).put(`/guilds/${guild.id}/boosts`).body({slot_id: slotId}).executeRaw(),
				),
			),
		);
		boosting = false;
		await recomputes;
		await recomputeGuildBoost({guildId: guild.id}, helpers);

		expect(responses.filter(({response}) => response.status === 200)).toHaveLength(MEMBERS * SLOTS.length);
		expect(await getKVCounterService().get(GUILD_BOOST_COUNT_COUNTER, guild.id)).toBe(200);
		expect(await new GuildBoostRepository().listBoostsNewestFirst(guildId, 500)).toHaveLength(200);
		await flushCounters({}, helpers);
		const stored = await new GuildRepository().findUnique(guildId);
		expect(stored?.premiumSubscriptionCount).toBe(200);
		expect(stored?.premiumTier).toBe(3);
		expect(stored?.features).toContain(GuildFeatures.VANITY_URL);
		// Only the recompute writes the guild row (the counter flush writes one column outside upsertPartial).
		expect(guildWrites.mock.calls.length).toBeLessThanOrEqual(2);
		const updates = dispatchGuild.mock.calls.filter(
			([call]) => call.guildId === guildId && call.event === 'GUILD_UPDATE',
		);
		expect(updates.length).toBeGreaterThanOrEqual(1);
		expect(updates.length).toBeLessThanOrEqual(2);
	}, 120_000);
});
