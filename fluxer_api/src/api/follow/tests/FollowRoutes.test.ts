// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {createFriendship, setupTestGuildWithMembers, updateUserSettings} from '@app/api/channel/tests/ChannelTestUtils';
import {ConnectionRepository} from '@app/api/connection/ConnectionRepository';
import {FOLLOWER_COUNT_COUNTER, FOLLOWING_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {FollowRepository} from '@app/api/follow/FollowRepository';
import {UserFollowerBuckets} from '@app/api/follow/FollowTables';
import {counterKey} from '@app/api/infrastructure/KVCounterService';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {
	getFollowRepository,
	getFollowService,
	getKVCounterService,
	getLimitConfigService,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import type {FollowListResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const DAY_MS = 86_400_000;

function follow(
	harness: ApiTestHarness,
	account: TestAccount,
	targetId: string,
	status: number = HTTP_STATUS.NO_CONTENT,
) {
	return createBuilder(harness, account.token).put(`/users/${targetId}/follow`).expect(status);
}

function unfollow(harness: ApiTestHarness, account: TestAccount, targetId: string) {
	return createBuilder(harness, account.token).delete(`/users/${targetId}/follow`).expect(HTTP_STATUS.NO_CONTENT);
}

async function profile(harness: ApiTestHarness, viewer: TestAccount, targetId: string) {
	return createBuilder<UserProfileFullResponse>(harness, viewer.token).get(`/users/${targetId}/profile`).execute();
}

// Walks a list the way the client does: until an empty page.
async function listAll(harness: ApiTestHarness, viewer: TestAccount, path: string, cursorParam: 'before' | 'after') {
	const ids: Array<string> = [];
	let cursor: string | undefined;
	for (;;) {
		const query = cursor ? `?limit=100&${cursorParam}=${cursor}` : '?limit=100';
		const page = await createBuilder<FollowListResponse>(harness, viewer.token).get(`${path}${query}`).execute();
		if (page.length === 0) return ids;
		ids.push(...page.map((entry) => entry.id));
		cursor = cursorParam === 'before' ? page.at(-1)!.id : page.at(-1)!.user.id;
	}
}

describe('follow routes', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('follows and unfollows, with counts on the profile and events only to the follower', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		const dispatch = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');

		await follow(harness, alice, bob.userId).execute();
		await follow(harness, alice, bob.userId).execute();

		expect(await profile(harness, alice, bob.userId)).toMatchObject({
			follower_count: 1,
			following_count: 0,
			is_following: true,
		});
		const own = await profile(harness, alice, alice.userId);
		expect(own).toMatchObject({follower_count: 0, following_count: 1});
		expect(own.is_following).toBeUndefined();

		const followers = await createBuilder<FollowListResponse>(harness, alice.token)
			.get(`/users/${bob.userId}/followers`)
			.execute();
		expect(followers.map((entry) => entry.user.id)).toEqual([alice.userId]);
		const following = await createBuilder<FollowListResponse>(harness, bob.token)
			.get(`/users/${alice.userId}/following`)
			.execute();
		expect(following.map((entry) => entry.user.id)).toEqual([bob.userId]);
		expect(following[0]!.id).toBe(followers[0]!.id);

		await unfollow(harness, alice, bob.userId).execute();
		await unfollow(harness, alice, bob.userId).execute();
		expect(await profile(harness, alice, bob.userId)).toMatchObject({follower_count: 0, is_following: false});

		const aliceId = createUserID(BigInt(alice.userId));
		const events = dispatch.mock.calls.map(([params]) => params);
		expect(events.filter((event) => event.event === 'FOLLOW_CREATE')).toEqual([
			{
				userId: aliceId,
				event: 'FOLLOW_CREATE',
				data: {id: followers[0]!.id, user: expect.objectContaining({id: bob.userId})},
			},
		]);
		expect(events.filter((event) => event.event === 'FOLLOW_DELETE')).toEqual([
			{userId: aliceId, event: 'FOLLOW_DELETE', data: {user_id: bob.userId}},
		]);
	});

	it('checks only profile access on follow and list routes, without reading the profile fields', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		const connectionReads = vi.spyOn(ConnectionRepository.prototype, 'findByUserId');
		await follow(harness, alice, bob.userId).execute();
		await createBuilder<FollowListResponse>(harness, alice.token).get(`/users/${bob.userId}/followers`).execute();
		await createBuilder<FollowListResponse>(harness, alice.token).get(`/users/${bob.userId}/following`).execute();
		expect(connectionReads).not.toHaveBeenCalled();
	});

	it('reads the follow stats row once for both profile counts when KV holds neither', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		await follow(harness, alice, bob.userId).execute();
		for (const namespace of [FOLLOWER_COUNT_COUNTER, FOLLOWING_COUNT_COUNTER]) {
			await getKVClient().del(counterKey(namespace, bob.userId));
		}
		const statsReads = vi.spyOn(FollowRepository.prototype, 'getStats');

		await getFollowService().getProfileFields(createUserID(BigInt(bob.userId)), createUserID(BigInt(alice.userId)));

		expect(statsReads).toHaveBeenCalledTimes(1);
	});

	it('refuses accounts with no shared community or friendship (S-2), bots, yourself and unknown users', async () => {
		const alice = await createTestAccount(harness);
		const stranger = await createTestAccount(harness);
		const bot = await createTestBotAccount(harness);

		await follow(harness, alice, stranger.userId, HTTP_STATUS.FORBIDDEN).execute();
		await createBuilder(harness, alice.token)
			.get(`/users/${stranger.userId}/followers`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		await createBuilder(harness, alice.token)
			.get(`/users/${stranger.userId}/following`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		await follow(harness, alice, bot.botUserId, HTTP_STATUS.FORBIDDEN).execute();
		await follow(harness, alice, alice.userId, HTTP_STATUS.FORBIDDEN).execute();
		await follow(harness, alice, '123456789012345678', HTTP_STATUS.NOT_FOUND).execute();
		expect(await profile(harness, stranger, stranger.userId)).toMatchObject({follower_count: 0});
	});

	it('hides the counts and the lists on a restricted profile', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		await updateUserSettings(harness, bob.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});

		const restricted = await profile(harness, alice, bob.userId);
		expect(restricted.follower_count).toBeUndefined();
		expect(restricted.following_count).toBeUndefined();
		expect(restricted.is_following).toBeUndefined();
		await follow(harness, alice, bob.userId, HTTP_STATUS.FORBIDDEN).execute();
		await createBuilder(harness, alice.token)
			.get(`/users/${bob.userId}/followers`)
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
		await createBuilder(harness, alice.token)
			.get(`/users/${bob.userId}/following`)
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();
	});

	it('answers 400 MAX_FOLLOWING past max_following, also when follows race', async () => {
		const limitConfigService = getLimitConfigService();
		const snapshot = limitConfigService.getConfigSnapshot();
		vi.spyOn(limitConfigService, 'getConfigSnapshot').mockReturnValue({
			...snapshot,
			rules: [...snapshot.rules, {id: 'test_following_cap', limits: {max_following: 2}}],
		});
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 6);

		await follow(harness, alice, members[0]!.userId).execute();
		await follow(harness, alice, members[1]!.userId).execute();
		await follow(harness, alice, members[2]!.userId)
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.MAX_FOLLOWING)
			.execute();
		await unfollow(harness, alice, members[0]!.userId).execute();
		await unfollow(harness, alice, members[1]!.userId).execute();

		const responses = await Promise.all(
			members.map((member) =>
				harness.requestJson({
					path: `/users/${member.userId}/follow`,
					method: 'PUT',
					headers: {Authorization: alice.token},
				}),
			),
		);
		expect(responses.filter((response) => response.status === HTTP_STATUS.NO_CONTENT)).toHaveLength(2);
		expect(responses.filter((response) => response.status === HTTP_STATUS.BAD_REQUEST)).toHaveLength(4);
		expect(await listAll(harness, alice, `/users/${alice.userId}/following`, 'after')).toHaveLength(2);
		expect(await profile(harness, alice, alice.userId)).toMatchObject({following_count: 2});
	});

	it('keeps the counters equal to the rows when one account follows and unfollows 100 times at once', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);

		const responses = await Promise.all(
			Array.from({length: 100}, (_, index) =>
				harness.requestJson({
					path: `/users/${bob.userId}/follow`,
					method: index % 2 === 0 ? 'PUT' : 'DELETE',
					headers: {Authorization: alice.token},
				}),
			),
		);
		expect(responses.map((response) => response.status)).toEqual(Array(100).fill(HTTP_STATUS.NO_CONTENT));

		const row = await getFollowRepository().getFollow(
			createUserID(BigInt(alice.userId)),
			createUserID(BigInt(bob.userId)),
		);
		const expected = row ? 1 : 0;
		expect(await listAll(harness, bob, `/users/${bob.userId}/followers`, 'before')).toHaveLength(expected);
		const counters = getKVCounterService();
		expect(await counters.get(FOLLOWER_COUNT_COUNTER, bob.userId)).toBe(expected);
		expect(await counters.get(FOLLOWING_COUNT_COUNTER, alice.userId)).toBe(expected);
	});

	it('pages 250 followers spread over three daily buckets without gaps or repeats', async () => {
		const target = await createTestAccount(harness);
		const targetId = createUserID(BigInt(target.userId));
		const repository = getFollowRepository();
		const now = Date.now();
		const written: Array<bigint> = [];
		for (let index = 0; index < 250; index++) {
			const followId = createSnowflake({timestamp: now - (index % 3) * DAY_MS, sequence: index});
			written.push(followId);
			await repository.putFollower(targetId, followId, createUserID(10_000n + BigInt(index)));
		}
		// A bucket whose followers all left must not end the walk before the older ones.
		const emptied = createSnowflake({timestamp: now - 5 * DAY_MS, sequence: 1});
		await repository.putFollower(targetId, emptied, createUserID(9_999n));
		await repository.deleteFollower(targetId, emptied);
		const oldest = createSnowflake({timestamp: now - 9 * DAY_MS, sequence: 2});
		await repository.putFollower(targetId, oldest, createUserID(9_998n));
		written.push(oldest);

		const ids = await listAll(harness, target, `/users/${target.userId}/followers`, 'before');
		expect(ids).toEqual(written.sort((a, b) => (a > b ? -1 : 1)).map(String));
	});

	it('writes the follower bucket list row once per bucket, not on every follow', async () => {
		const target = await createTestAccount(harness);
		const targetId = createUserID(BigInt(target.userId));
		const repository = getFollowRepository();
		const bucketWrites = vi.spyOn(UserFollowerBuckets, 'upsertAll');
		const now = Date.now();
		for (let index = 0; index < 5; index++) {
			const followId = createSnowflake({timestamp: now, sequence: index});
			await repository.putFollower(targetId, followId, createUserID(20_000n + BigInt(index)));
		}
		const yesterday = createSnowflake({timestamp: now - DAY_MS, sequence: 9});
		await repository.putFollower(targetId, yesterday, createUserID(20_009n));
		expect(bucketWrites).toHaveBeenCalledTimes(2);
		expect(await listAll(harness, target, `/users/${target.userId}/followers`, 'before')).toHaveLength(6);
	});

	it('lets an account remove a follower', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		await follow(harness, alice, bob.userId).execute();

		await createBuilder(harness, bob.token)
			.delete(`/users/@me/followers/${alice.userId}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await profile(harness, alice, bob.userId)).toMatchObject({follower_count: 0, is_following: false});
		expect(await profile(harness, alice, alice.userId)).toMatchObject({following_count: 0});
	});

	it('removes both directions on account deletion, idempotently, and exports the following list', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const carol = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		await createFriendship(harness, alice, carol);
		await follow(harness, alice, bob.userId).execute();
		await follow(harness, carol, alice.userId).execute();
		const aliceId = createUserID(BigInt(alice.userId));

		const exported = await collectUserHarvestExtensions({userId: aliceId});
		const followExport = exported.find((entry) => entry.name === 'follow')?.data as {
			following: Array<{user_id: string}>;
		};
		expect(followExport.following.map((entry) => entry.user_id)).toEqual([bob.userId]);

		await runUserDeletionHook('follow', {userId: aliceId});
		await runUserDeletionHook('follow', {userId: aliceId});

		expect(await profile(harness, bob, bob.userId)).toMatchObject({follower_count: 0});
		expect(await profile(harness, carol, carol.userId)).toMatchObject({following_count: 0});
		expect(await listAll(harness, bob, `/users/${bob.userId}/followers`, 'before')).toEqual([]);
		expect(await listAll(harness, carol, `/users/${carol.userId}/following`, 'after')).toEqual([]);
	});
});
