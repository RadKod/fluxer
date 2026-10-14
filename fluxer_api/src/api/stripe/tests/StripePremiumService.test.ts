// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {GuildService} from '@app/api/guild/services/GuildService';
import {createGuild, createRole} from '@app/api/guild/tests/GuildTestUtils';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {StripePremiumService} from '@app/api/stripe/services/StripePremiumService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
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
				{getMember: async () => null} as unknown as GuildRepository,
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
});
