// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import {createRewardFixture, type RewardFixture} from '@app/api/referral/tests/ReferralRewardTestUtils';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import backfillReferralTier from '@app/api/worker/tasks/BackfillReferralTier';
import {setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const fixture = vi.hoisted(() => ({current: null as null | {service: unknown}}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({getReferralRewardService: () => fixture.current!.service}));

const ADMIN = '1490000000000000001';

describe('ReferralRewardService.backfillTierPage', () => {
	let f: RewardFixture;
	const referrers = new Map<number, UserID>();

	beforeEach(async () => {
		f = createRewardFixture();
		fixture.current = f;
		referrers.clear();
		// Referrers with 1..12 valid referrals, in their bands as evaluate leaves them.
		for (let count = 1; count <= 12; count++) {
			const id = createUserID(1490000000000001000n + BigInt(count));
			f.addUser(id);
			await f.setValid(id, count);
			await f.repository.setBand(id, 0, count);
			referrers.set(count, id);
		}
	});

	async function runAll(tierId: string) {
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page: {granted: number; nextCursor: string | null} = await f.service.backfillTierPage(tierId, cursor);
			cursor = page.nextCursor;
			pages++;
		} while (cursor);
		return pages;
	}

	const grantedUsers = () =>
		f.premiumLedgerService.grant.mock.calls.map((call) => (call as unknown as [{userId: bigint}])[0].userId).sort();
	const atLeast = (threshold: number) =>
		[...referrers.entries()]
			.filter(([count]) => count >= threshold)
			.map(([, id]) => id)
			.sort();

	it('new tier at 5 grants ≥5 only, with no DM or e-mail', async () => {
		f.addTier('31', 5, {type: 'premium_days', days: 7});

		await runAll('31');

		expect(grantedUsers()).toEqual(atLeast(5));
		expect(f.jobs).toEqual([]);
	});

	it('lowered threshold backfills; raised threshold revokes nothing', async () => {
		const tier = f.addTier('31', 10, {type: 'premium_days', days: 7});
		await runAll('31');
		expect(grantedUsers()).toEqual(atLeast(10));

		tier.threshold = 3;
		await runAll('31');
		expect(grantedUsers()).toEqual(atLeast(3));

		tier.threshold = 11;
		await runAll('31');
		expect(grantedUsers()).toEqual(atLeast(3));
		expect((await f.repository.getRewards(referrers.get(3)!))[0]?.status).toBe('auto_delivered');
	});

	it('a stale worker copy of the config still grants the new tier and the lowered threshold (V1)', async () => {
		const tier = f.addTier('31', 10, {type: 'premium_days', days: 7});
		const stale = structuredClone(f.config);
		f.service.deps.instanceConfigRepository.getReferralConfig = async () => structuredClone(stale);
		tier.threshold = 3;
		f.addTier('32', 12, {type: 'cosmetic', item_id: '1490000000000000700'});

		await runAll('31');
		await runAll('32');

		expect(grantedUsers()).toEqual(atLeast(3));
		expect(f.cosmeticService.deliverOwned).toHaveBeenCalledTimes(1);
	});

	it('reaches the top band: a referrer above band 20 is granted (CR6)', async () => {
		const big = createUserID(1490000000000009999n);
		f.addUser(big);
		await f.setValid(big, 2 ** 21);
		await f.repository.setBand(big, 0, 2 ** 21);
		f.addTier('31', 1_000_000, {type: 'premium_days', days: 7});

		await runAll('31');

		expect(grantedUsers()).toEqual([big]);
	});

	it('the job writes a referral_grant audit entry per reward it grants (V3)', async () => {
		const createAuditLog = vi.fn(async (log: Record<string, unknown>) => ({...log, logId: 1n}));
		setWorkerDependenciesForTest({
			adminRepository: {createAuditLog} as never,
			snowflakeService: {generate: async () => 99n} as never,
		});
		f.addTier('31', 10, {type: 'premium_days', days: 7});
		const helpers = {
			logger: new NoopLogger(),
			jobId: 7n,
			addJob: vi.fn(async () => 1n),
		} as unknown as WorkerTaskHelpers;

		await backfillReferralTier({tier_id: '31', admin_user_id: ADMIN}, helpers);

		const grants = createAuditLog.mock.calls.map(([log]) => log).filter((log) => log.action === 'referral_grant');
		expect(grants.map((log) => log.target_id).sort()).toEqual(atLeast(10));
		for (const log of grants) {
			expect(log).toMatchObject({admin_user_id: SYSTEM_USER_ID, target_type: 'user'});
			expect(Object.fromEntries(log.metadata as Map<string, string>)).toEqual({
				tier_id: '31',
				reward_type: 'premium_days',
			});
		}
	});

	it('a closed or deleted tier ends the backfill at once', async () => {
		f.addTier('31', 1, {type: 'premium_days', days: 7}, false);
		expect(await f.service.backfillTierPage('31', null)).toEqual({granted: 0, nextCursor: null});
		expect(await f.service.backfillTierPage('99', null)).toEqual({granted: 0, nextCursor: null});
	});

	it('pages bands: one page stops at 500 rows and the cursor carries on', async () => {
		for (let i = 0; i < 520; i++) {
			const id = createUserID(1490000000000100000n + BigInt(i));
			f.addUser(id);
			await f.setValid(id, 2);
			await f.repository.setBand(id, 0, 2);
		}
		f.addTier('31', 2, {type: 'premium_days', days: 7});

		const first = await f.service.backfillTierPage('31', null);
		expect(first.nextCursor).toMatch(/^1:\d+:\d*$/);
		expect(first.granted).toBeLessThanOrEqual(500);

		expect(await runAll('31')).toBeGreaterThan(1);
		expect(new Set(grantedUsers()).size).toBe(520 + 11);
	});

	it('the job queues the next page itself and writes one summary audit at the end', async () => {
		const createAuditLog = vi.fn(async (log: Record<string, unknown>) => ({...log, logId: 1n}));
		setWorkerDependenciesForTest({
			adminRepository: {createAuditLog} as never,
			snowflakeService: {generate: async () => 99n} as never,
		});
		f.addTier('31', 5, {type: 'premium_days', days: 7});
		const addJob = vi.fn(async () => 1n);
		const helpers = {logger: new NoopLogger(), jobId: 7n, addJob} as unknown as WorkerTaskHelpers;
		vi.spyOn(f.service, 'backfillTierPage')
			.mockResolvedValueOnce({granted: 3, nextCursor: '3:0:'})
			.mockResolvedValueOnce({granted: 5, nextCursor: null});

		await backfillReferralTier({tier_id: '31', admin_user_id: ADMIN}, helpers);
		expect(addJob).toHaveBeenCalledWith(
			'backfillReferralTier',
			{tier_id: '31', admin_user_id: ADMIN, cursor: '3:0:', granted: 3},
			{jobKey: '31:3:0:'},
		);
		expect(createAuditLog).not.toHaveBeenCalled();

		await backfillReferralTier({tier_id: '31', admin_user_id: ADMIN, cursor: '3:0:', granted: 3}, helpers);
		expect(createAuditLog).toHaveBeenCalledTimes(1);
		expect(createAuditLog.mock.calls[0]![0]).toMatchObject({
			admin_user_id: BigInt(ADMIN),
			target_type: 'referral_tier',
			target_id: 31n,
			action: 'referral_backfill',
		});
		expect(Object.fromEntries(createAuditLog.mock.calls[0]![0].metadata as Map<string, string>)).toEqual({
			tier_id: '31',
			granted: '8',
			job_id: '7',
		});
	});
});
