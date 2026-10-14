// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {getAdminRepository, getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('username policy admin API', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	const admin = async (acls: Array<string>) =>
		setUserACLs(harness, await createTestAccount(harness), [AdminACLs.AUTHENTICATE, ...acls]);
	it('atomically opens all three tiers with a single revision and records the reason', async () => {
		const actor = await admin([AdminACLs.INSTANCE_CONFIG_UPDATE]);
		const response = await createBuilder(harness, actor.token)
			.patch('/admin/instance/username-policy')
			.header('X-Audit-Log-Reason', 'open tiers')
			.body({tiers: {'1': 'public', '2': 'public', '3': 'public'}})
			.execute();
		expect(response).toMatchObject({tiers: {'1': 'public', '2': 'public', '3': 'public'}, revision: 1});
		const audits = await getAdminRepository().listAllAuditLogsPaginated(1000);
		expect(audits.find((audit) => audit.action === 'update_username_policy')?.auditLogReason).toBe('open tiers');
	});
	it('rejects a partial tier request without changing the stored revision', async () => {
		const actor = await admin([AdminACLs.INSTANCE_CONFIG_UPDATE]);
		await createBuilder(harness, actor.token)
			.patch('/admin/instance/username-policy')
			.header('X-Audit-Log-Reason', 'partial')
			.body({tiers: {'1': 'public'}})
			.expect(400)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).revision).toBe(0);
	});
	it('rejects a request without its specific ACL', async () => {
		const actor = await admin([AdminACLs.INSTANCE_CONFIG_VIEW]);
		await createBuilder(harness, actor.token)
			.patch('/admin/instance/username-policy')
			.header('X-Audit-Log-Reason', 'forbidden')
			.body({tiers: {'1': 'public', '2': 'public', '3': 'public'}})
			.expect(403)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).revision).toBe(0);
	});
	it('requires a reason before writing or auditing', async () => {
		const actor = await admin([AdminACLs.INSTANCE_CONFIG_UPDATE]);
		await createBuilder(harness, actor.token)
			.patch('/admin/instance/username-policy')
			.body({tiers: {'1': 'public', '2': 'public', '3': 'public'}})
			.expect(400)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).revision).toBe(0);
		expect(
			(await getAdminRepository().listAllAuditLogsPaginated(1000)).filter(
				(audit) => audit.action === 'update_username_policy',
			),
		).toEqual([]);
	});
});
