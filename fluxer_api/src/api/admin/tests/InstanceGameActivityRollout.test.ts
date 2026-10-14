// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {NatsConfigPublisher} from '@app/api/instance/NatsConfigPublisher';
import {InstanceConfigWriteRaceExecutor} from '@app/api/instance/tests/InstanceConfigWriteRaceExecutor';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import type {InstanceConfigResponse} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const CONFIG_KEY = 'gateway_rollout_config';

describe('instance game activity rollout', () => {
	let harness: ApiTestHarness;
	let executor: InstanceConfigWriteRaceExecutor;

	beforeAll(async () => {
		harness = await createApiTestHarness();
		executor = new InstanceConfigWriteRaceExecutor(new InMemoryCassandraQueryExecutor());
		setCassandraQueryExecutorForTesting(executor);
	});
	beforeEach(async () => {
		await harness.reset();
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
	const patch = (admin: TestAccount, gateway_rollout: Record<string, unknown>) =>
		createBuilder<InstanceConfigResponse>(harness, admin.token).patch('/admin/instance/config').body({gateway_rollout});
	const spyPublish = () => vi.spyOn(NatsConfigPublisher.prototype, 'publish').mockResolvedValue(undefined);

	it('legacy_config_is_disabled', async () => {
		await executor.writeDirectly(CONFIG_KEY, JSON.stringify({session_rollout_percentage: 25}));
		expect(await getInstanceConfigRepository().getGatewayRolloutConfig()).toMatchObject({
			game_activity_enabled: false,
			game_activity_epoch: 0,
		});
	});

	it('authoritative_read_does_not_extend_a_stale_cache', async () => {
		const reader = new InstanceConfigRepository(new MockKVProvider());
		try {
			await getInstanceConfigRepository().updateGatewayRolloutConfig((current) => current);
			expect(JSON.parse((await reader.getConfig(CONFIG_KEY)) ?? '{}')).toMatchObject({
				game_activity_enabled: false,
				game_activity_epoch: 0,
			});
			expect(await reader.getGatewayRolloutConfig()).toMatchObject({
				game_activity_enabled: false,
				game_activity_epoch: 0,
			});
			await getInstanceConfigRepository().updateGatewayRolloutConfig((current) => ({
				...current,
				max_connections: 18000,
				game_activity_enabled: true,
			}));
			expect(JSON.parse((await reader.getConfig(CONFIG_KEY)) ?? '{}')).toMatchObject({
				game_activity_enabled: false,
				game_activity_epoch: 0,
			});
			expect(await reader.getGatewayRolloutConfig()).toMatchObject({
				max_connections: 18000,
				game_activity_enabled: true,
				game_activity_epoch: 1,
			});
			expect(await reader.getGatewayRolloutConfig({authoritative: true})).toMatchObject({
				max_connections: 18000,
				game_activity_enabled: true,
				game_activity_epoch: 1,
			});
			expect(JSON.parse((await reader.getConfig(CONFIG_KEY)) ?? '{}')).toMatchObject({
				game_activity_enabled: false,
				game_activity_epoch: 0,
			});
		} finally {
			await reader.shutdown();
		}
	});

	it('epoch_is_server_owned_and_increments_on_transition', async () => {
		const publish = spyPublish();
		const admin = await createAdmin();
		await patch(admin, {game_activity_epoch: 99}).expect(HTTP_STATUS.BAD_REQUEST).execute();
		expect(publish).not.toHaveBeenCalled();
		for (const [enabled, epoch] of [
			[true, 1],
			[true, 1],
			[false, 2],
			[true, 3],
		] as const) {
			const response = await patch(admin, {game_activity_enabled: enabled}).execute();
			expect(response.gateway_rollout).toMatchObject({game_activity_enabled: enabled, game_activity_epoch: epoch});
		}
	});

	it('publish_and_authoritative_read_match', async () => {
		const publish = spyPublish();
		const admin = await createAdmin();
		const response = await patch(admin, {game_activity_enabled: true}).execute();
		const authoritative = await getInstanceConfigRepository().getGatewayRolloutConfig();
		expect(authoritative).toMatchObject({game_activity_enabled: true, game_activity_epoch: 1});
		expect(response.gateway_rollout).toEqual(authoritative);
		expect(publish).toHaveBeenCalledWith('config.gateway.rollout', 'gateway_rollout_config', authoritative);
		expect(JSON.parse((await executor.readDirectly(CONFIG_KEY)) ?? 'null')).toEqual(authoritative);
	});
	it('connection cap patches preserve game activity and reject server-owned epochs', async () => {
		const publish = spyPublish();
		const admin = await createAdmin();
		const enabled = await patch(admin, {max_connections: 18000, game_activity_enabled: true}).execute();
		expect(enabled.gateway_rollout).toMatchObject({
			max_connections: 18000,
			game_activity_enabled: true,
			game_activity_epoch: 1,
		});
		const capacity = await patch(admin, {max_connections: 200000}).execute();
		expect(capacity.gateway_rollout).toMatchObject({
			max_connections: 200000,
			game_activity_enabled: true,
			game_activity_epoch: 1,
		});
		expect(publish).toHaveBeenLastCalledWith(
			'config.gateway.rollout',
			'gateway_rollout_config',
			capacity.gateway_rollout,
		);
		publish.mockClear();
		await patch(admin, {max_connections: 1, game_activity_epoch: 99}).expect(HTTP_STATUS.BAD_REQUEST).execute();
		expect(publish).not.toHaveBeenCalled();
		expect(await getInstanceConfigRepository().getGatewayRolloutConfig()).toEqual(capacity.gateway_rollout);
	});

	it('concurrent_patch_preserves_other_fields', async () => {
		spyPublish();
		const admin = await createAdmin();
		await patch(admin, {session_rollout_percentage: 10}).execute();
		executor.watch(CONFIG_KEY);
		executor.pauseWritesUntil(2);
		await Promise.all([
			patch(admin, {game_activity_enabled: true}).execute(),
			patch(admin, {session_rollout_percentage: 70, max_connections: 18000}).execute(),
		]);
		const authoritative = await getInstanceConfigRepository().getGatewayRolloutConfig();
		expect(authoritative).toMatchObject({
			game_activity_enabled: true,
			game_activity_epoch: 1,
			session_rollout_percentage: 70,
			max_connections: 18000,
		});
		expect(executor.events).toContain('write rejected');
	});

	it('repository_ignores_caller_epoch_and_serializes_competing_transitions', async () => {
		const repository = getInstanceConfigRepository();
		executor.watch(CONFIG_KEY);
		executor.pauseWritesUntil(2);
		await Promise.all(
			[1, 2].map(() =>
				repository.updateGatewayRolloutConfig((current) => ({
					...current,
					game_activity_enabled: true,
					game_activity_epoch: 999,
				})),
			),
		);
		expect(await repository.getGatewayRolloutConfig()).toMatchObject({
			game_activity_enabled: true,
			game_activity_epoch: 1,
		});
	});
});
