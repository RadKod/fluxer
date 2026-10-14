// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminRepository} from '@app/api/admin/AdminRepository';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {BadgeRepository} from '@app/api/badge/BadgeRepository';
import {PioneerRepository} from '@app/api/badge/PioneerRepository';
import {
	isPioneerEligible,
	PIONEER_MAX_SLOTS,
	PIONEER_STATE_KV_KEY,
	PIONEER_STATE_KV_TTL_SECONDS,
	PioneerService,
} from '@app/api/badge/PioneerService';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getAdminRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import backfillPioneerBadges from '@app/api/worker/tasks/BackfillPioneerBadges';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {findLaneForTask, validateLaneCompleteness, type WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {workerTasks} from '@app/api/worker/WorkerTaskRegistry';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import {JobCancelledError} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const BADGE_ID = 777n;
const NOW = Date.UTC(2026, 8, 25);
const HOUR = 60 * 60 * 1000;
const uid = (n: number): UserID => createUserID(BigInt(n));

describe('PioneerService', () => {
	let harness: ApiTestHarness;
	let repository: PioneerRepository;
	let badges: BadgeRepository;
	let jobs: Array<{task: string; payload: unknown}>;

	function makeService(overrides: {badgeRepository?: BadgeRepository} = {}): PioneerService {
		return new PioneerService({
			repository,
			badgeRepository: overrides.badgeRepository ?? badges,
			userRepository: getUserRepository(),
			kvClient: getKVClient(),
			workerService: {
				addJob: async (task: string, payload: unknown) => {
					jobs.push({task, payload});
					return 1n;
				},
				cancelJob: async () => false,
				retryDeadLetterJob: async () => false,
			} as unknown as IWorkerService<WorkerTaskName>,
		});
	}

	async function open(nextSlot = 1): Promise<void> {
		await repository.ensureState();
		await repository.setStatus('off', 'open', BADGE_ID);
		if (nextSlot !== 1) await repository.setNextSlot(nextSlot);
	}

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		repository = new PioneerRepository();
		badges = new BadgeRepository();
		jobs = [];
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('runs both tasks on the lifecycle lane', () => {
		expect(findLaneForTask('assignPioneerBadge')).toBe('lifecycle');
		expect(findLaneForTask('backfillPioneerBadges')).toBe('lifecycle');
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});

	it('gives numbers in order, writes the numbered badge row and moves the probe start', async () => {
		const service = makeService();
		await open();

		expect(await service.assign(uid(10))).toBe(1);
		expect(await service.assign(uid(11))).toBe(2);

		expect((await repository.getState())?.next_slot).toBe(3);
		expect(await badges.listUserBadges(uid(11))).toEqual([expect.objectContaining({badge_id: BADGE_ID, sequence: 2})]);
	});

	it('never gives two accounts the same number when 25 claims race', async () => {
		const service = makeService();
		await open();

		const numbers = await Promise.all(Array.from({length: 25}, (_, i) => service.assign(uid(100 + i))));

		expect([...numbers].sort((a, b) => a! - b!)).toEqual(Array.from({length: 25}, (_, i) => i + 1));
	});

	it('gives one number to one account when its jobs run at the same time', async () => {
		const service = makeService();
		await open();

		const numbers = await Promise.all([1, 2, 3, 4, 5].map(() => service.assign(uid(50))));

		expect(new Set(numbers)).toEqual(new Set([1]));
		expect(await service.assign(uid(51))).toBe(2);
	});

	it('a crash before the badge row keeps the same number on retry, with no gap', async () => {
		const badgeRepository = new BadgeRepository();
		const service = makeService({badgeRepository});
		await open();
		vi.spyOn(badgeRepository, 'grantUserBadge').mockRejectedValueOnce(new Error('crash'));

		await expect(service.assign(uid(60))).rejects.toThrow('crash');

		expect(await service.assign(uid(60))).toBe(1);
		expect(await service.assign(uid(61))).toBe(2);
	});

	it('a crash before the commit keeps the same number on retry, with no gap', async () => {
		const service = makeService();
		await open();
		vi.spyOn(repository, 'setUserStatus').mockRejectedValueOnce(new Error('crash'));

		await expect(service.assign(uid(62))).rejects.toThrow('crash');

		expect(await service.assign(uid(62))).toBe(1);
		expect(await service.assign(uid(63))).toBe(2);
	});

	it('gives the last number, then no badge, and closes the distribution', async () => {
		const service = makeService();
		await open(PIONEER_MAX_SLOTS);

		expect(await service.assign(uid(70))).toBe(10_000);
		expect(await service.assign(uid(71))).toBeNull();

		expect((await repository.getByUser(uid(71)))?.status).toBe('late');
		expect(await badges.listUserBadges(uid(71))).toEqual([]);
		expect((await repository.getState())?.status).toBe('closed');
		expect(await getKVClient().get(PIONEER_STATE_KV_KEY)).toBe('closed');
	});

	it.each([
		['a verified person', {}, true],
		['an unverified account', {email_verified: false}, false],
		['a bot', {bot: true}, false],
		['the system user', {system: true}, false],
		['a deleted account', {flags: UserFlags.DELETED}, false],
		['an account with an open limitation', {flags: UserFlags.ACCOUNT_LIMITED}, false],
		['an account exempt from limitation', {flags: UserFlags.ACCOUNT_LIMITED | UserFlags.LIMIT_EXEMPT}, true],
		['a legacy restricted account', {suspicious_activity_flags: 4}, false],
		[
			'a legacy account with a satisfied phone requirement',
			{suspicious_activity_flags: 4, has_verified_phone: true},
			true,
		],
		['a legacy restriction despite exemption', {suspicious_activity_flags: 4, flags: UserFlags.LIMIT_EXEMPT}, false],
		['a permanent admin ban', {flags: UserFlags.DISABLED, temp_banned_until: new Date(NOW + 100 * 8760 * HOUR)}, false],
		[
			'a timed ban (longest: 8760 h)',
			{flags: UserFlags.DISABLED, temp_banned_until: new Date(NOW + 8760 * HOUR)},
			true,
		],
		['a self-disabled account', {flags: UserFlags.DISABLED}, true],
		['a self-deleted account', {flags: UserFlags.SELF_DELETED}, false],
		['an account waiting for deletion', {pending_deletion_at: new Date(NOW + HOUR)}, false],
		['an account disabled for suspicious activity', {flags: UserFlags.DISABLED_SUSPICIOUS_ACTIVITY}, false],
		['a spammer', {flags: UserFlags.SPAMMER}, false],
	])('eligibility: %s', (_label, change, expected) => {
		const row = {
			email: 'legacy@example.com',
			email_verified: true,
			bot: false,
			system: false,
			flags: 0n,
			temp_banned_until: null,
			pending_deletion_at: null,
			...change,
		};
		expect(isPioneerEligible(row as UserRow, NOW)).toBe(expected);
	});

	describe('account write hook', () => {
		const unverified = {
			user_id: uid(80),
			email: 'legacy@example.com',
			email_verified: false,
			bot: false,
			system: false,
			flags: 0n,
		} as UserRow;
		const verified = {...unverified, email_verified: true} as UserRow;

		it('no KV read for writes that are not the step to eligible; one job for the step while open', async () => {
			const service = makeService();
			await open();
			const get = vi.spyOn(getKVClient(), 'get');

			await service.onAccountWritten({previous: verified, updated: verified});
			await service.onAccountWritten({previous: null, updated: unverified});
			await service.onAccountWritten({
				previous: unverified,
				updated: {...unverified, global_name: 'renamed'} as UserRow,
			});
			expect(get).not.toHaveBeenCalled();

			await service.onAccountWritten({previous: unverified, updated: verified});
			expect(jobs).toEqual([{task: 'assignPioneerBadge', payload: {userId: '80'}}]);
		});

		it.each(['off', 'backfilling', 'closed'] as const)('queues nothing while %s', async (status) => {
			const service = makeService();
			await getKVClient().set(PIONEER_STATE_KV_KEY, status);

			await service.onAccountWritten({previous: unverified, updated: verified});

			expect(jobs).toEqual([]);
		});

		it('reads the state row once when KV is empty and stores it in KV', async () => {
			const service = makeService();
			await open();
			await getKVClient().del(PIONEER_STATE_KV_KEY);

			await service.onAccountWritten({previous: unverified, updated: verified});

			expect(await getKVClient().get(PIONEER_STATE_KV_KEY)).toBe('open');
			expect(jobs).toHaveLength(1);
		});
		it('queues a job when the persisted legacy restriction is cleared', async () => {
			const service = makeService();
			await open();
			const restricted = {...verified, suspicious_activity_flags: 4};
			await service.onAccountWritten({previous: restricted, updated: {...restricted, suspicious_activity_flags: 0}});
			expect(jobs).toEqual([{task: 'assignPioneerBadge', payload: {userId: '80'}}]);
		});

		it('queues nothing when a write lifts no blocker: the first session flag or a new limitation on an unverified account', async () => {
			const service = makeService();
			await open();
			const get = vi.spyOn(getKVClient(), 'get');

			await service.onAccountWritten({
				previous: unverified,
				updated: {...unverified, flags: UserFlags.HAS_SESSION_STARTED} as UserRow,
			});
			await service.onAccountWritten({
				previous: unverified,
				updated: {...unverified, flags: UserFlags.ACCOUNT_LIMITED} as UserRow,
			});

			expect(get).not.toHaveBeenCalled();
			expect(jobs).toEqual([]);
		});

		it('queues a job when a blocker lifted on a stale row; the job decides from the current row', async () => {
			const service = makeService();
			await open();
			const flagged = UserFlags.ACCOUNT_LIMITED;

			// The e-mail step saw the limitation still set (the lifting step committed in between).
			await service.onAccountWritten({
				previous: {...unverified, flags: flagged} as UserRow,
				updated: {...verified, flags: flagged} as UserRow,
			});

			expect(jobs).toEqual([{task: 'assignPioneerBadge', payload: {userId: '80'}}]);
		});

		it('falls back to the state row when KV fails', async () => {
			const service = makeService();
			await open();
			vi.spyOn(getKVClient(), 'get').mockRejectedValueOnce(new Error('kv down'));

			await service.onAccountWritten({previous: unverified, updated: verified});

			expect(jobs).toHaveLength(1);
		});

		it('does not wait for a hanging KV write after reading the state row', async () => {
			const service = makeService();
			await open();
			vi.spyOn(getKVClient(), 'set').mockReturnValueOnce(new Promise<string | null>(() => {}));
			const hung = new Promise((resolve) => setTimeout(() => resolve('hung'), 500));

			const outcome = await Promise.race([service.onAccountWritten({previous: unverified, updated: verified}), hung]);

			expect(outcome).toBeUndefined();
			expect(jobs).toHaveLength(1);
		});

		it('queues nothing when KV fails and the distribution was never opened', async () => {
			const service = makeService();
			vi.spyOn(getKVClient(), 'get').mockRejectedValueOnce(new Error('kv down'));

			await service.onAccountWritten({previous: unverified, updated: verified});

			expect(jobs).toEqual([]);
		});

		it('stops reading KV after it sees closed', async () => {
			const service = makeService();
			await getKVClient().set(PIONEER_STATE_KV_KEY, 'closed');
			const get = vi.spyOn(getKVClient(), 'get');

			await service.onAccountWritten({previous: unverified, updated: verified});
			await service.onAccountWritten({previous: unverified, updated: verified});

			expect(get).toHaveBeenCalledTimes(1);
		});

		it('a queued job after stop gives nothing, even with a stale open in KV', async () => {
			const service = makeService();
			await open();
			const account = await createTestAccount(harness);
			await service.stop();
			// A stale KV value: the job still checks the state row before it numbers anyone.
			await getKVClient().set(PIONEER_STATE_KV_KEY, 'open');

			await service.assignFromQueue(createUserID(BigInt(account.userId)));

			expect(await repository.getByUser(createUserID(BigInt(account.userId)))).toBeNull();
		});
	});

	it('revoke keeps the number for a regrant and never gives a second one', async () => {
		const service = makeService();
		await open();
		await service.assign(uid(90));

		await service.revoke(uid(90));
		expect(await badges.listUserBadges(uid(90))).toEqual([]);
		await service.assign(uid(90));
		expect(await badges.listUserBadges(uid(90))).toEqual([]);
		expect(await service.assign(uid(91))).toBe(2);

		await service.regrant(uid(90), BADGE_ID);
		expect(await badges.listUserBadges(uid(90))).toEqual([expect.objectContaining({sequence: 1})]);
	});

	it('regrant refuses an account without a number', async () => {
		const service = makeService();
		await open();

		await expect(service.regrant(uid(92), BADGE_ID)).rejects.toBeInstanceOf(ConflictError);
	});

	it('revoke throws after three lost compare-and-sets, and the badge row is still gone', async () => {
		const service = makeService();
		await open();
		await service.assign(uid(89));
		const setUserStatus = vi.spyOn(repository, 'setUserStatus').mockResolvedValue(false);

		await expect(service.revoke(uid(89))).rejects.toBeInstanceOf(ConflictError);

		expect(setUserStatus).toHaveBeenCalledTimes(3);
		expect(await badges.listUserBadges(uid(89))).toEqual([]);
	});

	it('forget burns the number, unlinks it and runs twice without error', async () => {
		const service = makeService();
		await open();
		await service.assign(uid(93));

		await service.forget(uid(93));
		await service.forget(uid(93));

		expect((await repository.getSlot(1))?.user_id ?? null).toBeNull();
		expect(await repository.getByUser(uid(93))).toMatchObject({status: 'deleted', slot: null});
		expect(await service.assign(uid(93))).toBeNull();
		expect(await service.assign(uid(94))).toBe(2);
	});

	it('an excluded account never gets a number', async () => {
		const service = makeService();
		await open();

		await service.exclude([uid(95)]);

		expect(await service.assign(uid(95))).toBeNull();
		expect(await service.assign(uid(96))).toBe(1);
	});

	it('exclude reports an account that already has a record and leaves that record alone', async () => {
		const service = makeService();
		await open();
		await service.assign(uid(88));

		expect(await service.exclude([uid(87), uid(88)])).toEqual({excluded: [uid(87)], alreadyRecorded: [uid(88)]});

		expect(await repository.getByUser(uid(88))).toMatchObject({status: 'granted', slot: 1});
	});

	it('exclude run again (a redelivered or restarted backfill) still counts an earlier exclusion as excluded', async () => {
		const service = makeService();
		await open();
		await service.exclude([uid(86)]);

		expect(await service.exclude([uid(86)])).toEqual({excluded: [uid(86)], alreadyRecorded: []});
	});

	it('the backfill audit names only the accounts it excluded and lists the already recorded ones apart', async () => {
		const [first, admin, numbered] = await Promise.all([1, 2, 3].map(() => createTestAccount(harness)));
		await open();
		await makeService().assign(createUserID(BigInt(numbered!.userId)));
		await repository.setStatus('open', 'backfilling');
		setWorkerDependenciesForTest({adminRepository: getAdminRepository(), snowflakeService: getSnowflakeService()});
		try {
			await backfillPioneerBadges(
				{
					first_user_id: first!.userId,
					excluded_user_ids: [admin!.userId, numbered!.userId],
					dry_run: false,
					admin_user_id: '4000000000000000000',
					audit_log_reason: null,
				},
				{
					logger: new NoopLogger(),
					jobId: 7100000000000000000n,
					addJob: async () => 0n,
					reportProgress: async () => {},
					shouldCancel: async () => false,
					setContextLink: async () => {},
				},
			);
		} finally {
			clearWorkerDependencies();
		}

		const [log] = (await new AdminRepository().listAllAuditLogsPaginated(10)).filter(
			(entry) => entry.action === 'pioneer_backfill',
		);
		expect(log?.metadata.get('excluded_usernames')).toBe(admin!.username);
		expect(log?.metadata.get('excluded_already_recorded')).toBe(numbered!.username);
		expect(log?.metadata.get('excluded_count')).toBe('1');
		expect(await repository.getByUser(createUserID(BigInt(numbered!.userId)))).toMatchObject({status: 'granted'});
	});

	it('collects eligible accounts without a record, smallest ids first, no more than the numbers left', async () => {
		const service = makeService();
		const accounts = await Promise.all([1, 2, 3, 4].map(() => createTestAccount(harness)));
		const ids = accounts.map((account) => BigInt(account.userId)).sort((a, b) => (a < b ? -1 : 1));
		await open(PIONEER_MAX_SLOTS - 1);
		await service.exclude([createUserID(ids[0]!)]);

		expect((await service.collectBackfillIds()).ids.map(String)).toEqual([ids[1], ids[2]].map(String));
	});

	it.each(['upstream', 'legacy'])(
		'counts accounts waiting only on %s limitation without granting a backfill number',
		async (kind) => {
			const service = makeService();
			const waiting = await createTestAccount(harness);
			const repository = getUserRepository();
			const user = (await repository.findUnique(createUserID(BigInt(waiting.userId))))!;
			await repository.patchUpsert(
				user.id,
				kind === 'legacy' ? {suspicious_activity_flags: 4} : {flags: UserFlags.ACCOUNT_LIMITED},
				user.toRow(),
			);
			await open();
			expect(await service.collectBackfillIds()).toEqual({ids: [], flagged: 1});
		},
	);

	async function backfilling(): Promise<void> {
		await repository.ensureState();
		await repository.setStatus('off', 'backfilling', BADGE_ID);
		await getKVClient().setex(PIONEER_STATE_KV_KEY, PIONEER_STATE_KV_TTL_SECONDS, 'backfilling');
	}

	it('finishBackfill opens, numbers whoever verified during the first pass and writes KV from the state row', async () => {
		const service = makeService();
		await backfilling();
		const late = await createTestAccount(harness);
		const setex = vi.spyOn(getKVClient(), 'setex');

		const metadata = new Map(await service.finishBackfill());

		expect(await badges.listUserBadges(createUserID(BigInt(late.userId)))).toEqual([
			expect.objectContaining({sequence: 1}),
		]);
		expect(metadata.get('catch_up_count')).toBe('1');
		expect(setex).toHaveBeenCalledWith(PIONEER_STATE_KV_KEY, PIONEER_STATE_KV_TTL_SECONDS, 'open');
	});

	it('finishBackfill rewrites a stale backfilling in KV even when another writer already opened', async () => {
		await repository.ensureState();
		await repository.setStatus('off', 'open', BADGE_ID);
		await getKVClient().setex(PIONEER_STATE_KV_KEY, PIONEER_STATE_KV_TTL_SECONDS, 'backfilling');

		await makeService().finishBackfill();

		expect(await getKVClient().get(PIONEER_STATE_KV_KEY)).toBe('open');
	});

	it('a failing catch-up item is counted and the others still get their numbers', async () => {
		const service = makeService();
		await backfilling();
		const accounts = await Promise.all([1, 2].map(() => createTestAccount(harness)));
		// The first catch-up item fails at its claim; the loop must go on to the next one.
		vi.spyOn(repository, 'claimUser').mockRejectedValueOnce(new Error('timeout'));

		const metadata = new Map(await service.finishBackfill());

		expect(metadata.get('catch_up_failed')).toBe('1');
		const numbered = await Promise.all(accounts.map((a) => badges.listUserBadges(createUserID(BigInt(a.userId)))));
		expect(numbered.flat()).toHaveLength(1);
	});

	it('a stop during the backfill ends its remaining items and the catch-up', async () => {
		const service = makeService();
		await backfilling();
		expect(await service.assign(uid(20), {requireStatus: 'backfilling'})).toBe(1);

		await service.stop();

		expect(await service.assign(uid(21), {requireStatus: 'backfilling'})).toBeNull();
		const metadata = new Map(await service.finishBackfill());
		expect(metadata.get('status')).toBe('off');
		expect(metadata.get('catch_up_count')).toBe('0');
	});

	it('an item that failed after its slot claim is collected again and keeps its number', async () => {
		const badgeRepository = new BadgeRepository();
		const service = makeService({badgeRepository});
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		await backfilling();
		vi.spyOn(badgeRepository, 'grantUserBadge').mockRejectedValueOnce(new Error('crash'));

		await expect(service.assign(userId, {requireStatus: 'backfilling'})).rejects.toThrow('crash');

		expect((await service.collectBackfillIds()).ids).toEqual([userId]);
		expect(await service.assign(userId, {requireStatus: 'backfilling'})).toBe(1);
	});

	it('forget unlinks the slot of a claim that never committed', async () => {
		const service = makeService();
		await open();
		vi.spyOn(repository, 'setUserStatus').mockRejectedValueOnce(new Error('crash'));
		await expect(service.assign(uid(97))).rejects.toThrow('crash');

		await service.forget(uid(97));

		expect((await repository.getSlot(1))?.user_id ?? null).toBeNull();
	});

	it('a claim cut before its commit finishes after the distribution closed, without pulling the probe start back', async () => {
		const service = makeService();
		await open(PIONEER_MAX_SLOTS - 1);
		const account = await createTestAccount(harness);
		const userId = createUserID(BigInt(account.userId));
		vi.spyOn(repository, 'setUserStatus').mockRejectedValueOnce(new Error('timeout'));
		await expect(service.assignFromQueue(userId)).rejects.toThrow('timeout');
		expect(await service.assign(uid(71))).toBe(10_000);
		expect((await repository.getState())?.status).toBe('closed');

		await service.assignFromQueue(userId);

		expect(await repository.getByUser(userId)).toMatchObject({status: 'granted', slot: 9_999});
		expect(await badges.listUserBadges(userId)).toEqual([expect.objectContaining({sequence: 9_999})]);
		// Closed is final: the late commit must not move next_slot back from past the last number.
		expect((await repository.getState())?.next_slot).toBe(PIONEER_MAX_SLOTS + 1);
	});

	it('after closing, a job for an account without an unfinished claim reads one row and gives nothing', async () => {
		const service = makeService();
		await open(PIONEER_MAX_SLOTS);
		await service.assign(uid(72));
		const account = await createTestAccount(harness);
		const findUnique = vi.spyOn(getUserRepository(), 'findUnique');

		await service.assignFromQueue(createUserID(BigInt(account.userId)));

		expect(findUnique).not.toHaveBeenCalled();
		expect(await repository.getByUser(createUserID(BigInt(account.userId)))).toBeNull();
	});

	it('a regrant that lands while a retry clears a revoked row keeps its badge row', async () => {
		const service = makeService();
		await open();
		await service.assign(uid(99));
		await service.revoke(uid(99));
		const getByUser = repository.getByUser.bind(repository);
		vi.spyOn(repository, 'getByUser').mockImplementation(async (userId, serial) => {
			const record = await getByUser(userId, serial);
			// The admin gives the badge back right after the retry read the revoked record.
			if (!serial && record?.status === 'revoked') await service.regrant(uid(99), BADGE_ID);
			return record;
		});

		await service.assign(uid(99));

		expect(await badges.listUserBadges(uid(99))).toEqual([expect.objectContaining({sequence: 1})]);
	});

	it('a retry after a ban that landed mid-claim removes the badge row', async () => {
		const service = makeService();
		await open();
		vi.spyOn(repository, 'setUserStatus').mockRejectedValueOnce(new Error('crash'));
		await expect(service.assign(uid(98))).rejects.toThrow('crash');
		await service.revoke(uid(98));
		// The crashed attempt's row write landing after the ban.
		await badges.grantUserBadge({user_id: uid(98), badge_id: BADGE_ID, granted_at: new Date(), sequence: 1});

		await service.assign(uid(98));

		expect(await badges.listUserBadges(uid(98))).toEqual([]);
	});

	it.each([
		['every later cancel check says so', (check: number) => check > 1],
		['a later cancel check fails and reads false', (check: number) => check === 2],
	])(
		'a backfill job cancelled mid-run shuts numbering instead of opening it and numbers nobody after the cancel (%s)',
		async (_label, cancelled) => {
			const [first, a, b] = await Promise.all([1, 2, 3].map(() => createTestAccount(harness)));
			const [earlier, later] = [a!, b!]
				.map((account) => createUserID(BigInt(account.userId)))
				.sort((x, y) => (x < y ? -1 : 1));
			await backfilling();
			// The admin cancels the job on the jobs page after its first item.
			let checks = 0;
			setWorkerDependenciesForTest({adminRepository: getAdminRepository(), snowflakeService: getSnowflakeService()});
			try {
				await expect(
					backfillPioneerBadges(
						{
							first_user_id: first!.userId,
							excluded_user_ids: [],
							dry_run: false,
							admin_user_id: '4000000000000000000',
							audit_log_reason: null,
						},
						{
							logger: new NoopLogger(),
							jobId: 7100000000000000001n,
							addJob: async () => 0n,
							reportProgress: async () => {},
							shouldCancel: async () => cancelled(++checks),
							setContextLink: async () => {},
						},
					),
				).rejects.toBeInstanceOf(JobCancelledError);
			} finally {
				clearWorkerDependencies();
			}

			expect((await repository.getState())?.status).toBe('off');
			expect(await getKVClient().get(PIONEER_STATE_KV_KEY)).toBe('off');
			expect(await badges.listUserBadges(earlier!)).toEqual([expect.objectContaining({sequence: 2})]);
			expect(await badges.listUserBadges(later!)).toEqual([]);
			const [log] = (await new AdminRepository().listAllAuditLogsPaginated(10)).filter(
				(entry) => entry.action === 'pioneer_backfill',
			);
			expect(log?.metadata.get('stopped_by_cancel')).toBe('true');
		},
	);

	it('a hook that read backfilling never puts it back into KV after the distribution opened', async () => {
		const service = makeService();
		await backfilling();
		await getKVClient().del(PIONEER_STATE_KV_KEY);
		const getState = repository.getState.bind(repository);
		vi.spyOn(repository, 'getState').mockImplementationOnce(async () => {
			const state = await getState();
			// finishBackfill opens and writes KV while this read is on its way back.
			await repository.setStatus('backfilling', 'open');
			await getKVClient().setex(PIONEER_STATE_KV_KEY, PIONEER_STATE_KV_TTL_SECONDS, 'open');
			return state;
		});

		expect(await service.readStatus()).toBe('backfilling');
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(await getKVClient().get(PIONEER_STATE_KV_KEY)).toBe('open');
	});

	it('stop before numbering ever started writes nothing', async () => {
		await makeService().stop();

		expect(await repository.getState()).toBeNull();
	});

	it('finishBackfill still runs the catch-up when its KV write fails', async () => {
		const service = makeService();
		await backfilling();
		const late = await createTestAccount(harness);
		vi.spyOn(getKVClient(), 'setex').mockRejectedValueOnce(new Error('kv down'));

		const metadata = new Map(await service.finishBackfill());

		expect(metadata.get('catch_up_count')).toBe('1');
		expect(await badges.listUserBadges(createUserID(BigInt(late.userId)))).toEqual([
			expect.objectContaining({sequence: 1}),
		]);
	});
});
