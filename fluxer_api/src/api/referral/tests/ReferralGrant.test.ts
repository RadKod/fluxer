// SPDX-License-Identifier: AGPL-3.0-or-later

import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import {referralPendingMonth} from '@app/api/database/types/ReferralTypes';
import {createRewardFixture, REFERRER, type RewardFixture} from '@app/api/referral/tests/ReferralRewardTestUtils';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import grantReferralRewards from '@app/api/worker/tasks/GrantReferralRewards';
import {setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const fixture = vi.hoisted(() => ({current: null as null | {service: unknown}}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({getReferralRewardService: () => fixture.current!.service}));

const NOW = new Date('2026-10-10T12:00:00.000Z');
const ITEM_ID = '1490000000000000700';

describe('ReferralRewardService.grantDue', () => {
	let f: RewardFixture;

	beforeEach(() => {
		f = createRewardFixture();
		fixture.current = f;
		f.addUser(REFERRER);
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const rewards = () => f.repository.getRewards(REFERRER);
	const grant = () => f.service.grantDue(REFERRER, {backfill: false});

	it('cosmetic tier → deliverOwned with key referral:<tier>, wear false, auto_delivered', async () => {
		f.addTier('11', 1, {type: 'cosmetic', item_id: ITEM_ID});
		await f.setValid(REFERRER, 1);

		expect(await grant()).toEqual([{tier_id: '11', reward_type: 'cosmetic'}]);

		expect(f.cosmeticService.deliverOwned).toHaveBeenCalledWith(REFERRER, BigInt(ITEM_ID), 'referral:11', 'referral', {
			wear: false,
		});
		expect(await rewards()).toEqual([
			expect.objectContaining({tier_id: 11n, status: 'auto_delivered', granted_at: NOW, delivered_at: NOW}),
		]);
	});

	it('premium tier → ledger grant with source referral and the tier as key', async () => {
		f.addTier('12', 2, {type: 'premium_days', days: 30});
		await f.setValid(REFERRER, 2);

		await grant();

		expect(f.premiumLedgerService.grant).toHaveBeenCalledWith({
			userId: REFERRER,
			grantKey: '12',
			source: 'referral',
			duration: {unit: 'days', quantity: 30},
		});
		expect((await rewards())[0]?.status).toBe('auto_delivered');
	});

	it('offsite → pending_admin + pending row at granted_at, no DM or e-mail job', async () => {
		f.addTier('13', 1, {type: 'offsite', description: 'Steam card'});
		await f.setValid(REFERRER, 1);

		expect(await grant()).toEqual([{tier_id: '13', reward_type: 'offsite'}]);

		expect((await rewards())[0]).toMatchObject({status: 'pending_admin', code: null, delivered_at: null});
		const pending = await f.repository.listPendingRewards(referralPendingMonth(NOW), null, 10);
		expect(pending.items).toEqual([expect.objectContaining({user_id: REFERRER, tier_id: 13n, created_at: NOW})]);
		expect(f.jobs).toEqual([]);
	});

	it('only enabled tiers the count reaches; a disabled tier grants nothing', async () => {
		f.addTier('21', 1, {type: 'premium_days', days: 7}, false);
		f.addTier('22', 5, {type: 'premium_days', days: 7});
		await f.setValid(REFERRER, 4);

		expect(await grant()).toEqual([]);
		expect(await rewards()).toEqual([]);
		expect(f.premiumLedgerService.grant).not.toHaveBeenCalled();
	});

	it('retried job delivers once', async () => {
		f.addTier('11', 1, {type: 'cosmetic', item_id: ITEM_ID});
		await f.setValid(REFERRER, 3);

		await grant();
		expect(await grant()).toEqual([]);
		await Promise.all([grant(), grant()]);

		expect(f.cosmeticService.deliverOwned).toHaveBeenCalledTimes(1);
	});

	it('a crash after the claim: the next grantDue finishes it with the stored reward (rev 2 O2)', async () => {
		f.addTier('13', 1, {type: 'offsite', description: 'Steam card'});
		f.addTier('11', 1, {type: 'cosmetic', item_id: ITEM_ID});
		await f.setValid(REFERRER, 1);
		f.cosmeticService.deliverOwned.mockRejectedValueOnce(new Error('connection reset'));

		await expect(grant()).rejects.toThrow('connection reset');
		// The other tier still went through.
		expect((await rewards()).map((row) => [row.tier_id, row.status]).sort()).toEqual([
			[11n, 'granting'],
			[13n, 'pending_admin'],
		]);

		vi.setSystemTime(new Date(NOW.getTime() + 60_000));
		expect(await grant()).toEqual([{tier_id: '11', reward_type: 'cosmetic'}]);
		expect((await rewards()).find((row) => row.tier_id === 11n)).toMatchObject({
			status: 'auto_delivered',
			granted_at: NOW,
		});
	});

	it('a gone or banned referrer gets nothing (rev 2 O1)', async () => {
		f.addTier('12', 1, {type: 'premium_days', days: 7});
		await f.setValid(REFERRER, 1);
		f.users.get(REFERRER)!.flags = UserFlags.DISABLED;
		f.users.get(REFERRER)!.tempBannedUntil = new Date(NOW.getTime() + 86_400_000);

		expect(await grant()).toEqual([]);
		f.users.delete(REFERRER);
		expect(await grant()).toEqual([]);
		expect(await rewards()).toEqual([]);
	});

	it('the job writes one audit entry per reward by SYSTEM_USER_ID, metadata without any code', async () => {
		const createAuditLog = vi.fn(async (log: Record<string, unknown>) => ({...log, logId: 1n}));
		setWorkerDependenciesForTest({
			adminRepository: {createAuditLog} as never,
			snowflakeService: {generate: async () => 99n} as never,
		});
		f.addTier('13', 1, {type: 'offsite', description: 'Steam card'});
		f.addTier('12', 1, {type: 'premium_days', days: 7});
		await f.setValid(REFERRER, 1);
		const helpers = {logger: new NoopLogger(), jobId: 1n} as unknown as WorkerTaskHelpers;

		await grantReferralRewards({user_id: REFERRER.toString()}, helpers);

		expect(createAuditLog).toHaveBeenCalledTimes(2);
		for (const [log] of createAuditLog.mock.calls) {
			expect(log).toMatchObject({admin_user_id: SYSTEM_USER_ID, target_id: REFERRER, action: 'referral_grant'});
			expect([...(log.metadata as Map<string, string>).keys()].sort()).toEqual(['reward_type', 'tier_id']);
		}
		expect(createAuditLog.mock.calls.map(([log]) => (log.metadata as Map<string, string>).get('reward_type'))).toEqual([
			'offsite',
			'premium_days',
		]);
	});
});
