// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {IGuildRepositoryAggregate} from '@app/api/guild/repositories/IGuildRepositoryAggregate';
import type {GuildService} from '@app/api/guild/services/GuildService';
import {createGuild, createRole} from '@app/api/guild/tests/GuildTestUtils';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {StripePremiumService} from '@app/api/stripe/services/StripePremiumService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {afterAll, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

describe('StripePremiumService', () => {
	let harness: ApiTestHarness;
	let originalVisionariesGuildId: string | undefined;
	let originalVisionariesGuildVisionaryRoleId: string | undefined;
	beforeAll(async () => {
		harness = await createApiTestHarness();
		originalVisionariesGuildId = Config.instance.visionariesGuildId ?? undefined;
		originalVisionariesGuildVisionaryRoleId = Config.instance.visionariesGuildVisionaryRoleId ?? undefined;
	});
	afterAll(async () => {
		await harness.shutdown();
		Config.instance.visionariesGuildId = originalVisionariesGuildId;
		Config.instance.visionariesGuildVisionaryRoleId = originalVisionariesGuildVisionaryRoleId;
	});
	beforeEach(async () => {
		await harness.resetData();
		const owner = await createTestAccount(harness);
		const visionariesGuild = await createGuild(harness, owner.token, 'Visionaries Test Guild');
		const visionaryRole = await createRole(harness, owner.token, visionariesGuild.id, {name: 'Visionary'});
		Config.instance.visionariesGuildId = visionariesGuild.id;
		Config.instance.visionariesGuildVisionaryRoleId = visionaryRole.id;
	});
	describe('POST /premium/visionary/rejoin', () => {
		test('keeps the route closed even for visionary users', async () => {
			const account = await createTestAccount(harness);
			await createBuilder(harness, account.token)
				.post(`/test/users/${account.userId}/premium`)
				.body({
					premium_type: UserPremiumTypes.LIFETIME,
					premium_lifetime_sequence: 0,
				})
				.execute();
			await createBuilder(harness, account.token)
				.post('/premium/visionary/rejoin')
				.expect(404, APIErrorCodes.NOT_FOUND)
				.execute();
		});
		test('keeps the route closed for users without visionary access', async () => {
			const account = await createTestAccount(harness);
			await createBuilder(harness, account.token)
				.post(`/test/users/${account.userId}/premium`)
				.body({
					premium_type: UserPremiumTypes.SUBSCRIPTION,
					premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
				})
				.execute();
			await createBuilder(harness, account.token)
				.post('/premium/visionary/rejoin')
				.expect(404, APIErrorCodes.NOT_FOUND)
				.execute();
		});
		test('keeps the route closed before authentication', async () => {
			await createBuilder(harness, 'invalid-token')
				.post('/premium/visionary/rejoin')
				.expect(404, APIErrorCodes.NOT_FOUND)
				.execute();
		});
	});
	describe('dormant visionary rejoin service', () => {
		test('adds only a lifetime user to the configured guild', async () => {
			const account = await createTestAccount(harness);
			const userId = createUserID(BigInt(account.userId));
			const repository = new UserRepository();
			const user = (await repository.findUnique(userId))!;
			const members = {addUserToGuild: vi.fn(), systemAddMemberRole: vi.fn()};
			const premiumService = new StripePremiumService(
				repository,
				{} as IGatewayService,
				{getMember: async () => null} as unknown as IGuildRepositoryAggregate,
				{members} as unknown as GuildService,
			);
			await expect(premiumService.rejoinVisionariesGuild(userId)).rejects.toMatchObject({
				code: APIErrorCodes.MISSING_ACCESS,
			});
			expect(members.addUserToGuild).not.toHaveBeenCalled();
			await repository.patchUpsert(userId, {premium_type: UserPremiumTypes.LIFETIME}, user.toRow());
			await premiumService.rejoinVisionariesGuild(userId);
			expect(members.addUserToGuild).toHaveBeenCalledWith(expect.objectContaining({userId}));
			expect(members.systemAddMemberRole).toHaveBeenCalledWith(expect.objectContaining({targetId: userId}));
		});
	});

	describe('POST /premium/grace/end', () => {
		test('rejects with UNKNOWN_USER when the account record is gone', async () => {
			const premiumService = new StripePremiumService(
				new UserRepository(),
				{} as IGatewayService,
				{} as IGuildRepositoryAggregate,
				{} as GuildService,
			);
			const error = await premiumService.endGracePeriod(createUserID(999999999999999997n)).then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(UnknownUserError);
			expect((error as UnknownUserError).status).toBe(404);
			expect((error as UnknownUserError).code).toBe(APIErrorCodes.UNKNOWN_USER);
		});
	});
	describe('premium duration and stacking', () => {
		test('sets premium_since on first grant', async () => {
			const account = await createTestAccount(harness);
			const before = new Date();
			await createBuilder(harness, account.token)
				.post(`/test/users/${account.userId}/premium`)
				.body({
					premium_type: UserPremiumTypes.SUBSCRIPTION,
					premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
				})
				.execute();
			const me = await createBuilder<{
				premium_since: string | null;
				premium_type: number;
			}>(harness, account.token)
				.get('/users/@me')
				.execute();
			expect(me.premium_type).toBe(UserPremiumTypes.SUBSCRIPTION);
			expect(me.premium_since).toBeDefined();
			const premiumSince = new Date(me.premium_since!);
			expect(premiumSince.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
			expect(premiumSince.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
		});
		test('preserves premium_since on renewal', async () => {
			const account = await createTestAccount(harness);
			const originalSince = new Date('2024-01-01T00:00:00Z');
			await createBuilder(harness, account.token)
				.post(`/test/users/${account.userId}/premium`)
				.body({
					premium_type: UserPremiumTypes.SUBSCRIPTION,
					premium_since: originalSince.toISOString(),
					premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
				})
				.execute();
			const me1 = await createBuilder<{
				premium_since: string | null;
			}>(harness, account.token)
				.get('/users/@me')
				.execute();
			expect(me1.premium_since).toBe(originalSince.toISOString());
			await createBuilder(harness, account.token)
				.post(`/test/users/${account.userId}/premium`)
				.body({
					premium_type: UserPremiumTypes.SUBSCRIPTION,
					premium_until: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
				})
				.execute();
			const me2 = await createBuilder<{
				premium_since: string | null;
			}>(harness, account.token)
				.get('/users/@me')
				.execute();
			expect(me2.premium_since).toBe(originalSince.toISOString());
		});
		test('supports lifetime premium type', async () => {
			const account = await createTestAccount(harness);
			await createBuilder(harness, account.token)
				.post(`/test/users/${account.userId}/premium`)
				.body({
					premium_type: UserPremiumTypes.LIFETIME,
					premium_lifetime_sequence: 5,
				})
				.execute();
			const me = await createBuilder<{
				premium_type: number;
				premium_lifetime_sequence: number | null;
			}>(harness, account.token)
				.get('/users/@me')
				.execute();
			expect(me.premium_type).toBe(UserPremiumTypes.LIFETIME);
			expect(me.premium_lifetime_sequence).toBe(5);
		});
	});
});
