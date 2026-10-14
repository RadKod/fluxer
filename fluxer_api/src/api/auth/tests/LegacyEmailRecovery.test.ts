// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createAuthHarness,
	createTestAccount,
	findLastTestEmail,
	listTestEmails,
	setUserACLs,
} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {resetActivityEventsForTests, startActivityEvents} from '@app/api/infrastructure/activity/ActivityEvents';
import type {Event} from '@app/api/infrastructure/activity/Contract.generated';
import {getAdminRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {EmailChangeRepository} from '@app/api/user/repositories/auth/EmailChangeRepository';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('legacy restriction recovery', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		resetActivityEventsForTests();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it.each([false, true])(
		'email verification clears email requirements with prior verification %s',
		async (verified) => {
			const account = await createTestAccount(harness);
			const users = getUserRepository();
			const user = (await users.findUnique(createUserID(BigInt(account.userId))))!;
			await users.patchUpsert(
				user.id,
				{email_verified: verified, suspicious_activity_flags: 255 | 256 | (1 << 16)},
				user.toRow(),
			);
			await createBuilder(harness, account.token).post('/auth/verify/resend').body({}).expect(204).execute();
			const email = findLastTestEmail(await listTestEmails(harness, {recipient: account.email}), 'email_verification');
			expect(email?.metadata?.token).toBeDefined();
			await createBuilderWithoutAuth(harness)
				.post('/auth/verify')
				.body({token: email!.metadata!.token})
				.expect(204)
				.execute();
			const updated = (await users.findUnique(user.id))!;
			expect(updated.suspiciousActivityFlags).toBe(4 | 8 | 256 | (1 << 16));
			expect(updated.emailVerified).toBe(true);
		},
	);

	it('verified email-change token clears email requirements before the account update is published', async () => {
		const account = await createTestAccount(harness);
		const users = getUserRepository();
		const user = (await users.findUnique(createUserID(BigInt(account.userId))))!;
		await users.patchUpsert(user.id, {suspicious_activity_flags: 255 | 256}, user.toRow());
		const token = 'legacy-email-change-proof';
		await new EmailChangeRepository().createToken({
			token_: token,
			user_id: user.id,
			new_email: 'recovered@example.com',
			created_at: new Date(),
			expires_at: new Date(Date.now() + 60000),
		});
		await createBuilder(harness, account.token)
			.patch('/users/@me')
			.body({email_token: token, password: account.password})
			.expect(200)
			.execute();
		const updated = (await users.findUnique(user.id))!;
		expect(updated.email).toBe('recovered@example.com');
		expect(updated.suspiciousActivityFlags).toBe(4 | 8 | 256);
	});
	it('admin email verification clears only email requirements', async () => {
		const admin = await createTestAccount(harness);
		await setUserACLs(harness, admin, [AdminACLs.WILDCARD]);
		const target = await createTestAccount(harness);
		const users = getUserRepository();
		const user = (await users.findUnique(createUserID(BigInt(target.userId))))!;
		await users.patchUpsert(user.id, {suspicious_activity_flags: 255 | 256}, user.toRow());
		await createBuilder(harness, admin.token)
			.put(`/admin/users/${target.userId}/email-verification`)
			.body({})
			.expect(200)
			.execute();
		expect((await users.findUnique(user.id))!.suspiciousActivityFlags).toBe(4 | 8 | 256);
	});
	it('clears legacy flags through an audited admin route and preserves new account limits', async () => {
		const admin = await createTestAccount(harness);
		await setUserACLs(harness, admin, [AdminACLs.WILDCARD]);
		const target = await createTestAccount(harness);
		const users = getUserRepository();
		const user = (await users.findUnique(createUserID(BigInt(target.userId))))!;
		await users.patchUpsert(
			user.id,
			{suspicious_activity_flags: 8 | (1 << 16), flags: UserFlags.ACCOUNT_LIMITED},
			user.toRow(),
		);
		const events: Array<Event> = [];
		await startActivityEvents({
			publisher: {
				async publish(_subject, payload) {
					events.push(JSON.parse(payload) as Event);
				},
			},
			kv: new MockKVProvider(),
		});
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${target.userId}/clear-legacy-restriction`)
			.body({})
			.expect(200)
			.execute();
		const updated = (await users.findUnique(user.id))!;
		expect(events.filter((event) => event.kind === 'admin_action')).toMatchObject([
			{data: {admin_id: admin.userId, target_id: target.userId, action: 'update_flags'}},
		]);
		expect(updated.suspiciousActivityFlags).toBe(0);
		expect(updated.flags & UserFlags.ACCOUNT_LIMITED).toBe(UserFlags.ACCOUNT_LIMITED);
		const audits = await getAdminRepository().listAllAuditLogsPaginated(20);
		const audit = audits.find((entry) => entry.action === 'clear_legacy_restriction');
		expect(audit?.targetId).toBe(BigInt(target.userId));
		expect(Object.fromEntries(audit!.metadata)).toEqual({
			old_suspicious_activity_flags: String(8 | (1 << 16)),
			new_suspicious_activity_flags: '0',
		});
	});
	it('denies clearing legacy flags without the specific admin permission', async () => {
		const admin = await createTestAccount(harness);
		await setUserACLs(harness, admin, [AdminACLs.AUTHENTICATE]);
		const target = await createTestAccount(harness);
		const users = getUserRepository();
		const user = (await users.findUnique(createUserID(BigInt(target.userId))))!;
		await users.patchUpsert(user.id, {suspicious_activity_flags: 8}, user.toRow());
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${target.userId}/clear-legacy-restriction`)
			.body({})
			.expect(403, 'MISSING_ACL')
			.execute();
		expect((await users.findUnique(user.id))!.suspiciousActivityFlags).toBe(8);
	});
});
