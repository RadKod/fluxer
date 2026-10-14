// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getUserCacheService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {
	collectUserHarvestExtensions,
	onUserAccountWritten,
	onUserBanned,
	onUserBlocked,
	registerUserBlockedHook,
	registerUserDeletionHook,
	registerUserHarvestHook,
	runUserDeletionHook,
	scheduleUserDeletionHooks,
	type UserAccountWriteHook,
	type UserBannedHook,
	type UserBlockedHook,
	type UserDeletionHook,
	type UserLifecycleHookName,
} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {blockUser} from '@app/api/user/tests/RelationshipTestUtils';
import {
	deleteAccount,
	setPendingDeletionAt,
	triggerDeletionWorker,
	waitForDeletionCompletion,
} from '@app/api/user/tests/UserTestUtils';
import processUserDeletionHook from '@app/api/worker/tasks/ProcessUserDeletionHook';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const USER_ID = createUserID(1n);
const TARGET_ID = createUserID(2n);

function recordingWorkerService(failFor: ReadonlySet<string> = new Set()) {
	const jobs: Array<{task: string; payload: unknown}> = [];
	const service = {
		addJob: async (task: string, payload: Record<string, unknown>) => {
			if (failFor.has(String(payload.hook))) throw new Error('queue down');
			jobs.push({task, payload});
			return 1n;
		},
		cancelJob: async () => false,
		retryDeadLetterJob: async () => false,
	} as IWorkerService;
	return {service, jobs};
}

function helpers(): WorkerTaskHelpers {
	return {
		logger: new NoopLogger(),
		jobId: 1n,
		addJob: async () => 0n,
		reportProgress: async () => {},
		shouldCancel: async () => false,
		setContextLink: async () => {},
	};
}

describe('user deletion hooks', () => {
	it('queues nothing when no hook is registered', async () => {
		const {service, jobs} = recordingWorkerService();

		await scheduleUserDeletionHooks(USER_ID, service, new Map());

		expect(jobs).toStrictEqual([]);
	});

	it('queues one lifecycle job per hook and keeps going when one cannot be queued', async () => {
		const {service, jobs} = recordingWorkerService(new Set(['follow']));
		const noop: UserDeletionHook = async () => {};
		const hooks = new Map<UserLifecycleHookName, UserDeletionHook>([
			['follow', noop],
			['feed', noop],
		]);

		await expect(scheduleUserDeletionHooks(USER_ID, service, hooks)).resolves.toBeUndefined();

		expect(jobs).toStrictEqual([{task: 'processUserDeletionHook', payload: {userId: '1', hook: 'feed'}}]);
	});

	it('runs the named hook and rethrows its failure so the job is retried', async () => {
		const seen: Array<string> = [];
		const hooks = new Map<UserLifecycleHookName, UserDeletionHook>([
			['feed', async ({userId}) => void seen.push(userId.toString())],
			[
				'follow',
				async () => {
					throw new Error('follow store down');
				},
			],
		]);

		await runUserDeletionHook('feed', {userId: USER_ID}, hooks);
		await expect(runUserDeletionHook('follow', {userId: USER_ID}, hooks)).rejects.toThrow('follow store down');
		await expect(runUserDeletionHook('badges', {userId: USER_ID}, hooks)).rejects.toThrow(
			'Unknown user deletion hook badges',
		);

		expect(seen).toEqual(['1']);
	});

	it('runs a registered hook from the worker task and fails the job when the hook fails', async () => {
		let calls = 0;
		const unregister = registerUserDeletionHook('feed', async ({userId}) => {
			calls++;
			if (userId === TARGET_ID) throw new Error('feed store down');
		});
		try {
			await processUserDeletionHook({userId: '1', hook: 'feed'}, helpers());
			await expect(processUserDeletionHook({userId: '2', hook: 'feed'}, helpers())).rejects.toThrow('feed store down');
		} finally {
			unregister();
		}

		expect(calls).toBe(2);
		await processUserDeletionHook({userId: '1', hook: 'feed'}, helpers()).catch(() => undefined);
		expect(calls).toBe(2); // the test's own hook is gone, whichever 'feed' hook the app restored
	});
});

describe('user harvest hooks', () => {
	it('adds nothing to the data export when no hook is registered', async () => {
		expect(await collectUserHarvestExtensions({userId: USER_ID}, new Map())).toStrictEqual([]);
	});

	it('returns every registered hook document by name and fails the export when a hook fails', async () => {
		const unregister = [
			registerUserHarvestHook('follow', async ({userId}) => ({following: [userId.toString()]})),
			registerUserHarvestHook('feed', async () => ({posts: ['from this test']})),
		];
		// The app registers the Micup feature hooks too (the api test project shares module state), so these checks look
		// only at the documents this test registers.
		try {
			expect(await collectUserHarvestExtensions({userId: USER_ID})).toEqual(
				expect.arrayContaining([
					{name: 'follow', data: {following: ['1']}},
					{name: 'feed', data: {posts: ['from this test']}},
				]),
			);

			unregister.push(
				registerUserHarvestHook('badges', async () => {
					throw new Error('badge store down');
				}),
			);
			await expect(collectUserHarvestExtensions({userId: USER_ID})).rejects.toThrow('badge store down');
		} finally {
			for (const undo of unregister.reverse()) undo();
		}

		const restored = await collectUserHarvestExtensions({userId: USER_ID});
		expect(restored).not.toContainEqual({name: 'follow', data: {following: ['1']}});
		expect(restored).not.toContainEqual({name: 'feed', data: {posts: ['from this test']}});
	});
});

describe('user blocked hooks', () => {
	it('does nothing when no hook is registered', async () => {
		await expect(onUserBlocked({userId: USER_ID, targetId: TARGET_ID}, new Map())).resolves.toBeUndefined();
	});

	it('runs every hook even when one throws, and never throws itself', async () => {
		const seen: Array<string> = [];
		const hooks = new Map<UserLifecycleHookName, UserBlockedHook>([
			[
				'follow',
				async () => {
					throw new Error('follow store down');
				},
			],
			['feed', async ({userId, targetId}) => void seen.push(`${userId}:${targetId}`)],
		]);

		await expect(onUserBlocked({userId: USER_ID, targetId: TARGET_ID}, hooks)).resolves.toBeUndefined();

		expect(seen).toEqual(['1:2']);
	});
});

describe('user lifecycle hooks through the API', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		setWorkerDependenciesForTest({
			kvClient: getKVClient(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
		});
	});
	afterEach(() => {
		clearWorkerDependencies();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function deleteAndProcess(): Promise<{userId: string; hookJobs: Array<unknown>}> {
		const addJob = vi.spyOn(getWorkerService(), 'addJob');
		const account = await createTestAccount(harness);
		await deleteAccount(harness, account.token, account.password);
		await setPendingDeletionAt(harness, account.userId, new Date(Date.now() - 60_000));
		await triggerDeletionWorker(harness);
		await waitForDeletionCompletion(harness, account.userId);
		const hookJobs = addJob.mock.calls
			.filter(([task]) => task === 'processUserDeletionHook')
			.map(([, payload]) => payload);
		return {userId: account.userId, hookJobs};
	}

	// The app registers the Micup feature hooks, so a deletion queues their jobs too: one each, for the deleted account.
	it('queues at most one job per hook for an account deletion, each for the deleted account', async () => {
		const {userId, hookJobs} = await deleteAndProcess();
		const hooks = hookJobs.map((job) => (job as {hook: string}).hook);

		expect(new Set(hooks).size).toBe(hooks.length);
		expect(hookJobs).toStrictEqual(hooks.map((hook) => ({userId, hook})));
	});

	it('queues a job for each registered hook when an account is deleted', async () => {
		const unregister = registerUserDeletionHook('feed', async () => {});
		try {
			const {userId, hookJobs} = await deleteAndProcess();

			expect(hookJobs.filter((job) => (job as {hook: string}).hook === 'feed')).toStrictEqual([{userId, hook: 'feed'}]);
		} finally {
			unregister();
		}
	});

	it('blocks the user even when a blocked hook throws and still runs the other hooks', async () => {
		const blocker = await createTestAccount(harness);
		const target = await createTestAccount(harness);
		const seen: Array<string> = [];
		const unregisterFollow = registerUserBlockedHook('follow', async () => {
			throw new Error('follow store down');
		});
		const unregisterFeed = registerUserBlockedHook('feed', async ({userId, targetId}) => {
			seen.push(`${userId}:${targetId}`);
		});
		try {
			await blockUser(harness, blocker.token, target.userId);
		} finally {
			unregisterFeed();
			unregisterFollow();
		}

		expect(seen).toEqual([`${blocker.userId}:${target.userId}`]);
	});
});

describe('account write and banned hooks', () => {
	const previous = {user_id: USER_ID, email_verified: false} as UserRow;
	const updated = {user_id: USER_ID, email_verified: true} as UserRow;

	it('runs every account write hook with both rows and never throws for a failing one', async () => {
		const seen: Array<string> = [];
		const hooks = new Map<UserLifecycleHookName, UserAccountWriteHook>([
			[
				'badges',
				async (context) => void seen.push(`${context.previous?.email_verified}->${context.updated.email_verified}`),
			],
			[
				'feed',
				async () => {
					throw new Error('boom');
				},
			],
		]);

		await expect(onUserAccountWritten({previous, updated}, hooks)).resolves.toBeUndefined();

		expect(seen).toEqual(['false->true']);
	});

	it('runs every banned hook and never throws for a failing one', async () => {
		const seen: Array<string> = [];
		const hooks = new Map<UserLifecycleHookName, UserBannedHook>([
			['badges', async ({userId}) => void seen.push(userId.toString())],
			[
				'feed',
				async () => {
					throw new Error('boom');
				},
			],
		]);

		await expect(onUserBanned({userId: USER_ID}, hooks)).resolves.toBeUndefined();

		expect(seen).toEqual(['1']);
	});
});
