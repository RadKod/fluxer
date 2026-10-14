// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {getAdminRepository, getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('username dictionary admin API', () => {
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
	it('publishes a generation with a verified manifest and mandatory audit', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_ADD, AdminACLs.BAN_PROFILE_SUBSTRING_CHECK]);
		const result = await createBuilder<{dictionary_gen: number; count: number}>(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'block impersonation')
			.body({scope: 'uname_exact', add: ['admin']})
			.execute();
		expect(result.count).toBe(1);
		const current = await createBuilder(harness, actor.token).get('/admin/username-dictionary').execute();
		expect(current).toMatchObject({
			dictionary_gen: result.dictionary_gen,
			count: 1,
			entries: {uname_exact: ['admin'], uname_contains: [], uname_allow: []},
		});
		const audit = (await getAdminRepository().listAllAuditLogsPaginated(1000)).find(
			(entry) => entry.action === 'publish_username_dictionary',
		);
		expect(audit?.auditLogReason).toBe('block impersonation');
		expect(audit?.metadata.get('count')).toBe('1');
	});
	it('requires remove permission even when the caller may add', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_ADD]);
		await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'not permitted')
			.body({scope: 'uname_exact', add: ['staff'], remove: ['admin']})
			.expect(403)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).dictionary_gen).toBe(0);
	});
	it('keeps legacy profile scopes outside generation publication', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_ADD]);
		await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'scope mismatch')
			.body({scope: 'global_name', add: ['admin']})
			.expect(400)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).dictionary_gen).toBe(0);
	});
	it('rejects an absent reason before writing any generation', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_ADD]);
		await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.body({scope: 'uname_exact', add: ['admin']})
			.expect(400)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).next_dictionary_gen).toBe(1);
	});
	it('rejects a combined generation larger than 20000 as an input error', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_ADD]);
		await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'seed')
			.body({scope: 'uname_exact', add: ['admin']})
			.execute();
		const before = await getInstanceConfigRepository().readUsernamePolicyConfig();
		await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'too large')
			.body({scope: 'uname_contains', add: Array.from({length: 20000}, (_, index) => `word${index}`)})
			.expect(400)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).dictionary_gen).toBe(before.dictionary_gen);
	});
	it('denies allowlist additions to a caller with only ban permission', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_ADD]);
		await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'unban')
			.body({scope: 'uname_allow', add: ['shilton']})
			.expect(403)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).dictionary_gen).toBe(0);
	});
	it('allows allowlist additions to a caller with only unban permission', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_REMOVE]);
		const result = await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'unban')
			.body({scope: 'uname_allow', add: ['shilton']})
			.execute();
		expect(result).toMatchObject({count: 1, entries: {uname_allow: ['shilton']}});
	});
	it('denies allowlist removal to a caller with only unban permission', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_REMOVE]);
		await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'ban')
			.body({scope: 'uname_allow', remove: ['shilton']})
			.expect(403)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).dictionary_gen).toBe(0);
	});
	it('allows allowlist removal to a caller with only ban permission', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_ADD]);
		const result = await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.header('X-Audit-Log-Reason', 'ban')
			.body({scope: 'uname_allow', remove: ['shilton']})
			.execute();
		expect(result).toMatchObject({count: 0, entries: {uname_allow: []}});
	});
	it('requires a reason for an authorized allowlist addition', async () => {
		const actor = await admin([AdminACLs.BAN_PROFILE_SUBSTRING_REMOVE]);
		await createBuilder(harness, actor.token)
			.patch('/admin/username-dictionary')
			.body({scope: 'uname_allow', add: ['shilton']})
			.expect(400)
			.execute();
		expect((await getInstanceConfigRepository().readUsernamePolicyConfig()).next_dictionary_gen).toBe(1);
	});
});
