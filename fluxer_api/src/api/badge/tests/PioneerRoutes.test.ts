// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createTestAccount,
	createUniqueEmail,
	findLastTestEmail,
	listTestEmails,
	setUserACLs,
	type TestAccount,
} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {fillPioneerNumber, PIONEER_DRY_RUN_KV_KEY} from '@app/api/badge/PioneerService';
import {getPngDataUrl} from '@app/api/emoji/tests/EmojiTestUtils';
import {decisionBody, endDecision} from '@app/api/enforcement/tests/EnforcementTestUtils';
import {getKVClient, getSnowflakeService, setInjectedWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getAdminRepository,
	getBadgeService,
	getPioneerRepository,
	getPioneerService,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {SyncTaskWorkerService} from '@app/api/test/SyncTaskWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import assignPioneerBadge from '@app/api/worker/tasks/AssignPioneerBadge';
import backfillPioneerBadges from '@app/api/worker/tasks/BackfillPioneerBadges';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {BadgeResponse} from '@fluxer/schema/src/domains/badge/BadgeResponseSchemas';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const TEXT = "Öncü #{n} — sanalyer'in ilk 10.000 kullanıcısından";
const shown = (n: number) => `Öncü #${n} — sanalyer'in ilk 10.000 kullanıcısından`;

// harness.reset() does not clear ServiceSingletons: getPioneerService() keeps the worker object it saw first. One
// object, injected before every test, keeps that true; spies go on this object. A test that closes the distribution
// lives in PioneerClosure.test.ts, because the singleton caches "closed" for the rest of the file.
const worker = new SyncTaskWorkerService({assignPioneerBadge, backfillPioneerBadges});

describe('Öncü badge', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let badge: BadgeResponse;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		setWorkerDependenciesForTest({adminRepository: getAdminRepository(), snowflakeService: getSnowflakeService()});
		setInjectedWorkerService(worker);
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.BADGES_MANAGE,
			AdminACLs.USER_TEMP_BAN,
			AdminACLs.ENFORCEMENT_ANNOTATE,
			AdminACLs.ENFORCEMENT_VIEW,
		]);
		badge = await createBuilder<BadgeResponse>(harness, admin.token)
			.post('/admin/badges')
			.body({icon: getPngDataUrl(), description: TEXT})
			.expect(HTTP_STATUS.OK)
			.execute();
	});

	afterEach(() => vi.restoreAllMocks());

	afterAll(async () => {
		clearWorkerDependencies();
		setInjectedWorkerService(new NoopWorkerService());
		await harness?.shutdown();
	});

	function start(first: TestAccount, excluded: Array<TestAccount>, extra: Record<string, unknown> = {}) {
		return createBuilder(harness, admin.token)
			.post('/admin/badges/pioneer/backfill')
			.body({
				badge_id: badge.id,
				first_user_id: first.userId,
				excluded_user_ids: excluded.map((account) => account.userId),
				...extra,
			});
	}

	async function descriptions(account: TestAccount): Promise<Array<string>> {
		return (await getBadgeService().getProfileBadges(createUserID(BigInt(account.userId)))).map((b) => b.description);
	}

	function securityFlags(account: TestAccount, body: Record<string, unknown>) {
		return createBuilderWithoutAuth(harness)
			.post(`/test/users/${account.userId}/security-flags`)
			.body(body)
			.expect(200)
			.execute();
	}

	function ban(target: TestAccount, hours: number) {
		return createBuilder<{user: {enforcement_decision_id: string | null}}>(harness, admin.token)
			.put(`/admin/users/${target.userId}/ban`)
			.header('X-Audit-Log-Reason', 'test note')
			.body({duration_hours: hours, decision: decisionBody()})
			.expect(200)
			.execute();
	}

	// The real flow of EmailChangeFlow.test.ts: start, prove the old address, request and prove the new one, apply.
	async function changeEmail(account: TestAccount, newEmail: string): Promise<void> {
		const started = await createBuilder<{ticket: string; require_original: boolean; original_proof?: string}>(
			harness,
			account.token,
		)
			.post('/users/@me/email-change/start')
			.body({password: account.password})
			.execute();
		let originalProof = started.original_proof!;
		if (started.require_original) {
			const code = findLastTestEmail(
				await listTestEmails(harness, {recipient: account.email}),
				'email_change_original',
			)!.metadata!.code!;
			originalProof = (
				await createBuilder<{original_proof: string}>(harness, account.token)
					.post('/users/@me/email-change/verify-original')
					.body({ticket: started.ticket, code, password: account.password})
					.execute()
			).original_proof;
		}
		await createBuilder(harness, account.token)
			.post('/users/@me/email-change/request-new')
			.body({ticket: started.ticket, new_email: newEmail, original_proof: originalProof, password: account.password})
			.execute();
		const code = findLastTestEmail(await listTestEmails(harness, {recipient: newEmail}), 'email_change_new')!.metadata!
			.code!;
		const {email_token} = await createBuilder<{email_token: string}>(harness, account.token)
			.post('/users/@me/email-change/verify-new')
			.body({ticket: started.ticket, code, original_proof: originalProof, password: account.password})
			.execute();
		await createBuilder(harness, account.token)
			.patch('/users/@me')
			.body({email_token, password: account.password})
			.expect(HTTP_STATUS.OK)
			.execute();
	}

	it('numbers the first account 1, skips the excluded admin, then older accounts by id, then opens the live hook', async () => {
		const older = await createTestAccount(harness);
		const epha = await createTestAccount(harness);

		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();

		const profile = await createBuilder<UserProfileFullResponse>(harness, epha.token)
			.get(`/users/${epha.userId}/profile`)
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(profile.badges).toEqual([{id: badge.id, icon: badge.icon, description: shown(1)}]);
		expect(await descriptions(older)).toEqual([shown(2)]);
		expect(await descriptions(admin)).toEqual([]);
		const newcomer = await createTestAccount(harness);
		expect(await descriptions(newcomer)).toEqual([shown(3)]);
	});

	it('a real start records its audit entry', async () => {
		const epha = await createTestAccount(harness);

		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();

		const entry = (await getAdminRepository().listAllAuditLogsPaginated(100)).find(
			(log) => log.action === 'start_pioneer_backfill',
		);
		expect(entry?.targetId.toString()).toBe(badge.id);
		expect(Object.fromEntries(entry?.metadata ?? [])).toEqual({
			first_user_id: epha.userId,
			excluded_count: '1',
			dry_run: 'false',
		});
	});

	it('the verification link gives the number; a bounce and verifying again never give a second one', async () => {
		const epha = await createTestAccount(harness);
		const user = await createTestAccount(harness, {skipEmailVerification: true});
		await securityFlags(user, {email_verified: false});
		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await descriptions(user)).toEqual([]);

		await createBuilder(harness, user.token).post('/auth/verify/resend').body({}).expect(204).execute();
		const token = findLastTestEmail(await listTestEmails(harness, {recipient: user.email}), 'email_verification')!
			.metadata!.token!;
		await createBuilderWithoutAuth(harness).post('/auth/verify').body({token}).expect(204).execute();
		expect(await descriptions(user)).toEqual([shown(2)]);

		await securityFlags(user, {email_verified: false, email_bounced: true});
		await securityFlags(user, {email_verified: true});
		expect(await descriptions(user)).toEqual([shown(2)]);
		expect(await descriptions(await createTestAccount(harness))).toEqual([shown(3)]);
	});

	it('a timed ban and a self-disable keep the badge; a permanent ban removes it for good; the admin gives the old number back', async () => {
		const epha = await createTestAccount(harness);
		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();
		const timed = await createTestAccount(harness);
		const selfDisabled = await createTestAccount(harness);
		const banned = await createTestAccount(harness);

		await ban(timed, 1);
		await createBuilder(harness, selfDisabled.token)
			.post('/users/@me/disable')
			.body({password: selfDisabled.password})
			.expect(204)
			.execute();
		const permanentBan = await ban(banned, 0);
		// Upstream 2026-10: lifting a ban ends its enforcement decision instead of DELETE /ban.
		await endDecision(harness, admin, permanentBan.user.enforcement_decision_id!).expect(200).execute();

		expect(await descriptions(timed)).toEqual([shown(2)]);
		expect(await descriptions(selfDisabled)).toEqual([shown(3)]);
		expect(await descriptions(banned)).toEqual([]);
		expect(await descriptions(await createTestAccount(harness))).toEqual([shown(5)]);

		await createBuilder(harness, admin.token)
			.post(`/admin/users/${banned.userId}/badges/${badge.id}`)
			.expect(204)
			.execute();
		expect(await descriptions(banned)).toEqual([shown(4)]);
	});

	it('a take-back that keeps losing the record race drops the row, answers 409 and still records the audit entry', async () => {
		const epha = await createTestAccount(harness);
		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();
		vi.spyOn(getPioneerRepository(), 'setUserStatus').mockResolvedValue(false);

		await createBuilder(harness, admin.token)
			.delete(`/admin/users/${epha.userId}/badges/${badge.id}`)
			.expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT)
			.execute();

		expect(await descriptions(epha)).toEqual([]);
		const entry = (await getAdminRepository().listAllAuditLogsPaginated(100)).find(
			(log) => log.action === 'revoke_user_badge',
		);
		expect(entry?.targetId.toString()).toBe(epha.userId);
		expect(Object.fromEntries(entry?.metadata ?? [])).toEqual({badge_id: badge.id, record_settled: 'false'});
	});

	it('the backfill skips a permanently banned and a self-deleting account, and numbers a timed-banned one', async () => {
		const epha = await createTestAccount(harness);
		const banned = await createTestAccount(harness);
		const timed = await createTestAccount(harness);
		const leaving = await createTestAccount(harness);
		await ban(banned, 0);
		await ban(timed, 1);
		await createBuilder(harness, leaving.token)
			.post('/users/@me/delete')
			.body({password: leaving.password})
			.expect(204)
			.execute();

		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await descriptions(banned)).toEqual([]);
		expect(await descriptions(leaving)).toEqual([]);
		expect(await descriptions(timed)).toEqual([shown(2)]);
	});

	it('a backfill item that turned ineligible after the scan gets no number', async () => {
		const epha = await createTestAccount(harness);
		const banned = await createTestAccount(harness);
		const kept = await createTestAccount(harness);
		const service = getPioneerService();
		const collect = service.collectBackfillIds.bind(service);
		vi.spyOn(service, 'collectBackfillIds').mockImplementationOnce(async () => {
			const collected = await collect();
			await ban(banned, 0);
			return collected;
		});

		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await descriptions(banned)).toEqual([]);
		expect(await descriptions(kept)).toEqual([shown(2)]);
	});

	it('a rerun cannot move the numbers to another badge, a dry run included', async () => {
		const epha = await createTestAccount(harness);
		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();
		await createBuilder(harness, admin.token)
			.post('/admin/badges/pioneer/stop')
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const other = await createBuilder<BadgeResponse>(harness, admin.token)
			.post('/admin/badges')
			.body({icon: getPngDataUrl(), description: 'Second #{n}'})
			.expect(HTTP_STATUS.OK)
			.execute();

		for (const dryRun of [true, false]) {
			await createBuilder(harness, admin.token)
				.post('/admin/badges/pioneer/backfill')
				.body({badge_id: other.id, first_user_id: epha.userId, excluded_user_ids: [], dry_run: dryRun})
				.expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT)
				.execute();
		}

		expect((await getPioneerRepository().getState())?.badge_id).toBe(BigInt(badge.id));
		expect(await descriptions(epha)).toEqual([shown(1)]);
	});

	it('a start whose job cannot be queued leaves numbering stopped and the dry-run lock free', async () => {
		const epha = await createTestAccount(harness);
		vi.spyOn(worker, 'addJob')
			.mockRejectedValueOnce(new Error('queue down'))
			.mockRejectedValueOnce(new Error('queue down'));

		await start(epha, [admin]).expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).execute();
		expect((await getPioneerRepository().getState())?.status).toBe('off');
		await start(epha, [admin], {dry_run: true}).expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).execute();
		expect(await getKVClient().get(PIONEER_DRY_RUN_KV_KEY)).toBeNull();

		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await descriptions(epha)).toEqual([shown(1)]);
	});

	it('changing the e-mail address through the real flow never gives a second number', async () => {
		await start(await createTestAccount(harness), [admin])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const user = await createTestAccount(harness);

		await changeEmail(user, createUniqueEmail('oncu'));

		expect(await descriptions(user)).toEqual([shown(2)]);
		expect(await descriptions(await createTestAccount(harness))).toEqual([shown(3)]);
	});

	it('the general grant route never gives a numbered badge without its number', async () => {
		const stranger = await createTestAccount(harness);
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${stranger.userId}/badges/${badge.id}`)
			.expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT)
			.execute();

		await start(await createTestAccount(harness), [admin, stranger])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${stranger.userId}/badges/${badge.id}`)
			.expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT)
			.execute();
		expect(await descriptions(stranger)).toEqual([]);
	});

	it('20 accounts verifying at once get 20 different numbers with no gap', async () => {
		await start(await createTestAccount(harness), [admin])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		const accounts = await Promise.all(Array.from({length: 20}, () => createTestAccount(harness)));
		const numbers = (await Promise.all(accounts.map(descriptions))).map(([text]) => Number(/#(\d+)/.exec(text!)![1]));

		expect(numbers.sort((a, b) => a - b)).toEqual(Array.from({length: 20}, (_, i) => i + 2));
	});

	it('a flagged account waits and gets the next number the moment the flag clears', async () => {
		const epha = await createTestAccount(harness);
		const flagged = await createTestAccount(harness);
		await securityFlags(flagged, {set_flags: ['ACCOUNT_LIMITED']});
		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await descriptions(flagged)).toEqual([]);
		expect(await descriptions(await createTestAccount(harness))).toEqual([shown(2)]);

		await securityFlags(flagged, {clear_flags: ['ACCOUNT_LIMITED']});

		expect(await descriptions(flagged)).toEqual([shown(3)]);
	});

	it('after the stop new accounts get nothing', async () => {
		await start(await createTestAccount(harness), [admin])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await createBuilder(harness, admin.token)
			.post('/admin/badges/pioneer/stop')
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(await descriptions(await createTestAccount(harness))).toEqual([]);
	});

	it('a failing queue never fails the verification', async () => {
		await start(await createTestAccount(harness), [admin])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const addJob = worker.addJob.bind(worker);
		vi.spyOn(worker, 'addJob').mockImplementation(async (task, payload, options) => {
			if (task === 'assignPioneerBadge') throw new Error('queue down');
			return addJob(task, payload, options);
		});

		const user = await createTestAccount(harness);

		expect(await descriptions(user)).toEqual([]);
	});

	it('account deletion drops the badge and unlinks the number; nobody else gets it', async () => {
		await start(await createTestAccount(harness), [admin])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const gone = await createTestAccount(harness);

		await runUserDeletionHook('badges', {userId: createUserID(BigInt(gone.userId))});

		expect(await descriptions(gone)).toEqual([]);
		expect((await getPioneerRepository().getSlot(2))?.user_id ?? null).toBeNull();
		expect(await descriptions(await createTestAccount(harness))).toEqual([shown(3)]);
	});

	it('the data export and a renamed catalog text keep the number', async () => {
		const epha = await createTestAccount(harness);
		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();

		const extensions = await collectUserHarvestExtensions({userId: createUserID(BigInt(epha.userId))});
		expect(extensions.find((extension) => extension.name === 'badges')?.data).toEqual([
			expect.objectContaining({description: shown(1)}),
		]);
		await createBuilder(harness, admin.token)
			.patch(`/admin/badges/${badge.id}`)
			.body({description: 'Öncü no. {n}'})
			.expect(200)
			.execute();
		expect(await descriptions(epha)).toEqual(['Öncü no. 1']);
	});

	it('refuses a badge without {n}, an unknown badge, an unverified first account, a second start and a second dry run', async () => {
		const epha = await createTestAccount(harness);
		const plain = await createBuilder<BadgeResponse>(harness, admin.token)
			.post('/admin/badges')
			.body({icon: getPngDataUrl(), description: 'Early supporter'})
			.expect(HTTP_STATUS.OK)
			.execute();
		const unverified = await createTestAccount(harness, {skipEmailVerification: true});
		await securityFlags(unverified, {email_verified: false});

		await createBuilder(harness, admin.token)
			.post('/admin/badges/pioneer/backfill')
			.body({badge_id: plain.id, first_user_id: epha.userId, excluded_user_ids: []})
			.expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT)
			.execute();
		await createBuilder(harness, admin.token)
			.post('/admin/badges/pioneer/backfill')
			.body({badge_id: '123456789012345678', first_user_id: epha.userId, excluded_user_ids: []})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		await start(unverified, [admin]).expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT).execute();
		await getKVClient().set(PIONEER_DRY_RUN_KV_KEY, '1');
		await start(epha, [admin], {dry_run: true}).expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT).execute();
		await getKVClient().del(PIONEER_DRY_RUN_KV_KEY);
		await start(epha, [admin]).expect(HTTP_STATUS.NO_CONTENT).execute();
		await start(epha, [admin]).expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT).execute();
		await start(epha, [admin], {dry_run: true}).expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT).execute();
	});

	it('a dry run numbers nobody and reports the count in the audit log', async () => {
		const epha = await createTestAccount(harness);
		await createTestAccount(harness);

		await start(epha, [admin], {dry_run: true}).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await descriptions(epha)).toEqual([]);
		expect(await getPioneerRepository().getState()).toBeNull();
		const logs = await getAdminRepository().listAllAuditLogsPaginated(100);
		const summary = logs.find((log) => log.action === 'pioneer_backfill');
		expect(summary?.metadata.get('would_assign')).toBe('2');
		expect(summary?.metadata.get('first_username')).toBe(epha.username);
		expect(summary?.metadata.get('excluded_usernames')).toBe(admin.username);
		expect(await getKVClient().get(PIONEER_DRY_RUN_KV_KEY)).toBeNull();
	});

	it('leaves the text as it is for a badge row without a number, a row read without the column included', () => {
		expect(fillPioneerNumber(TEXT, null)).toBe(TEXT);
		expect(fillPioneerNumber(TEXT, undefined)).toBe(TEXT);
	});
});
