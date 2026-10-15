// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import type {GatewayRpcTransport} from '@app/api/infrastructure/GatewayRpcClient';
import {GatewayRpcClient} from '@app/api/infrastructure/GatewayRpcClient';
import {GatewayService} from '@app/api/infrastructure/GatewayService';
import {getInstanceConfigRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {UserSettings} from '@app/api/models/UserSettings';
import {createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {GameActivityPolicyService, gameActivityPolicyState} from '@app/api/user/services/GameActivityPolicyService';
import type {RpcResponse} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {RpcRequest} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('game activity RPC bootstrap boundary', () => {
	afterEach(async () => {
		vi.useRealTimers();
		await GatewayRpcClient.resetForTests();
	});
	it.todo('unknown_owner_denies_until_fresh_bootstrap: requires gateway owner integration');
	it.todo('late_snapshot_nonce_is_rejected: requires gateway owner integration');
	it('session_bootstrap_and_grant_rpc_carry_current_policy_and_nonce', async () => {
		const harness = await createApiTestHarness();
		try {
			const account = await createTestAccount(harness, {dateOfBirth: '2000-01-01'});
			const repository = getUserRepository();
			await repository.patchSettings(createUserID(BigInt(account.userId)), {
				game_activity_visibility: 'friends',
				game_activity_visibility_source: 'user',
				profile_privacy: 101,
			});
			const session = await createBuilder<RpcResponse>(harness, '')
				.post('/test/rpc-session-init')
				.body({
					type: 'session',
					token: account.token,
					version: 1,
					ip: '127.0.0.1',
					game_activity_request_nonce: 'new-session',
				})
				.expect(200)
				.execute();
			expect(session.type).toBe('session');
			if (session.type !== 'session') throw new Error('Expected session response');
			expect(session.data.game_activity_request_nonce).toBe('new-session');
			expect(session.data.game_activity_policy).toEqual({
				policy_revision: '1',
				visibility: 'friends',
				eligible_16_plus: true,
				effective_profile_audience: 'only_me',
			});
			const grants = await createBuilder<RpcResponse>(harness, '')
				.post('/test/rpc-session-init')
				.body({
					type: 'get_game_activity_grants',
					viewer_id: account.userId,
					targets: [account.userId],
					request_nonce: 'fresh-grants',
				})
				.expect(200)
				.execute();
			expect(grants.type).toBe('get_game_activity_grants');
			if (grants.type !== 'get_game_activity_grants') throw new Error('Expected grants response');
			expect(grants.data).toMatchObject({
				request_nonce: 'fresh-grants',
				grants: [
					{owner_id: account.userId, policy_revision: '1', effective_profile_audience: 'only_me', allowed: false},
				],
			});
		} finally {
			await harness.shutdown();
		}
	});
	it('session_bootstrap_rereads_authoritative_policy_after_stale_startup_snapshot', async () => {
		const harness = await createApiTestHarness();
		let read: ReturnType<typeof vi.spyOn> | undefined;
		try {
			const account = await createTestAccount(harness, {dateOfBirth: '2000-01-01'});
			const userId = createUserID(BigInt(account.userId));
			const repository = getUserRepository();
			const fresh = await repository.patchSettings(userId, {
				game_activity_visibility: 'off',
				game_activity_visibility_source: 'user',
				profile_privacy: 101,
			});
			const stale = new UserSettings({
				...fresh.toRow(),
				game_activity_visibility: 'friends',
				game_activity_policy_revision: 0n,
				profile_privacy: 2,
			});
			const originalRead = repository.findSettings.bind(repository);
			const modeRead = vi
				.spyOn(repository, 'findSettings')
				.mockImplementation(async (id, options) =>
					id === userId && !options?.authoritative ? stale : originalRead(id, options),
				);
			read = modeRead;
			const session = await createBuilder<RpcResponse>(harness, '')
				.post('/test/rpc-session-init')
				.body({
					type: 'session',
					token: account.token,
					version: 1,
					ip: '127.0.0.1',
					game_activity_request_nonce: 'fresh-owner',
				})
				.expect(200)
				.execute();
			if (session.type !== 'session') throw new Error('Expected session response');
			expect(session.data.game_activity_policy).toEqual({
				visibility: 'off',
				policy_revision: fresh.gameActivityPolicyRevision.toString(),
				eligible_16_plus: true,
				effective_profile_audience: 'only_me',
			});
			expect(modeRead).toHaveBeenCalledWith(userId, {authoritative: true});
			expect(session.data.user_settings).toMatchObject({
				game_activity_visibility: 'off',
				game_activity_policy_revision: fresh.gameActivityPolicyRevision.toString(),
			});
		} finally {
			read?.mockRestore();
			await harness.shutdown();
		}
	});
	it('missing_owner_or_settings_defaults_deny', async () => {
		const users = {
			findUnique: vi.fn(async () => null),
			findSettings: vi.fn(async () => null),
			getRelationship: vi.fn(async () => null),
			getIncomingRelationship: vi.fn(async () => null),
		};
		const service = new GameActivityPolicyService({users: users as never, gateway: new NoopGatewayService()});
		const result = await service.getGrants(createUserID(1n), [createUserID(2n)], 'owner-bootstrap-nonce');
		expect(result).toMatchObject({
			request_nonce: 'owner-bootstrap-nonce',
			grants: [{allowed: false, eligible_16_plus: false, policy_revision: '0'}],
		});
		expect(gameActivityPolicyState({isBot: false, isSystem: false, dateOfBirth: null}, null)).toMatchObject({
			visibility: 'off',
			eligible_16_plus: false,
			policy_revision: '0',
		});
	});
	it('rollout_rpc_reads_authoritative_configuration', async () => {
		const harness = await createApiTestHarness();
		const read = vi.spyOn(getInstanceConfigRepository(), 'getGatewayRolloutConfig');
		try {
			const result = await createBuilder<RpcResponse>(harness, '')
				.post('/test/rpc-session-init')
				.body({type: 'get_gateway_rollout_config'})
				.expect(200)
				.execute();
			expect(result.type).toBe('get_gateway_rollout_config');
			expect(read).toHaveBeenCalledWith({authoritative: true});
		} finally {
			read.mockRestore();
			await harness.shutdown();
		}
	});
	it('grant_requests_require_nonce_and_reject_permission_injection', () => {
		// The API requires a nonce; accepting only the active nonce belongs to the presence owner.
		expect(RpcRequest.safeParse({type: 'get_game_activity_grants', targets: ['2'], viewer_id: '1'}).success).toBe(
			false,
		);
		expect(
			RpcRequest.safeParse({
				type: 'get_game_activity_grants',
				targets: ['2'],
				viewer_id: '1',
				request_nonce: 'current',
				allowed: true,
			}).success,
		).toBe(false);
	});
	it.each(['request_id', 'policy_revision', 'phase'])('rejects_mismatched_policy_ack_%s', async (field) => {
		const request = {
			user_id: '2',
			owner_epoch: 'current-owner',
			request_id: 'current-request',
			policy_revision: '4',
			phase: 'apply' as const,
			visibility: 'off' as const,
			eligible_16_plus: true,
			effective_profile_audience: 'close' as const,
		};
		const ack = {
			owner_epoch: request.owner_epoch,
			request_id: request.request_id,
			policy_revision: request.policy_revision,
			phase: request.phase,
			revoked_sessions: 1,
			[field]: field === 'phase' ? 'fence' : field === 'policy_revision' ? '3' : 'old',
		};
		GatewayRpcClient.createForTests({
			call: vi.fn(async () => ack),
			destroy: vi.fn(async () => {}),
		} as unknown as GatewayRpcTransport);
		await expect(new GatewayService().gameActivityPolicy(request)).rejects.toThrow();
	});
	it.each(['fence', 'apply'] as const)('policy_ack_epoch_is_phase_correct_for_%s', async (phase) => {
		const request = {
			user_id: '2',
			owner_epoch: 'previous-owner',
			request_id: 'current-request',
			policy_revision: '4',
			phase,
			visibility: 'off' as const,
			eligible_16_plus: true,
			effective_profile_audience: 'close' as const,
		};
		const ack = {
			owner_epoch: 'replacement-owner',
			request_id: request.request_id,
			policy_revision: request.policy_revision,
			phase,
			revoked_sessions: 1,
		};
		GatewayRpcClient.createForTests({
			call: vi.fn(async () => ack),
			destroy: vi.fn(async () => {}),
		} as unknown as GatewayRpcTransport);
		const result = new GatewayService().gameActivityPolicy(request);
		if (phase === 'fence') await expect(result).rejects.toThrow();
		else await expect(result).resolves.toEqual(ack);
	});
	it('control_ack_timeout_is_five_seconds_and_never_cast_fallback', async () => {
		vi.useFakeTimers();
		const call = vi.fn(() => new Promise(() => {}));
		GatewayRpcClient.createForTests({call, destroy: vi.fn(async () => {})} as unknown as GatewayRpcTransport);
		const pending = new GatewayService().gameActivityPairPolicy({
			owner_id: '1',
			viewer_id: '2',
			phase: 'fence',
			request_id: 'pending',
		});
		const rejection = expect(pending).rejects.toThrow();
		await vi.advanceTimersByTimeAsync(5000);
		await rejection;
		expect(call).toHaveBeenCalledTimes(1);
	});
});
