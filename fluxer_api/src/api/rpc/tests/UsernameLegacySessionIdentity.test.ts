// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getConfig} from '@app/api/Config';
import {setCachedAccountIdentity} from '@app/api/instance/AccountIdentityModeCache';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {RpcSessionStartService} from '@app/api/rpc/RpcSessionStartService';
import type {UserData} from '@app/api/rpc/RpcTypes';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {UserDataRepository} from '@app/api/user/repositories/account/crud/UserDataRepository';
import {AccountIdentityModes, TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import {PremiumFlags, UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('legacy READY username writer', () => {
	let harness: ApiTestHarness;
	const originalSelfHosted = getConfig().instance.selfHosted;
	beforeEach(async () => {
		harness = await createApiTestHarness();
		getConfig().instance.selfHosted = false;
	});
	afterEach(async () => {
		setCachedAccountIdentity(null);
		getConfig().instance.selfHosted = originalSelfHosted;
		vi.restoreAllMocks();
		await harness.shutdown();
	});
	it.each([
		['persists the human legacy premium reset through the bounded identity writer', 0],
		['keeps identity and premium flag when allocation exhausts the whole request deadline', 30_001],
	] as const)('%s', async (_label, allocationDelay) => {
		const account = await createTestAccount(harness);
		const repository = getUserRepository();
		const id = createUserID(BigInt(account.userId));
		const stored = await repository.findUniqueAssert(id);
		const user = await repository.patchUpsert(id, {
			flags: stored.flags | UserFlags.HAS_SESSION_STARTED,
			premium_flags: PremiumFlags.DISCRIMINATOR,
		});
		expect(user.premiumFlags).toBe(PremiumFlags.DISCRIMINATOR);
		expect(user.isPremium()).toBe(false);
		setCachedAccountIdentity({mode: AccountIdentityModes.EMAIL, tagStyle: TagStyles.RANDOM});
		const patchIdentity = vi.spyOn(UserDataRepository.prototype, 'patchUser');
		const identityBefore = {username: user.username, discriminator: user.discriminator, version: user.version};
		const discriminator = user.discriminator === 4321 ? 4322 : 4321;
		let requestTime = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => requestTime);
		const generateDiscriminator = vi.fn().mockImplementation(async () => {
			requestTime += allocationDelay;
			return {available: true, discriminator};
		});
		const service = new RpcSessionStartService({
			userRepository: repository,
			guildRepository: {},
			userCacheService: {setUserPartialResponseFromUserInBackground: vi.fn()},
			gatewayService: {},
			discriminatorService: {generateDiscriminator},
		} as never);
		const before = Date.now();
		await service.processSessionStart({
			userData: {user, settings: null, guildIds: []} as unknown as UserData,
			requestCache: createRequestCache(),
			geoipCountryIso: null,
			clientIp: null,
		});
		expect(generateDiscriminator).toHaveBeenCalledTimes(1);
		const persisted = await repository.findUniqueAssert(id);
		expect(persisted.discriminator).toBe(allocationDelay === 0 ? discriminator : identityBefore.discriminator);
		if (allocationDelay > 0) {
			expect(persisted.username).toBe(identityBefore.username);
			expect(persisted.premiumFlags).toBe(PremiumFlags.DISCRIMINATOR);
			expect(persisted.version).toBe(identityBefore.version);
		}
		const identityWrites = patchIdentity.mock.calls.filter((call) => call[3] !== undefined);
		expect(identityWrites).toHaveLength(1);
		const deadline = identityWrites[0]![3]!;
		expect(deadline).toBe(before + 30_000);
	});
});
