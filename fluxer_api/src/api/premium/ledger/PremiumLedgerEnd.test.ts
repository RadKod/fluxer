// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {
	getAdminRepository,
	getPremiumLedgerRepository,
	getPremiumLedgerService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {addGiftCodeDuration} from '@app/api/models/GiftCode';
import type {User} from '@app/api/models/User';
import {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {
	type PremiumGrant,
	premiumExpirationDay,
	premiumExpirationShard,
} from '@app/api/premium/ledger/PremiumLedgerService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {EndUserPremiumResponse} from '@fluxer/schema/src/domains/premium/PremiumLedgerSchemas';
import {ms} from 'itty-time';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('PremiumLedgerService.endPaidPremium', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function createUser(): Promise<UserID> {
		const account = await createTestAccount(harness);
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
		return createUserID(BigInt(account.userId));
	}

	async function readUser(userId: UserID): Promise<User> {
		return (await getUserRepository().findUnique(userId))!;
	}

	function oneMonth(userId: UserID, grantKey: string): PremiumGrant {
		return {userId, grantKey, duration: {unit: 'months', quantity: 1}, source: 'payriff'};
	}

	function userUpdatesFor(spy: ReturnType<typeof spyOnPresence>, userId: UserID) {
		return spy.mock.calls
			.map(([params]) => params as unknown as {userId: UserID; event: string})
			.filter((params) => params.event === 'USER_UPDATE' && params.userId === userId);
	}

	function spyOnPresence() {
		return vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
	}

	async function makeLifetime(userId: UserID): Promise<void> {
		// A Visionary account has three null end fields; the ledger must support it independently of the grant path.
		await getUserRepository().patchUpsert(userId, {
			premium_type: UserPremiumTypes.LIFETIME,
			premium_since: NOW,
			premium_until: null,
			premium_gift_extension_ends_at: null,
			premium_grace_ends_at: null,
		});
		await getPremiumLedgerRepository().create({
			user_id: userId,
			paid_until: new Date(NOW.getTime() + ms('30 days')),
			applied_grants: null,
			trial_used_at: null,
			version: 1,
		});
	}

	it('ends paid premium now: ledger paid_until is now, premium off, USER_UPDATE, expiration tracked', async () => {
		const userId = await createUser();
		const service = getPremiumLedgerService();
		await service.grant(oneMonth(userId, 'order-1'));
		expect(checkIsPremium(await readUser(userId))).toBe(true);
		const presence = spyOnPresence();

		const result = await service.endPaidPremium(userId);

		expect(result).toEqual({previousPaidUntil: addGiftCodeDuration(NOW, 'months', 1), paidUntil: NOW});
		expect((await getPremiumLedgerRepository().find(userId))?.paid_until).toEqual(NOW);
		const user = await readUser(userId);
		expect(user.premiumGiftExtensionEndsAt).toEqual(NOW);
		expect(user.premiumGraceEndsAt).toEqual(NOW);
		expect(userUpdatesFor(presence, userId)).toHaveLength(1);
		expect(
			await getPremiumLedgerRepository().listExpirations(premiumExpirationDay(NOW), premiumExpirationShard(userId), 10),
		).toEqual([{day: premiumExpirationDay(NOW), shard: premiumExpirationShard(userId), user_id: userId}]);
		vi.setSystemTime(NOW.getTime() + 1000);
		expect(checkIsPremium(await readUser(userId))).toBe(false);
		expect(await service.isActive(userId)).toBe(false);
	});

	it('a second call changes nothing', async () => {
		const userId = await createUser();
		const service = getPremiumLedgerService();
		await service.grant(oneMonth(userId, 'order-1'));
		await service.endPaidPremium(userId);
		vi.setSystemTime(NOW.getTime() + ms('1 minute'));
		const ledgerWrite = vi.spyOn(PremiumLedgerRepository.prototype, 'update');
		const expirationWrite = vi.spyOn(PremiumLedgerRepository.prototype, 'addExpiration');
		const userWrite = vi.spyOn(UserRepository.prototype, 'patchUpsert');
		const presence = spyOnPresence();

		const again = await service.endPaidPremium(userId);

		expect(again).toEqual({previousPaidUntil: NOW, paidUntil: NOW});
		expect(ledgerWrite).not.toHaveBeenCalled();
		expect(expirationWrite).not.toHaveBeenCalled();
		expect(userWrite).not.toHaveBeenCalled();
		expect(userUpdatesFor(presence, userId)).toHaveLength(0);
	});

	it('the admin route needs USER_UPDATE_FLAGS and records end_user_premium with the previous end', async () => {
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		const {paidUntil} = await getPremiumLedgerService().grant(oneMonth(userId, 'order-1'));
		const outsider = await setUserACLs(harness, await createTestAccount(harness), [AdminACLs.AUTHENTICATE]);
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.USER_UPDATE_FLAGS,
		]);

		await createBuilder(harness, outsider.token)
			.post(`/admin/users/${account.userId}/premium/end`)
			.expect(403, APIErrorCodes.MISSING_ACL)
			.execute();
		expect((await getPremiumLedgerRepository().find(userId))?.paid_until).toEqual(paidUntil);

		const response = await createBuilder<EndUserPremiumResponse>(harness, admin.token)
			.post(`/admin/users/${account.userId}/premium/end`)
			.header('X-Audit-Log-Reason', 'Refund 42')
			.expect(200)
			.execute();

		expect(response.previous_paid_until).toBe(paidUntil.toISOString());
		const endedAt = (await getPremiumLedgerRepository().find(userId))!.paid_until!;
		expect(response.paid_until).toBe(endedAt.toISOString());
		expect(endedAt.getTime()).toBeLessThanOrEqual(Date.now());
		const logs = (await getAdminRepository().listAllAuditLogsPaginated(1000)).filter(
			(log) => log.action === 'end_user_premium',
		);
		expect(logs).toHaveLength(1);
		expect(logs[0]!.adminUserId.toString()).toBe(admin.userId);
		expect(logs[0]!.targetType).toBe('user');
		expect(logs[0]!.targetId.toString()).toBe(account.userId);
		expect(logs[0]!.auditLogReason).toBe('Refund 42');
		expect(Object.fromEntries(logs[0]!.metadata)).toEqual({previous_paid_until: paidUntil.toISOString()});
	});

	it('a later payriff grant starts from now, not from the old end', async () => {
		const userId = await createUser();
		const service = getPremiumLedgerService();
		await service.grant(oneMonth(userId, 'order-1'));
		await service.endPaidPremium(userId);
		const later = new Date(NOW.getTime() + ms('1 hour'));
		vi.setSystemTime(later);

		const {paidUntil, newlyApplied} = await service.grant(oneMonth(userId, 'order-2'));

		expect(newlyApplied).toBe(true);
		expect(paidUntil).toEqual(addGiftCodeDuration(later, 'months', 1));
		expect((await readUser(userId)).premiumGiftExtensionEndsAt).toEqual(paidUntil);
	});

	it('ledger repair writes nothing for a lifetime account', async () => {
		const userId = await createUser();
		await makeLifetime(userId);
		const userWrite = vi.spyOn(UserRepository.prototype, 'patchUpsert');

		await getPremiumLedgerService().ensureUserPremium(userId);

		expect(userWrite).not.toHaveBeenCalled();
		const user = await readUser(userId);
		expect(user.premiumType).toBe(UserPremiumTypes.LIFETIME);
		expect(user.premiumUntil).toBeNull();
		expect(user.premiumGiftExtensionEndsAt).toBeNull();
		expect(user.premiumGraceEndsAt).toBeNull();
	});

	it("ending paid premium keeps a Visionary's lifetime premium", async () => {
		const userId = await createUser();
		await makeLifetime(userId);
		const userWrite = vi.spyOn(UserRepository.prototype, 'patchUpsert');
		const presence = spyOnPresence();

		await getPremiumLedgerService().endPaidPremium(userId);

		expect((await getPremiumLedgerRepository().find(userId))?.paid_until).toEqual(NOW);
		expect(userWrite).not.toHaveBeenCalled();
		expect(userUpdatesFor(presence, userId)).toHaveLength(0);
		vi.setSystemTime(NOW.getTime() + ms('1 day'));
		const user = await readUser(userId);
		expect(user.premiumType).toBe(UserPremiumTypes.LIFETIME);
		expect(checkIsPremium(user)).toBe(true);
	});
});
