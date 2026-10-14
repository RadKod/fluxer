// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {fetchUser, fetchUserMe, updateUserProfile} from '@app/api/user/tests/UserTestUtils';
import {PublicUserFlags, UserFlags} from '@fluxer/constants/src/UserConstants';
import type {UserPrivateResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'vitest';

async function setUserFlags(harness: ApiTestHarness, userId: string, flags: bigint): Promise<void> {
	await createBuilder(harness, '')
		.patch(`/test/users/${userId}/flags`)
		.body({flags: flags.toString()})
		.expect(HTTP_STATUS.OK)
		.execute();
}

describe('User flags in responses', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	test('GET /users/@me hides staff flag when STAFF_HIDDEN is set', async () => {
		const account = await createTestAccount(harness);
		await setUserFlags(harness, account.userId, UserFlags.STAFF | UserFlags.STAFF_HIDDEN);
		const {json} = await fetchUserMe(harness, account.token);
		expect(json.flags & PublicUserFlags.STAFF).toBe(0);
		expect(json.is_staff).toBe(true);
	});
	test('PATCH /users/@me preserves staff flag with STAFF_HIDDEN after profile update', async () => {
		const account = await createTestAccount(harness);
		await setUserFlags(harness, account.userId, UserFlags.STAFF | UserFlags.STAFF_HIDDEN);
		const {json} = await updateUserProfile(harness, account.token, {
			bio: 'updated bio',
		});
		expect(json.flags & PublicUserFlags.STAFF).toBe(0);
		expect(json.is_staff).toBe(true);
	});
	test('GET /users/:id hides staff flag when STAFF_HIDDEN is set', async () => {
		const account = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await setUserFlags(harness, account.userId, UserFlags.STAFF | UserFlags.STAFF_HIDDEN);
		const {json} = await fetchUser(harness, account.userId, viewer.token);
		expect(json.flags & PublicUserFlags.STAFF).toBe(0);
	});
	test('VERIFIED is public user flag bit 29', () => {
		expect(UserFlags.VERIFIED).toBe(1n << 29n);
		expect(PublicUserFlags.VERIFIED).toBe(1 << 29);
	});
	test('GET /users/@me and GET /users/:id include VERIFIED next to SPAMMER', async () => {
		const account = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await setUserFlags(harness, account.userId, UserFlags.VERIFIED | UserFlags.SPAMMER);
		const {json: me} = await fetchUserMe(harness, account.token);
		expect(me.flags).toBe(PublicUserFlags.VERIFIED | PublicUserFlags.SPAMMER);
		const {json: partial} = await fetchUser(harness, account.userId, viewer.token);
		expect(partial.flags).toBe(PublicUserFlags.VERIFIED | PublicUserFlags.SPAMMER);
	});
	test('STAFF_HIDDEN hides STAFF but keeps VERIFIED', async () => {
		const account = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await setUserFlags(harness, account.userId, UserFlags.STAFF | UserFlags.STAFF_HIDDEN | UserFlags.VERIFIED);
		const {json} = await fetchUser(harness, account.userId, viewer.token);
		expect(json.flags).toBe(PublicUserFlags.VERIFIED);
	});
	test('PATCH /users/@me ignores a flags field, so a user cannot verify themselves', async () => {
		const account = await createTestAccount(harness);
		const {json: updated} = await createBuilder<UserPrivateResponse>(harness, account.token)
			.patch('/users/@me')
			.body({bio: 'self verify attempt', flags: 1 << 29})
			.expect(HTTP_STATUS.OK)
			.executeWithResponse();
		expect(updated.flags & (1 << 29)).toBe(0);
		const {json: me} = await fetchUserMe(harness, account.token);
		expect(me.flags & (1 << 29)).toBe(0);
	});
	test('PATCH /users/@me does not leak internal flags', async () => {
		const account = await createTestAccount(harness);
		await setUserFlags(harness, account.userId, UserFlags.STAFF | UserFlags.SPAMMER | UserFlags.HIGH_GLOBAL_RATE_LIMIT);
		const {json: me} = await fetchUserMe(harness, account.token);
		expect(me.flags & PublicUserFlags.STAFF).toBe(PublicUserFlags.STAFF);
		expect(me.flags & PublicUserFlags.SPAMMER).toBe(PublicUserFlags.SPAMMER);
		expect(me.flags & Number(UserFlags.HIGH_GLOBAL_RATE_LIMIT)).toBe(0);
		const updated = await updateUserProfile(harness, account.token, {
			bio: 'checking internal flags',
		});
		expect(updated.json.flags & PublicUserFlags.STAFF).toBe(PublicUserFlags.STAFF);
		expect(updated.json.flags & PublicUserFlags.SPAMMER).toBe(PublicUserFlags.SPAMMER);
		expect(updated.json.flags & Number(UserFlags.HIGH_GLOBAL_RATE_LIMIT)).toBe(0);
	});
});
