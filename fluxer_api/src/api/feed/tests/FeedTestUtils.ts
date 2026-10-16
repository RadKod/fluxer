// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFollowRepository,
	getKVCounterService,
	getLimitConfigService,
	getProfileAccessCache,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import fanoutFeedPost from '@app/api/worker/tasks/FanoutFeedPost';
import type {FeedPostListResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {vi} from 'vitest';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

export type QueuedJob = {task: string; payload: Record<string, unknown>};

// Records jobs instead of running them, so a test sees exactly what the request path queued.
export function captureJobs(): Array<QueuedJob> {
	const jobs: Array<QueuedJob> = [];
	vi.spyOn(NoopWorkerService.prototype, 'addJob').mockImplementation((async (
		task: string,
		payload: Record<string, unknown>,
	) => {
		jobs.push({task, payload});
		return 0n;
	}) as never);
	return jobs;
}

// Runs the queued fan-out chain the way the feed lane would, one follower page per job.
export async function runFanout(jobs: Array<QueuedJob>): Promise<number> {
	let ran = 0;
	for (let job = jobs.shift(); job; job = jobs.shift()) {
		if (job.task !== 'fanoutFeedPost') continue;
		await fanoutFeedPost(job.payload, helpers);
		ran++;
	}
	return ran;
}

export function overrideLimits(limits: Record<string, number>): void {
	const limitConfigService = getLimitConfigService();
	const snapshot = limitConfigService.getConfigSnapshot();
	vi.spyOn(limitConfigService, 'getConfigSnapshot').mockReturnValue({
		...snapshot,
		rules: [...snapshot.rules, {id: 'test_feed_limits', limits}],
	});
}

// Follow rows without accounts behind them: the fan-out needs only the follower IDs.
export async function seedFollowers(authorId: string, count: number): Promise<Array<UserID>> {
	const followRepository = getFollowRepository();
	const author = createUserID(BigInt(authorId));
	const followers: Array<UserID> = [];
	for (let index = 0; index < count; index++) {
		const follower = createUserID(await getSnowflakeService().generate());
		const followId = await getSnowflakeService().generate();
		await followRepository.insertFollowing({user_id: follower, target_id: author, follow_id: followId});
		await followRepository.putFollower(author, followId, follower);
		followers.push(follower);
	}
	await getKVCounterService().add(FOLLOWER_COUNT_COUNTER, authorId, count);
	return followers;
}

// A follow row written directly, skipping the profile access check of PUT /users/:id/follow.
export async function followDirectly(userId: string, targetId: string): Promise<void> {
	const followRepository = getFollowRepository();
	const user = createUserID(BigInt(userId));
	const target = createUserID(BigInt(targetId));
	const followId = await getSnowflakeService().generate();
	await followRepository.insertFollowing({user_id: user, target_id: target, follow_id: followId});
	await followRepository.putFollower(target, followId, user);
}

/**
 * the server sets a post's public bit from the author's profile level, and a public post reaches
 * strangers only while the author is public (100). Tests set the level they mean, whatever the registration default:
 * straight into the settings row (no settings rate limit), then the cached owner side is dropped as the settings route
 * does.
 */
export async function setProfileLevel(account: TestAccount, level: number): Promise<void> {
	const userId = createUserID(BigInt(account.userId));
	await getUserRepository().patchSettings(userId, {profile_privacy: level});
	await getProfileAccessCache().forgetSide(userId);
}

export function createPost(harness: ApiTestHarness, account: TestAccount, body: object) {
	return createBuilder<FeedPostResponse>(harness, account.token).post('/feed/posts').body(body);
}

export function getHome(harness: ApiTestHarness, account: TestAccount, query = '') {
	return createBuilder<FeedPostListResponse>(harness, account.token).get(`/feed/home${query}`);
}
