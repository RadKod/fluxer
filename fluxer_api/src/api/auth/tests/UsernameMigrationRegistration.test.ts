// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createAuthHarness,
	createTestAccount,
	createUniqueEmail,
	enableSso,
	setUserACLs,
} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {setCachedAccountIdentity} from '@app/api/instance/AccountIdentityModeCache';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {compileUsernameDictionary, UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import {AccountIdentityModes, TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('username selection registration', () => {
	let harness: ApiTestHarness;
	const claimSelf = vi.fn();
	const body = () => ({
		email: createUniqueEmail('selection'),
		username: 'chosenname',
		password: 'a-strong-password',
		date_of_birth: '2000-01-01',
		consent: true,
	});
	function mockPolicy(snapshot: unknown) {
		for (const method of ['readAuthoritative', 'readCached'] as const)
			vi.spyOn(UsernamePolicyService.prototype, method).mockResolvedValue(snapshot as never);
	}
	function realOwnership() {
		mockPolicy({
			policyRevision: 1,
			tiers: {1: 'locked', 2: 'locked', 3: 'locked'},
			migration: {state: 'selecting', epoch: 1, startedAt: new Date(), forcedAt: null},
			admission: {globalPerSecond: 200, paused: false},
			dictionary: compileUsernameDictionary(1, {uname_exact: [], uname_contains: [], uname_allow: []}),
		});
		return new UsernameOwnershipService({
			policy: new UsernamePolicyService(),
			clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
			admit: async () => true,
			propagate: async () => {},
			neutralDiscriminator: async () => 1234,
		});
	}
	async function requestLegacyTag(token: string, userId: string) {
		const user = await getUserRepository().findUniqueAssert(createUserID(BigInt(userId)));
		const response = await createBuilder<{id: string}>(harness, token)
			.post('/users/@me/relationships')
			.body({username: user.username, discriminator: user.discriminator})
			.execute();
		expect(response.id).toBe(userId);
		const found = await getUserRepository().findByUsernameDiscriminator(user.username, user.discriminator);
		expect(found?.id).toBe(user.id);
	}
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		vi.spyOn(InstanceConfigRepository.prototype, 'getAccountIdentity').mockResolvedValue({
			mode: AccountIdentityModes.EMAIL,
			tagStyle: TagStyles.NONE,
			usernameMigration: {state: 'selecting', epoch: 1, started_at: new Date().toISOString(), forced_at: null},
		});
		vi.spyOn(InstanceConfigRepository.prototype, 'getUsernameMigrationConfig').mockResolvedValue({
			state: 'selecting',
			epoch: 1,
			started_at: null,
			forced_at: null,
		});
		vi.spyOn(UsernamePolicyService.prototype, 'prevalidate').mockResolvedValue(null);
		claimSelf.mockReset().mockResolvedValue({ok: false, code: 'TAKEN'});
		setInjectedUsernameOwnershipService({claimSelf} as unknown as UsernameOwnershipService);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setInjectedUsernameOwnershipService(undefined);
		setCachedAccountIdentity(null);
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	it('requires an explicit name before creating an account', async () => {
		const {username: _username, ...data} = body();
		const response = await createBuilderWithoutAuth(harness).post('/auth/register').body(data).executeRaw();
		expect(response.response.status).toBe(400);
		expect(claimSelf).not.toHaveBeenCalled();
	});
	it('uses the cached migration state even when hosted identity configuration omits it', async () => {
		vi.mocked(InstanceConfigRepository.prototype.getAccountIdentity).mockResolvedValue({
			mode: AccountIdentityModes.EMAIL,
			tagStyle: TagStyles.RANDOM,
		});
		await createBuilderWithoutAuth(harness).post('/auth/register').body(body()).execute();
		expect(claimSelf).toHaveBeenCalled();
	});
	it('prevalidates the explicit name before creating an account', async () => {
		vi.mocked(UsernamePolicyService.prototype.prevalidate).mockResolvedValue('BLOCKED');
		const response = await createBuilderWithoutAuth(harness).post('/auth/register').body(body()).executeRaw();
		expect(response.response.status).toBe(400);
		expect(claimSelf).not.toHaveBeenCalled();
	});
	it('creates a legacy nonzero identity before claiming and keeps it unselected after a lost race', async () => {
		claimSelf.mockImplementation(async (id) => {
			const existing = await getUserRepository().findUniqueAssert(id);
			expect(existing.discriminator).toBeGreaterThan(0);
			expect(existing.toRow().username_state).toBeNull();
			return {ok: false, code: 'TAKEN'};
		});
		const response = await createBuilderWithoutAuth<{user_id: string}>(harness)
			.post('/auth/register')
			.body(body())
			.execute();
		expect(claimSelf).toHaveBeenCalledWith(createUserID(BigInt(response.user_id)), 'chosenname');
		const user = await getUserRepository().findUniqueAssert(createUserID(BigInt(response.user_id)));
		expect(user.discriminator).toBeGreaterThan(0);
		expect(user.toRow().username_state).toBeNull();
	});
	it('a real lost registration claim keeps its legacy tag reachable for friend requests', async () => {
		const requester = await createTestAccount(harness);
		const winner = await createTestAccount(harness);
		const ownership = realOwnership();
		expect(
			await ownership.adminAssign('chosenname', createUserID(BigInt(winner.userId)), {
				adminId: createUserID(BigInt(requester.userId)),
				reason: 'reserved winner',
			}),
		).toMatchObject({ok: true});
		setInjectedUsernameOwnershipService(ownership);
		const response = await createBuilderWithoutAuth<{user_id: string}>(harness)
			.post('/auth/register')
			.body(body())
			.execute();
		const user = await getUserRepository().findUniqueAssert(createUserID(BigInt(response.user_id)));
		expect(user.usernameState).toBeNull();
		expect(user.discriminator).toBeGreaterThan(0);
		expect((await ownership.repository.readClaim('chosenname'))?.user_id).toBe(createUserID(BigInt(winner.userId)));
		await requestLegacyTag(requester.token, response.user_id);
	});
	it('provisions SSO with a legacy nonzero identity and does not select the derived name', async () => {
		mockPolicy({
			policyRevision: 1,
			tiers: {1: 'locked', 2: 'locked', 3: 'locked'},
			migration: {state: 'selecting', epoch: 1, startedAt: new Date(), forcedAt: null},
			admission: {globalPerSecond: 200, paused: false},
			dictionary: compileUsernameDictionary(1, {uname_exact: [], uname_contains: [], uname_allow: []}),
		});
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			'admin:authenticate',
			'instance:config:update',
			'instance:config:view',
		]);
		await enableSso(harness, admin.token, {enforced: false});
		claimSelf.mockClear();
		setInjectedUsernameOwnershipService(realOwnership());
		const start = await createBuilderWithoutAuth<{state: string}>(harness)
			.post('/auth/sso/start')
			.body({redirect_to: '/me'})
			.execute();
		const result = await createBuilderWithoutAuth<{user_id: string}>(harness)
			.post('/auth/sso/complete')
			.body({code: createUniqueEmail('sso-selection'), state: start.state})
			.execute();
		const user = await getUserRepository().findUniqueAssert(createUserID(BigInt(result.user_id)));
		expect(user.discriminator).toBeGreaterThan(0);
		expect(user.usernameState).toBeNull();
		expect(claimSelf).not.toHaveBeenCalled();
		await requestLegacyTag(admin.token, result.user_id);
	});
	it('uses claim availability for unauthenticated selection without exposing its owner', async () => {
		vi.mocked(InstanceConfigRepository.prototype.getAccountIdentity).mockResolvedValue({
			mode: AccountIdentityModes.EMAIL,
			tagStyle: TagStyles.RANDOM,
		});
		setCachedAccountIdentity({
			mode: AccountIdentityModes.EMAIL,
			tagStyle: TagStyles.NONE,
			usernameMigration: {state: 'selecting', epoch: 1, started_at: null, forced_at: null},
		});
		mockPolicy({
			migration: {state: 'selecting'},
			tiers: {1: 'public', 2: 'public', 3: 'public'},
			dictionary: {contains: () => false},
		} as never);
		setInjectedUsernameOwnershipService({
			readClaimForAvailability: vi.fn().mockResolvedValue({state: 'held', user_id: 999n, blocked_until: null}),
		} as unknown as UsernameOwnershipService);
		const result = await createBuilderWithoutAuth(harness)
			.get('/auth/username-availability?username=chosenname')
			.execute();
		expect(result).toEqual({available: false, reason: 'RESERVED'});
	});
});
