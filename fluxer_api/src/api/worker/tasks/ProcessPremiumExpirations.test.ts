// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createUserID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {createTestGuild} from '@app/api/emoji/tests/EmojiTestUtils';
import {
	getGatewayService,
	getKVClient,
	getWorkerService,
	setInjectedWorkerService,
} from '@app/api/middleware/ServiceRegistry';
import {
	getCosmeticService,
	getGuildRepository,
	getPremiumLedgerRepository,
	getPremiumLedgerService,
	getPremiumStateReconciliationQueueService,
	getUserCacheService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {premiumExpirationDay, premiumExpirationShard} from '@app/api/premium/ledger/PremiumLedgerService';
import {
	buildStorePurchaseRow,
	createTestStoreEntitlementService,
} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {checkIsPremium, PREMIUM_GRACE_PERIOD_MS} from '@app/api/user/UserHelpers';
import processPremiumExpirations from '@app/api/worker/tasks/ProcessPremiumExpirations';
import {
	clearWorkerDependencies,
	getWorkerDependencies,
	setWorkerDependenciesForTest,
} from '@app/api/worker/WorkerContext';
import {PremiumFlags} from '@fluxer/constants/src/UserConstants';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {ms} from 'itty-time';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const GUILD_AVATAR = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

describe('processPremiumExpirations', () => {
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
		setInjectedWorkerService(new NoopWorkerService());
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function createMemberWithGuildAvatar(): Promise<{userId: UserID; guildId: GuildID}> {
		const account = await createTestAccount(harness);
		const guild = await createTestGuild(harness, account.token);
		const userId = createUserID(BigInt(account.userId));
		const guildId = createGuildID(BigInt(guild.id));
		const member = (await getGuildRepository().getMember(guildId, userId))!;
		await getGuildRepository().upsertMember({...member.toRow(), avatar_hash: GUILD_AVATAR});
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
		return {userId, guildId};
	}

	async function readUser(userId: UserID): Promise<User> {
		return (await getUserRepository().findUnique(userId))!;
	}

	async function isSanitized(guildId: GuildID, userId: UserID): Promise<boolean> {
		return (await getGuildRepository().getMember(guildId, userId))!.isPremiumSanitized;
	}

	it('strips an ended grant and hides guild perks without scanning every user', async () => {
		const {userId, guildId} = await createMemberWithGuildAvatar();
		const scan = vi.spyOn(UserRepository.prototype, 'scanAllUsersPage');
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});

		vi.setSystemTime(paidUntil.getTime() - 1000);
		await processPremiumExpirations({}, HELPERS);
		expect(await isSanitized(guildId, userId)).toBe(false);
		vi.setSystemTime(paidUntil.getTime() + 1000);
		await processPremiumExpirations({}, HELPERS);

		expect(await isSanitized(guildId, userId)).toBe(true);
		const user = await readUser(userId);
		expect(user.premiumType).toBeNull();
		expect(user.premiumFlags & PremiumFlags.PERKS_SANITIZED).not.toBe(0);
		expect(scan).not.toHaveBeenCalled();
		expect(
			await getPremiumLedgerRepository().listExpirations(
				premiumExpirationDay(paidUntil),
				premiumExpirationShard(userId),
				10,
			),
		).toEqual([]);
	});

	it('takes off the premium cosmetics the account does not own once premium ends, and only once', async () => {
		const {userId} = await createMemberWithGuildAvatar();
		const cosmetics = new CosmeticRepository();
		const items = {
			avatar_decoration: {availability: 'free', item_id: 9001n},
			profile_effect: {availability: 'premium', item_id: 9002n},
			nameplate: {availability: 'premium', item_id: 9003n},
		} as const;
		for (const [type, {availability, item_id}] of Object.entries(items)) {
			await cosmetics.putItem(
				{
					item_id,
					item_type: type,
					name: type,
					description: null,
					asset_hash: `hash${item_id}`,
					availability,
					created_at: NOW,
					ultra_layout: null,
					ultra_front: null,
					version: 1,
				},
				true,
			);
		}
		await cosmetics.putOwned({
			user_id: userId,
			item_id: items.profile_effect.item_id,
			item_type: 'profile_effect',
			source: 'test',
			acquired_at: NOW,
		});
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});
		const worn = await readUser(userId);
		await getUserRepository().patchUpsert(
			userId,
			{
				avatar_decoration_id: 9001n,
				avatar_decoration_asset: 'hash9001',
				profile_effect_id: 9002n,
				profile_effect_asset: 'hash9002',
				nameplate_id: 9003n,
				nameplate_asset: 'hash9003',
			},
			worn.toRow(),
		);
		const dispatchPresence = vi.spyOn(getGatewayService(), 'dispatchPresence');

		vi.setSystemTime(paidUntil.getTime() + 1000);
		await processPremiumExpirations({}, HELPERS);
		const after = await readUser(userId);
		expect([after.nameplateId, after.nameplateAsset]).toEqual([null, null]);
		expect([after.avatarDecorationId, after.avatarDecorationAsset]).toEqual([9001n, 'hash9001']);
		expect([after.profileEffectId, after.profileEffectAsset]).toEqual([9002n, 'hash9002']);
		const cosmeticUpdates = () =>
			dispatchPresence.mock.calls.filter(
				([call]) => call.event === 'USER_UPDATE' && (call.data as {nameplate_data?: unknown}).nameplate_data === null,
			).length;
		expect(cosmeticUpdates()).toBeGreaterThan(0);

		const updatesBefore = dispatchPresence.mock.calls.length;
		vi.setSystemTime(paidUntil.getTime() + ms('1 day'));
		await getPremiumLedgerService().trackExpiration(userId, new Date(paidUntil.getTime() + ms('1 day') - 1000));
		await processPremiumExpirations({}, HELPERS);
		expect((await readUser(userId)).toRow()).toEqual(after.toRow());
		expect(dispatchPresence.mock.calls.length).toBe(updatesBefore);
	});

	it('stops reading a past day once every row in it is settled', async () => {
		const {userId} = await createMemberWithGuildAvatar();
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});
		const expiredDay = premiumExpirationDay(paidUntil);
		const shard = premiumExpirationShard(userId);
		const list = vi.spyOn(PremiumLedgerRepository.prototype, 'listExpirations');
		const readsOfExpiredPartition = () =>
			list.mock.calls.filter(([day, callShard]) => day === expiredDay && callShard === shard).length;

		vi.setSystemTime(paidUntil.getTime() + ms('1 day'));
		await processPremiumExpirations({}, HELPERS);
		expect(readsOfExpiredPartition()).toBe(1);
		await processPremiumExpirations({}, HELPERS);

		expect(readsOfExpiredPartition()).toBe(1);
		expect((await readUser(userId)).premiumType).toBeNull();
	});

	it('comes back for an expiration it could not settle within the first days', async () => {
		const {userId, guildId} = await createMemberWithGuildAvatar();
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'days', quantity: 1},
			source: 'payriff',
		});
		const lockKey = `premium:grant:${userId}`;

		vi.setSystemTime(paidUntil.getTime() + 1000);
		await getKVClient().acquireLock(lockKey, 'stuck-holder', 30);
		await processPremiumExpirations({}, HELPERS);
		expect((await readUser(userId)).premiumType).toBe(1);
		await getKVClient().releaseLock(lockKey, 'stuck-holder');
		vi.setSystemTime(paidUntil.getTime() + ms('8 days'));
		await processPremiumExpirations({}, HELPERS);

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(await isSanitized(guildId, userId)).toBe(true);
	});

	it("still settles today's expirations when an older day cannot be read, and keeps that day for the next run", async () => {
		const {userId, guildId} = await createMemberWithGuildAvatar();
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});
		const unreadableDay = premiumExpirationDay(paidUntil) - 2;
		const listExpirations = PremiumLedgerRepository.prototype.listExpirations;
		vi.spyOn(PremiumLedgerRepository.prototype, 'listExpirations').mockImplementation(function (
			this: PremiumLedgerRepository,
			day,
			...rest
		) {
			if (day === unreadableDay) {
				return Promise.reject(new Error('read timeout'));
			}
			return listExpirations.call(this, day, ...rest);
		});

		vi.setSystemTime(paidUntil.getTime() + 1000);
		await processPremiumExpirations({}, HELPERS);

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(await isSanitized(guildId, userId)).toBe(true);
		expect(await getKVClient().get('premium:expirations:cursor')).toBe(String(unreadableDay));
	});

	it('catches up on the days it did not run', async () => {
		const {userId, guildId} = await createMemberWithGuildAvatar();
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'days', quantity: 1},
			source: 'payriff',
		});

		await processPremiumExpirations({}, HELPERS);
		vi.setSystemTime(paidUntil.getTime() + ms('9 days'));
		await processPremiumExpirations({}, HELPERS);

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(await isSanitized(guildId, userId)).toBe(true);
	});

	it('leaves a user whose paid time was extended untouched', async () => {
		const {userId, guildId} = await createMemberWithGuildAvatar();
		const ledger = getPremiumLedgerService();
		const first = await ledger.grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});
		await ledger.grant({
			userId,
			grantKey: 'order-2:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});

		vi.setSystemTime(first.paidUntil.getTime() + 1000);
		await processPremiumExpirations({}, HELPERS);

		expect(checkIsPremium(await readUser(userId))).toBe(true);
		expect(await isSanitized(guildId, userId)).toBe(false);
	});

	it('waits out the upstream gift grace before cleaning up', async () => {
		const {userId, guildId} = await createMemberWithGuildAvatar();
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'trial',
			duration: {unit: 'days', quantity: 7},
			source: 'trial',
		});
		const giftEnd = new Date(paidUntil.getTime() + ms('1 day'));
		await getUserRepository().patchUpsert(userId, {
			premium_gift_extension_ends_at: giftEnd,
			premium_grace_ends_at: null,
		});
		const graceEnd = giftEnd.getTime() + PREMIUM_GRACE_PERIOD_MS;

		vi.setSystemTime(paidUntil.getTime() + 1000);
		await processPremiumExpirations({}, HELPERS);
		vi.setSystemTime(graceEnd - 1000);
		await processPremiumExpirations({}, HELPERS);
		expect(await isSanitized(guildId, userId)).toBe(false);
		expect(checkIsPremium(await readUser(userId))).toBe(true);
		vi.setSystemTime(graceEnd + 1000);
		await processPremiumExpirations({}, HELPERS);

		expect(await isSanitized(guildId, userId)).toBe(true);
		expect((await readUser(userId)).premiumType).toBeNull();
	});

	it('retains expiration and cosmetics until a deferred store refresh confirms access ended', async () => {
		const {userId} = await createMemberWithGuildAvatar();
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId,
			grantKey: 'trial',
			duration: {unit: 'days', quantity: 1},
			source: 'trial',
		});
		vi.setSystemTime(paidUntil.getTime() + 1000);
		const row = buildStorePurchaseRow({
			user_id: userId,
			expires_at: new Date(Date.now() - ms('2 hours')),
			synced_at: new Date(Date.now() - ms('3 hours')),
		});
		const deps = getWorkerDependencies();
		const purchases = vi.spyOn(deps.storeEntitlementService, 'listStorePurchases').mockResolvedValue([row]);
		const refresh = vi.spyOn(deps.workerService, 'addJob');
		const removeCosmetics = vi.spyOn(getCosmeticService(), 'removePremiumOnlyCosmetics');
		const listExpiration = () =>
			getPremiumLedgerRepository().listExpirations(premiumExpirationDay(paidUntil), premiumExpirationShard(userId), 10);

		await processPremiumExpirations({}, HELPERS);

		expect(refresh).toHaveBeenCalledWith(
			'refreshStorePurchase',
			{storeKey: row.store_key},
			{jobKey: `refreshStorePurchase:${row.store_key}`},
		);
		expect(removeCosmetics).not.toHaveBeenCalled();
		expect((await listExpiration()).map((entry) => entry.user_id)).toContain(userId);

		purchases.mockResolvedValue([{...row, synced_at: new Date()}]);
		await processPremiumExpirations({}, HELPERS);

		expect(removeCosmetics).toHaveBeenCalledWith(userId);
		expect(await listExpiration()).toEqual([]);
	});
});
