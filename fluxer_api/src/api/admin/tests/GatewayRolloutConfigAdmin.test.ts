// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditLog} from '@app/api/admin/AdminRepository';
import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {getAdminRepository, getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import type {InstanceConfigResponse} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import type {NatsConnection} from '@nats-io/transport-node';
import {NatsConnectionManager} from '@pkgs/nats/src/NatsConnectionManager';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('gateway rollout connection cap admin updates', () => {
	let harness: ApiTestHarness;
	const publish = vi.fn<(subject: string, data: Uint8Array) => void>();
	const flush = vi.fn<() => Promise<void>>();

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		await getInstanceConfigRepository().setAppPublicConfig({setup: {configured: true}});
		publish.mockReset();
		flush.mockReset().mockResolvedValue(undefined);
		vi.spyOn(NatsConnectionManager.prototype, 'isClosed').mockReturnValue(false);
		vi.spyOn(NatsConnectionManager.prototype, 'getConnection').mockReturnValue({
			publish,
			flush,
		} as unknown as NatsConnection);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	const createAdmin = async (): Promise<TestAccount> =>
		setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);

	const patchRollout = (admin: TestAccount, patch: Record<string, unknown>) =>
		createBuilder<InstanceConfigResponse>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({gateway_rollout: patch});

	async function listUpdateAudits(): Promise<Array<AdminAuditLog>> {
		return (await getAdminRepository().listAllAuditLogsPaginated(100000)).filter(
			(log) => log.action === 'update_instance_config',
		);
	}

	it.each([1, 200000])('persists, publishes and audits an authorized cap of %s', async (cap) => {
		const admin = await createAdmin();
		const response = await patchRollout(admin, {max_connections: cap})
			.header('X-Audit-Log-Reason', 'Update gateway connection capacity')
			.execute();

		expect(response.gateway_rollout.max_connections).toBe(cap);
		expect(await getInstanceConfigRepository().getGatewayRolloutConfig()).toEqual(response.gateway_rollout);
		expect(publish).toHaveBeenCalledTimes(1);
		const [subject, payload] = publish.mock.calls[0];
		expect(subject).toBe('config.gateway.rollout');
		expect(JSON.parse(new TextDecoder().decode(payload))).toEqual({
			type: 'gateway_rollout_config',
			config: response.gateway_rollout,
		});
		expect(flush).toHaveBeenCalledTimes(1);
		const audits = await listUpdateAudits();
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			adminUserId: BigInt(admin.userId),
			targetType: 'instance_config',
			targetId: 0n,
			auditLogReason: 'Update gateway connection capacity',
		});
		expect(Object.fromEntries(audits[0].metadata)).toMatchObject({sections: 'gateway_rollout'});
	});

	it('preserves an omitted cap and publishes zero when returning to the environment cap', async () => {
		const admin = await createAdmin();
		await patchRollout(admin, {max_connections: 18000}).execute();
		const otherUpdate = await patchRollout(admin, {rpc_request_timeout_ms: 5000}).execute();
		expect(otherUpdate.gateway_rollout.max_connections).toBe(18000);
		const reset = await patchRollout(admin, {max_connections: 0}).execute();
		expect(reset.gateway_rollout).toMatchObject({max_connections: 0, rpc_request_timeout_ms: 5000});
		expect((await getInstanceConfigRepository().getGatewayRolloutConfig()).max_connections).toBe(0);
		const [, payload] = publish.mock.calls.at(-1)!;
		expect(JSON.parse(new TextDecoder().decode(payload)).config.max_connections).toBe(0);
	});

	it.each([-1, 200001, 1.5, '18000', null])(
		'rejects invalid cap %s without writing, publishing or auditing',
		async (cap) => {
			const admin = await createAdmin();
			const before = await getInstanceConfigRepository().getGatewayRolloutConfig();
			await patchRollout(admin, {max_connections: cap, rpc_request_timeout_ms: 5000})
				.expect(HTTP_STATUS.BAD_REQUEST)
				.execute();
			expect(await getInstanceConfigRepository().getGatewayRolloutConfig()).toEqual(before);
			expect(publish).not.toHaveBeenCalled();
			expect(await listUpdateAudits()).toHaveLength(0);
		},
	);

	it('requires the existing instance config update ACL without writing, publishing or auditing', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
		]);
		const before = await getInstanceConfigRepository().getGatewayRolloutConfig();
		await patchRollout(admin, {max_connections: 18000}).expect(HTTP_STATUS.FORBIDDEN).execute();
		expect(await getInstanceConfigRepository().getGatewayRolloutConfig()).toEqual(before);
		expect(publish).not.toHaveBeenCalled();
		expect(await listUpdateAudits()).toHaveLength(0);
	});
});
