// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAdminApiKey} from '@app/api/admin/tests/AdminTestUtils';
import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getAdminRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

describe('Admin boost backfill', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	test.each([{acls: []}, {acls: ['bulk:update:user_flags']}, {acls: ['guild:update:features']}])(
		'rejects an admin without bulk guild feature permission: $acls',
		async ({acls}) => {
			const account = await createTestAccount(harness);
			const admin = await setUserACLs(harness, account, ['admin:authenticate', ...acls]);
			const enqueue = vi.spyOn(getWorkerService(), 'addJob');
			await createBuilder(harness, admin.token)
				.post('/admin/bulk-jobs')
				.body({task: 'backfill_guild_boosts'})
				.expect(HTTP_STATUS.FORBIDDEN)
				.execute();
			expect(enqueue).not.toHaveBeenCalled();
		},
	);

	test('queues a ledger-backed job and audits the triggering admin', async () => {
		const account = await createTestAccount(harness);
		const admin = await setUserACLs(harness, account, [
			'admin:authenticate',
			'bulk:update:guild_features',
			'jobs:view',
		]);
		const enqueue = vi.spyOn(getWorkerService(), 'addJob');
		const queued = await createBuilder<{job_id: string}>(harness, admin.token)
			.post('/admin/bulk-jobs')
			.body({task: 'backfill_guild_boosts'})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(queued.job_id).toMatch(/^\d+$/);
		expect(enqueue).toHaveBeenCalledWith(
			'backfillGuildBoosts',
			{admin_user_id: admin.userId, audit_log_reason: null},
			{requestedByUserId: BigInt(admin.userId), requireLedger: true},
		);
		const logs = await getAdminRepository().listAllAuditLogsPaginated(100);
		const audit = logs.find((log) => log.action === 'queue_bulk_job' && log.targetId.toString() === queued.job_id);
		expect(audit?.adminUserId.toString()).toBe(admin.userId);
		expect(audit?.metadata.get('task')).toBe('backfill_guild_boosts');
	});

	test('rejects a scoped key after its owner loses guild feature permission', async () => {
		const admin = await createTestAccount(harness);
		await setUserACLs(harness, admin, [
			'admin:authenticate',
			'admin_api_key:manage',
			'bulk:update:guild_features',
			'bulk:update:user_flags',
		]);
		const key = await createAdminApiKey(harness, admin, 'Boost maintenance', ['bulk:update:guild_features'], null);
		await setUserACLs(harness, admin, ['admin:authenticate', 'bulk:update:user_flags']);
		const enqueue = vi.spyOn(getWorkerService(), 'addJob');
		await createBuilder(harness, key.token)
			.post('/admin/bulk-jobs')
			.body({task: 'backfill_guild_boosts'})
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		expect(enqueue).not.toHaveBeenCalled();
	});
});
