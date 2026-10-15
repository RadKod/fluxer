// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {GatewayRpcClient} from '@app/api/infrastructure/GatewayRpcClient';
import {GatewayService} from '@app/api/infrastructure/GatewayService';
import {getGatewayService} from '@app/api/middleware/ServiceRegistry';
import type {User} from '@app/api/models/User';
import type {UserSettings} from '@app/api/models/UserSettings';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {GameActivityPolicyService} from '@app/api/user/services/GameActivityPolicyService';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {
	GameActivityPairPolicyRequest,
	GameActivityPolicyRequest,
	type RpcResponse,
} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const viewerId = createUserID(1n);
const ownerId = createUserID(2n);

function grantFixture(settings: Partial<UserSettings>) {
	const users = {
		findUnique: vi.fn(async (id) => ({id, isBot: false, isSystem: false, dateOfBirth: '2000-01-01'}) as User),
		findSettings: vi.fn(
			async (_id: UserID, _options?: {authoritative?: boolean}) =>
				({gameActivityPolicyRevision: 3n, profilePrivacy: 2, ...settings}) as UserSettings,
		),
		getRelationship: vi.fn(async (_source, _target, type) => (type === RelationshipTypes.FRIEND ? {} : null)),
		getIncomingRelationship: vi.fn(async () => null),
	};
	return {users, service: new GameActivityPolicyService({users: users as never, gateway: new NoopGatewayService()})};
}

const grant = async (service: GameActivityPolicyService) =>
	(await service.getGrants(viewerId, [ownerId], 'nonce')).grants[0];

describe('everyone visibility grants', () => {
	it.each([
		{gameActivityVisibility: 'everyone', gameActivityVisibilitySource: 'user'},
		{gameActivityVisibility: null, gameActivityVisibilitySource: 'default'},
	] as const)('everyone_friend_is_allowed_%j', async (settings) => {
		const {service} = grantFixture(settings);
		expect(await grant(service)).toMatchObject({allowed: true, friend: true, eligible_16_plus: true});
	});

	it('legacy_api_off_with_default_source_denies_a_friend_grant', async () => {
		const {service} = grantFixture({gameActivityVisibility: 'off', gameActivityVisibilitySource: 'default'});
		expect(await grant(service)).toMatchObject({allowed: false, friend: true, eligible_16_plus: true});
	});

	it('everyone_only_me_is_denied', async () => {
		const {service} = grantFixture({
			gameActivityVisibility: 'everyone',
			gameActivityVisibilitySource: 'user',
			profilePrivacy: 101,
		});
		expect((await grant(service)).allowed).toBe(false);
	});

	it('everyone_block_in_either_direction_is_denied', async () => {
		const {users, service} = grantFixture({gameActivityVisibility: 'everyone', gameActivityVisibilitySource: 'user'});
		users.getIncomingRelationship.mockResolvedValue({} as never);
		expect((await grant(service)).allowed).toBe(false);
		users.getIncomingRelationship.mockResolvedValue(null);
		users.getRelationship.mockImplementation(async (_source, _target, type) =>
			type === RelationshipTypes.FRIEND || type === RelationshipTypes.BLOCKED ? {} : null,
		);
		expect((await grant(service)).allowed).toBe(false);
	});

	it('everyone_under_fifteen_is_denied', async () => {
		vi.useFakeTimers({now: new Date('2026-10-06T12:00:00Z'), toFake: ['Date']});
		try {
			const {users, service} = grantFixture({gameActivityVisibility: 'everyone', gameActivityVisibilitySource: 'user'});
			users.findUnique.mockImplementation(
				async (id) =>
					({
						id,
						isBot: false,
						isSystem: false,
						dateOfBirth: id === ownerId ? '2011-10-07' : '2000-01-01',
					}) as User,
			);
			expect(await grant(service)).toMatchObject({allowed: false, eligible_16_plus: false});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('game activity RPC contract', () => {
	afterEach(async () => {
		await GatewayRpcClient.resetForTests();
	});

	it('policy_requests_accept_everyone', () => {
		expect(
			GameActivityPolicyRequest.safeParse({
				user_id: '2',
				owner_epoch: 'owner',
				request_id: 'request',
				phase: 'apply',
				policy_revision: '1',
				visibility: 'everyone',
				eligible_16_plus: true,
				effective_profile_audience: 'guilds',
			}).success,
		).toBe(true);
	});

	it('pair_apply_accepts_blocked_and_fence_does_not', () => {
		const apply = {
			owner_id: '1',
			viewer_id: '2',
			phase: 'apply',
			request_id: 'request',
			owner_epoch: 'owner',
			pair_generation: '1',
		} as const;
		expect(GameActivityPairPolicyRequest.parse({...apply, blocked: true})).toMatchObject({blocked: true});
		expect(GameActivityPairPolicyRequest.parse({...apply, blocked: false})).toMatchObject({blocked: false});
		expect(GameActivityPairPolicyRequest.safeParse(apply).success).toBe(true);
		expect(
			GameActivityPairPolicyRequest.safeParse({
				owner_id: '1',
				viewer_id: '2',
				phase: 'fence',
				request_id: 'request',
				blocked: true,
			}).success,
		).toBe(false);
	});

	it('gateway_service_forwards_blocked_on_pair_apply', async () => {
		const call = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
			owner_epoch: 'owner',
			pair_generation: '1',
			request_id: params.request_id,
			phase: 'apply',
		}));
		GatewayRpcClient.createForTests({call, async destroy() {}});
		await new GatewayService().gameActivityPairPolicy({
			owner_id: '1',
			viewer_id: '2',
			phase: 'apply',
			request_id: 'request',
			owner_epoch: 'owner',
			pair_generation: '1',
			blocked: true,
		});
		expect(call).toHaveBeenCalledWith('presence.game_activity_pair_policy', expect.objectContaining({blocked: true}));
	});
});

describe('game activity pair apply carries the block state', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	function recordApplies() {
		const applies: Array<GameActivityPairPolicyRequest> = [];
		const gateway = getGatewayService();
		const original = gateway.gameActivityPairPolicy.bind(gateway);
		vi.spyOn(gateway, 'gameActivityPairPolicy').mockImplementation(async (request) => {
			if (request.phase === 'apply') applies.push(request);
			return original(request);
		});
		return applies;
	}

	async function relationship(token: string, targetId: string, method: 'put' | 'delete') {
		const builder = createBuilder(harness, token);
		if (method === 'put')
			await builder.put(`/users/@me/relationships/${targetId}`).body({type: 2}).expect(200).execute();
		else await builder.delete(`/users/@me/relationships/${targetId}`).expect(204).execute();
	}

	const pairs = (a: string, b: string) => [`${a}:${b}`, `${b}:${a}`].sort();

	it('block_then_unblock_sets_blocked_on_both_directions', async () => {
		const owner = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const applies = recordApplies();
		await relationship(owner.token, viewer.userId, 'put');
		expect(applies.map((request) => `${request.owner_id}:${request.viewer_id}`).sort()).toEqual(
			pairs(owner.userId, viewer.userId),
		);
		expect(applies.every((request) => request.phase === 'apply' && request.blocked === true)).toBe(true);
		applies.length = 0;
		await relationship(owner.token, viewer.userId, 'delete');
		expect(applies).toHaveLength(2);
		expect(applies.every((request) => request.phase === 'apply' && request.blocked === false)).toBe(true);
	});

	it('unblock_keeps_blocked_while_the_other_side_still_blocks', async () => {
		const owner = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await relationship(viewer.token, owner.userId, 'put');
		await relationship(owner.token, viewer.userId, 'put');
		const applies = recordApplies();
		await relationship(owner.token, viewer.userId, 'delete');
		expect(applies).toHaveLength(2);
		expect(applies.every((request) => request.phase === 'apply' && request.blocked === true)).toBe(true);
	});
});

describe('session start policy', () => {
	it('default_source_reaches_the_gateway_as_everyone', async () => {
		const harness = await createApiTestHarness();
		try {
			const account = await createTestAccount(harness, {dateOfBirth: '2000-01-01'});
			const session = await createBuilder<RpcResponse>(harness, '')
				.post('/test/rpc-session-init')
				.body({
					type: 'session',
					token: account.token,
					version: 1,
					ip: '127.0.0.1',
					game_activity_request_nonce: 'default-source',
				})
				.expect(200)
				.execute();
			if (session.type !== 'session') throw new Error('Expected session response');
			expect(session.data.game_activity_policy).toMatchObject({visibility: 'everyone', eligible_16_plus: true});
			expect(session.data.user_settings).toMatchObject({
				game_activity_visibility: 'everyone',
				game_activity_eligible: true,
				game_activity_default_pending: false,
			});
		} finally {
			await harness.shutdown();
		}
	});
});
