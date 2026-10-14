// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {
	getPremiumLedgerRepository,
	getPremiumLedgerService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {addGiftCodeDuration} from '@app/api/models/GiftCode';
import {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import type {PremiumGrant} from '@app/api/premium/ledger/PremiumLedgerService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('PremiumLedgerService grant keys', () => {
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

	function oneMonth(userId: UserID, grantKey: string): PremiumGrant {
		return {userId, grantKey, duration: {unit: 'months', quantity: 1}, source: 'payriff'};
	}

	it('recognises a grant key after 200 newer grants', async () => {
		const userId = await createUser();
		const service = getPremiumLedgerService();
		const day = (grantKey: string): PremiumGrant => ({
			userId,
			grantKey,
			duration: {unit: 'days', quantity: 1},
			source: 'payriff',
		});
		const first = await service.grant(day('order-0'));
		for (let i = 1; i <= 201; i++) {
			vi.setSystemTime(NOW.getTime() + i);
			await service.grant(day(`order-${i}`));
		}
		const before = (await getPremiumLedgerRepository().find(userId))!;
		expect(before.applied_grants?.has('payriff:order-0')).toBe(false);

		const again = await service.grant(day('order-0'));

		expect(first.newlyApplied).toBe(true);
		expect(again.newlyApplied).toBe(false);
		expect((await getPremiumLedgerRepository().find(userId))!.paid_until).toEqual(before.paid_until);
		expect((await getPremiumLedgerRepository().findGrantKey(userId, 'payriff:order-0'))?.state).toBe('delivered');
	});

	it('a grant whose ledger write landed but whose key row stayed pending finishes without adding time', async () => {
		const userId = await createUser();
		const service = getPremiumLedgerService();
		const end = addGiftCodeDuration(NOW, 'months', 1)!;
		vi.spyOn(PremiumLedgerRepository.prototype, 'markGrantKeyDelivered').mockRejectedValueOnce(
			new Error('connection reset after the ledger write'),
		);

		await expect(service.grant(oneMonth(userId, 'order-1'))).rejects.toThrow('connection reset after the ledger write');
		expect((await getPremiumLedgerRepository().findGrantKey(userId, 'payriff:order-1'))?.state).toBe('pending');
		const retry = await service.grant(oneMonth(userId, 'order-1'));

		expect(retry).toEqual({paidUntil: end, newlyApplied: false});
		expect((await getPremiumLedgerRepository().find(userId))?.paid_until).toEqual(end);
		const key = await getPremiumLedgerRepository().findGrantKey(userId, 'payriff:order-1');
		expect(key?.state).toBe('delivered');
		expect(key?.delivered_at).toEqual(NOW);
	});

	it('concurrent grants of one key add the time once', async () => {
		const userId = await createUser();
		const service = getPremiumLedgerService();

		const results = await Promise.all(Array.from({length: 5}, () => service.grant(oneMonth(userId, 'order-1'))));

		expect(results.filter((result) => result.newlyApplied)).toHaveLength(1);
		expect((await getPremiumLedgerRepository().find(userId))?.paid_until).toEqual(
			addGiftCodeDuration(NOW, 'months', 1),
		);
		expect((await getPremiumLedgerRepository().findGrantKey(userId, 'payriff:order-1'))?.state).toBe('delivered');
	});

	it("'referral:<tier>' key is idempotent", async () => {
		const userId = await createUser();
		const service = getPremiumLedgerService();
		const grant: PremiumGrant = {userId, grantKey: '42', duration: {unit: 'days', quantity: 7}, source: 'referral'};

		const first = await service.grant(grant);
		const again = await service.grant(grant);

		expect(first.newlyApplied).toBe(true);
		expect(again.newlyApplied).toBe(false);
		expect((await getPremiumLedgerRepository().find(userId))?.paid_until).toEqual(addGiftCodeDuration(NOW, 'days', 7));
		expect((await getPremiumLedgerRepository().findGrantKey(userId, 'referral:42'))?.state).toBe('delivered');
	});

	it('the trial keeps using trial_used_at and writes no key row', async () => {
		const userId = await createUser();

		await getPremiumLedgerService().grant({
			userId,
			grantKey: 'trial',
			duration: {unit: 'days', quantity: 7},
			source: 'trial',
		});

		expect((await getPremiumLedgerRepository().find(userId))?.trial_used_at).toEqual(NOW);
		expect(await getPremiumLedgerRepository().findGrantKey(userId, 'trial:trial')).toBeNull();
	});

	it('a payriff grant still marks the account as a buyer', async () => {
		const userId = await createUser();

		await getPremiumLedgerService().grant(oneMonth(userId, 'order-1'));

		expect((await getUserRepository().findUnique(userId))?.hasEverPurchased).toBe(true);
		expect((await getPremiumLedgerRepository().findGrantKey(userId, 'payriff:order-1'))?.state).toBe('delivered');
	});
});
