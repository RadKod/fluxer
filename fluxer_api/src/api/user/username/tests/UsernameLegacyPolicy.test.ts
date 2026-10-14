// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createAuthHarness,
	createTestAccount,
	createUniqueEmail,
	enableSso,
	setUserACLs,
} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {executeConditional} from '@app/api/database/CassandraQueryExecution';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {UsernameEntitlements} from '@app/api/Tables';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {
	compileUsernameDictionary,
	UsernamePolicyService,
	type UsernamePolicySnapshot,
	UsernameUnavailableError,
} from '@app/api/user/username/UsernamePolicyService';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const published: UsernamePolicySnapshot = {
	policyRevision: 1,
	tiers: {1: 'locked', 2: 'locked', 3: 'locked'},
	migration: {state: 'legacy', epoch: 0, startedAt: null, forcedAt: null},
	admission: {globalPerSecond: 0, paused: true},
	dictionary: compileUsernameDictionary(1, {uname_exact: ['badpolicy'], uname_contains: [], uname_allow: []}),
};

describe('published username policy on legacy human allocations', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => harness.shutdown());
	it.each(['a', 'badpolicy'])(
		'keeps upstream registration and a nonzero human tag before publication for %s',
		async (username) => {
			const response = await createBuilderWithoutAuth<{user_id: string}>(harness)
				.post('/auth/register')
				.body({email: createUniqueEmail('policy-legacy'), username, date_of_birth: '2000-01-01', consent: true})
				.execute();
			const user = await getUserRepository().findUniqueAssert(createUserID(BigInt(response.user_id)));
			expect(user.username).toBe(username);
			expect(user.discriminator).toBeGreaterThan(0);
		},
	);

	it.each([false, true])(
		'rejects a filtered registration name before creating an account (derived=%s)',
		async (derived) => {
			vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockResolvedValue(published);
			const email = createUniqueEmail('policy');
			const response = await createBuilderWithoutAuth(harness)
				.post('/auth/register')
				.body({
					email,
					...(derived ? {global_name: 'badpolicy'} : {username: 'badpolicy'}),
					password: 'a-strong-password',
					date_of_birth: '2000-01-01',
					consent: true,
				})
				.executeRaw();
			expect(response.response.status).toBe(400);
			expect(response.json).toMatchObject({code: 'USERNAME_BLOCKED'});
			expect(await getUserRepository().findByEmail(email)).toBeNull();
		},
	);
	it('does not treat a new registration as entitled to a locked short name', async () => {
		vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockResolvedValue(published);
		const response = await createBuilderWithoutAuth(harness)
			.post('/auth/register')
			.body({email: createUniqueEmail('policy'), username: 'a', date_of_birth: '2000-01-01', consent: true})
			.executeRaw();
		expect(response.response.status).toBe(400);
		expect(response.json).toMatchObject({code: 'USERNAME_REQUIRES_ENTITLEMENT'});
	});
	it('fails closed before registration if the published policy cannot be read', async () => {
		vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockRejectedValue(new UsernameUnavailableError());
		const response = await createBuilderWithoutAuth(harness)
			.post('/auth/register')
			.body({email: createUniqueEmail('policy'), username: 'ordinary', date_of_birth: '2000-01-01', consent: true})
			.executeRaw();
		expect(response.response.status).toBe(503);
		expect(response.json).toMatchObject({code: 'USERNAME_UNAVAILABLE'});
	});
	it('rejects a filtered legacy rename and preserves the stored identity', async () => {
		const account = await createTestAccount(harness);
		const id = createUserID(BigInt(account.userId));
		const before = await getUserRepository().findUniqueAssert(id);
		vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockResolvedValue(published);
		const response = await createBuilder(harness, account.token)
			.patch('/users/@me')
			.body({username: 'badpolicy', password: account.password})
			.executeRaw();
		expect(response.response.status).toBe(400);
		expect(response.json).toMatchObject({code: 'USERNAME_BLOCKED'});
		const after = await getUserRepository().findUniqueAssert(id);
		expect([after.username, after.discriminator]).toEqual([before.username, before.discriminator]);
	});
	it('fails closed on a published policy read failure before a legacy identity write', async () => {
		const account = await createTestAccount(harness);
		vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockRejectedValue(new UsernameUnavailableError());
		const response = await createBuilder(harness, account.token)
			.patch('/users/@me')
			.body({username: 'ordinary', password: account.password})
			.executeRaw();
		expect(response.response.status).toBe(503);
		expect(response.json).toMatchObject({code: 'USERNAME_UNAVAILABLE'});
	});
	it.each(['absent', 'other_name', 'revoked', 'matching'] as const)(
		'checks the exact unrevoked entitlement for a short legacy rename (%s)',
		async (grant) => {
			const account = await createTestAccount(harness);
			const id = createUserID(BigInt(account.userId));
			if (grant !== 'absent') {
				await executeConditional(
					UsernameEntitlements.insertIfNotExists({
						user_id: id,
						username: grant === 'other_name' ? 'b' : 'a',
						source: 'admin',
						grant_ref: 'policy-grant',
						bound_gen: null,
						created_at: new Date(),
						revoked_at: grant === 'revoked' ? new Date() : null,
						version: 1,
					}),
				);
			}
			vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockResolvedValue(published);
			const response = await createBuilder(harness, account.token)
				.patch('/users/@me')
				.body({username: 'a', password: account.password})
				.executeRaw();
			if (grant === 'matching') {
				expect(response.response.status).toBe(200);
				expect(response.json).toMatchObject({username: 'a'});
				expect((await getUserRepository().findUniqueAssert(id)).discriminator).toBeGreaterThan(0);
			} else {
				expect(response.response.status).toBe(400);
				expect(response.json).toMatchObject({code: 'USERNAME_REQUIRES_ENTITLEMENT'});
			}
		},
	);
	it('rejects a filtered SSO derived name without creating an account', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			'admin:authenticate',
			'instance:config:update',
			'instance:config:view',
		]);
		await enableSso(harness, admin.token, {enforced: false});
		vi.spyOn(UsernamePolicyService.prototype, 'readCached').mockResolvedValue(published);
		const start = await createBuilderWithoutAuth<{state: string}>(harness)
			.post('/auth/sso/start')
			.body({redirect_to: '/me'})
			.execute();
		const email = createUniqueEmail('policy-sso');
		const response = await createBuilderWithoutAuth(harness)
			.post('/auth/sso/complete')
			.body({code: JSON.stringify({email, name: 'badpolicy'}), state: start.state})
			.executeRaw();
		expect(response.response.status).toBe(400);
		expect(response.json).toMatchObject({code: 'USERNAME_BLOCKED'});
		expect(await getUserRepository().findByEmail(email)).toBeNull();
	});
});
