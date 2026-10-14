// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getGatewayService, getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getDiscriminatorService,
	getGuildRepository,
	getPremiumLedgerService,
	getPremiumStateReconciliationQueueService,
	getUserCacheService,
	getUserRepository,
	getVisionaryService,
} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {lifetimeUser, readUser} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {RpcSessionStartService} from '@app/api/rpc/RpcSessionStartService';
import {createTestStoreEntitlementService} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {checkHasActivePaidPremium, checkIsPremium} from '@app/api/user/UserHelpers';
import processPremiumExpirations from '@app/api/worker/tasks/ProcessPremiumExpirations';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

describe('Visionary lifetime premium', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		setWorkerDependenciesForTest({
			kvClient: getKVClient(),
			storeEntitlementService: createTestStoreEntitlementService(),
			workerService: getWorkerService(),
			userRepository: getUserRepository(),
			guildRepository: getGuildRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			premiumStateReconciliationQueueService: getPremiumStateReconciliationQueueService(),
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		clearWorkerDependencies();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function startSession(user: User): Promise<User> {
		const service = new RpcSessionStartService({
			userRepository: getUserRepository(),
			guildRepository: getGuildRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			discriminatorService: getDiscriminatorService(),
			premiumLedgerService: {
				isActive: async () => false,
				ensureUserPremium: async () => ({user, paidUntil: null}),
			},
		});
		const result = await service.processSessionStart({
			userData: {
				user,
				settings: null,
				guildSettings: [],
				notes: new Map(),
				readStates: [],
				guildIds: [],
				privateChannels: [],
				relationships: [],
				favoriteMemes: [],
				pinnedDMs: [],
				webAuthnCredentials: [],
			},
			requestCache: createRequestCache(),
			geoipCountryIso: null,
			clientIp: null,
		});
		return result.user;
	}

	it('a lifetime account with past end dates stays premium', async () => {
		const {userId} = await lifetimeUser(harness, {sequence: 1, endsInPast: true});

		const user = await readUser(userId);

		expect(checkHasActivePaidPremium(user)).toBe(true);
		expect(checkIsPremium(user)).toBe(true);
	});

	it('session start keeps premium_type 2 for a lifetime account', async () => {
		const {userId} = await lifetimeUser(harness, {sequence: 4, endsInPast: true});

		const sessionUser = await startSession(await readUser(userId));

		expect(sessionUser.premiumType).toBe(UserPremiumTypes.LIFETIME);
		const stored = await readUser(userId);
		expect([stored.premiumType, stored.premiumLifetimeSequence]).toEqual([UserPremiumTypes.LIFETIME, 4]);
	});

	it("the premium expiration job keeps a lifetime account's premium-only items", async () => {
		const account = await createTestAccount(harness);
		const userId: UserID = createUserID(BigInt(account.userId));
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
		const cosmetics = new CosmeticRepository();
		await cosmetics.putItem(
			{
				item_id: 9103n,
				item_type: 'nameplate',
				name: 'nameplate',
				description: null,
				asset_hash: 'hash9103',
				availability: 'premium',
				created_at: NOW,
				ultra_layout: null,
				ultra_front: null,
				version: 1,
			},
			true,
		);
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});
		// A Visionary whose end fields a ledger repair wrote back: the lifetime type is set, the dates stay.
		const paid = await readUser(userId);
		await getUserRepository().patchUpsert(
			userId,
			{
				premium_type: UserPremiumTypes.LIFETIME,
				premium_lifetime_sequence: 1,
				nameplate_id: 9103n,
				nameplate_asset: 'hash9103',
			},
			paid.toRow(),
		);

		vi.setSystemTime(paidUntil.getTime() + 1000);
		await processPremiumExpirations({}, HELPERS);

		const after = await readUser(userId);
		expect([after.premiumType, after.premiumLifetimeSequence]).toEqual([UserPremiumTypes.LIFETIME, 1]);
		expect([after.nameplateId, after.nameplateAsset]).toEqual([9103n, 'hash9103']);
	});

	it('a Visionary grant clears the three end fields and keeps premium_since', async () => {
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		const since = new Date('2026-01-02T03:04:05.000Z');
		const later = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
		const before = await readUser(userId);
		await getUserRepository().patchUpsert(
			userId,
			{
				premium_type: UserPremiumTypes.SUBSCRIPTION,
				premium_since: since,
				premium_until: later,
				premium_gift_extension_ends_at: later,
				premium_grace_ends_at: later,
				premium_will_cancel: true,
				premium_billing_cycle: 'monthly',
			},
			before.toRow(),
		);
		await getVisionaryService().setTotal(1);
		await getVisionaryService().holdForOrder(userId, 81n);

		await getVisionaryService().deliverForOrder(userId, 81n);

		const user = await readUser(userId);
		expect({
			type: user.premiumType,
			sequence: user.premiumLifetimeSequence,
			until: user.premiumUntil,
			giftEnd: user.premiumGiftExtensionEndsAt,
			graceEnd: user.premiumGraceEndsAt,
			willCancel: user.premiumWillCancel,
			cycle: user.premiumBillingCycle,
			since: user.premiumSince,
			purchased: user.hasEverPurchased,
		}).toEqual({
			type: UserPremiumTypes.LIFETIME,
			sequence: 1,
			until: null,
			giftEnd: null,
			graceEnd: null,
			willCancel: false,
			cycle: null,
			since,
			purchased: true,
		});
	});
});
