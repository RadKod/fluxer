// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {
	getPremiumLedgerRepository,
	getPremiumLedgerService,
	getUserCacheService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {TRIAL_GRANT_KEY} from '@app/api/premium/ledger/PremiumLedgerService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {
	deleteAccount,
	setPendingDeletionAt,
	triggerDeletionWorker,
	waitForDeletionCompletion,
} from '@app/api/user/tests/UserTestUtils';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('premium ledger on account deletion', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		setWorkerDependenciesForTest({
			kvClient: getKVClient(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
		});
	});
	afterEach(() => {
		clearWorkerDependencies();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('ends the paid period and forgets the trial but keeps the grant keys, so a replayed delivery grants nothing', async () => {
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		const ledger = getPremiumLedgerService();
		const purchase = {userId, grantKey: 'order-1:premium', duration: {unit: 'months', quantity: 1}} as const;
		await ledger.grant({...purchase, source: 'payriff'});
		await ledger.grant({userId, grantKey: TRIAL_GRANT_KEY, duration: {unit: 'days', quantity: 7}, source: 'trial'});

		await deleteAccount(harness, account.token, account.password);
		await setPendingDeletionAt(harness, account.userId, new Date(Date.now() - 60_000));
		await triggerDeletionWorker(harness);
		await waitForDeletionCompletion(harness, account.userId);

		const row = (await getPremiumLedgerRepository().find(userId))!;
		expect(row.paid_until!.getTime()).toBeLessThanOrEqual(Date.now());
		expect(row.trial_used_at).toBeNull();
		expect([...row.applied_grants!.keys()]).toEqual(['payriff:order-1:premium']);

		expect((await ledger.grant({...purchase, source: 'payriff'})).newlyApplied).toBe(false);
		await ledger.ensureUserPremium(userId);
		const user = (await getUserRepository().findUnique(userId))!;
		expect(checkIsPremium(user)).toBe(false);
		expect(user.premiumGiftExtensionEndsAt).toBeNull();
	});

	it('refuses a grant that arrives after the deletion, so the anonymised ledger row is never written again', async () => {
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		const ledger = getPremiumLedgerService();
		await ledger.grant({
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});

		await deleteAccount(harness, account.token, account.password);
		await setPendingDeletionAt(harness, account.userId, new Date(Date.now() - 60_000));
		await triggerDeletionWorker(harness);
		await waitForDeletionCompletion(harness, account.userId);
		const anonymised = await getPremiumLedgerRepository().find(userId);

		const lateGrants = [
			{userId, grantKey: 'order-2:premium', duration: {unit: 'months', quantity: 1}, source: 'payriff'},
			{userId, grantKey: TRIAL_GRANT_KEY, duration: {unit: 'days', quantity: 7}, source: 'trial'},
		] as const;
		for (const late of lateGrants) {
			await expect(ledger.grant(late)).rejects.toBeInstanceOf(UnknownUserError);
		}
		expect(await getPremiumLedgerRepository().find(userId)).toEqual(anonymised);
	});

	it('refuses a grant to a user that does not exist and creates no ledger row', async () => {
		const userId = createUserID(999_999_999_999n);
		const grant = {
			userId,
			grantKey: 'order-1:premium',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		} as const;

		await expect(getPremiumLedgerService().grant(grant)).rejects.toBeInstanceOf(UnknownUserError);
		expect(await getPremiumLedgerRepository().find(userId)).toBeNull();
	});
});
