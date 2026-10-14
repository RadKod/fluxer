// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {registerUserAccountWriteHook, registerUserBannedHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('sanalyer account write and ban hook points', () => {
	let harness: ApiTestHarness;
	const writes: Array<{previous: UserRow | null; updated: UserRow}> = [];
	const bans: Array<string> = [];
	let restore: Array<() => void> = [];

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		writes.length = 0;
		bans.length = 0;
		restore = [
			registerUserAccountWriteHook('badges', async (context) => void writes.push(context)),
			registerUserBannedHook('badges', async ({userId}) => void bans.push(userId.toString())),
		];
	});

	afterEach(() => {
		for (const undo of restore.reverse()) undo();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('sees the creation and the verification step of a new account with the committed rows', async () => {
		const account = await createTestAccount(harness);

		// The creation goes through upsert, the only write of an SSO sign-up (verified from the start).
		expect(
			writes.some(({previous, updated}) => previous === null && updated.user_id.toString() === account.userId),
		).toBe(true);
		expect(
			writes.some(
				({previous, updated}) =>
					updated.user_id.toString() === account.userId &&
					updated.email_verified === true &&
					previous?.email_verified !== true,
			),
		).toBe(true);
	});

	it('a failing account write hook never fails the write', async () => {
		restore.push(
			registerUserAccountWriteHook('feed', async () => {
				throw new Error('boom');
			}),
		);

		const account = await createTestAccount(harness);

		expect(account.userId).toBeTruthy();
	});

	it('calls the banned hook only for a permanent admin ban', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.USER_TEMP_BAN,
		]);
		const timed = await createTestAccount(harness);
		const permanent = await createTestAccount(harness);

		await createBuilder(harness, admin.token)
			.put(`/admin/users/${timed.userId}/ban`)
			.body({duration_hours: 1})
			.expect(200)
			.execute();
		await createBuilder(harness, admin.token).delete(`/admin/users/${timed.userId}/ban`).expect(200).execute();
		await createBuilder(harness, admin.token)
			.put(`/admin/users/${permanent.userId}/ban`)
			.body({duration_hours: 0})
			.expect(200)
			.execute();

		expect(bans).toEqual([permanent.userId]);
	});

	it('runs the banned hook after a permanent admin ban has closed the account sessions', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.USER_TEMP_BAN,
		]);
		const banned = await createTestAccount(harness);
		const bannedId = createUserID(BigInt(banned.userId));
		const sessionsSeen: Array<number> = [];
		restore.push(
			registerUserBannedHook('badges', async ({userId}) => {
				sessionsSeen.push((await getUserRepository().listAuthSessions(userId)).length);
			}),
		);
		expect((await getUserRepository().listAuthSessions(bannedId)).length).toBeGreaterThan(0);

		await createBuilder(harness, admin.token)
			.put(`/admin/users/${banned.userId}/ban`)
			.body({duration_hours: 0})
			.expect(200)
			.execute();

		expect(sessionsSeen).toEqual([0]);
	});

	it('does not call the banned hook when a user disables their own account', async () => {
		const user = await createTestAccount(harness);

		await createBuilder(harness, user.token)
			.post('/users/@me/disable')
			.body({password: user.password})
			.expect(204)
			.execute();

		expect(bans).toEqual([]);
	});
});
