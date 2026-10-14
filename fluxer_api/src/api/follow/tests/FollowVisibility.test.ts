// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {blockUser, createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import {feedDayAt} from '@app/api/feed/FeedRepository';
import {followDirectly, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {FollowRepository} from '@app/api/follow/FollowRepository';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {sharedGroupDm, sharedGuild} from '@app/api/user/tests/ProfileTestUtils';
import {sendFriendRequest} from '@app/api/user/tests/RelationshipTestUtils';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import type {FollowListResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const {EVERYONE, ALL_GUILDS, FRIENDS_ONLY, ONLY_ME} = ProfilePrivacyLevels;

// the follow lists open on the full and the public view only. Test accounts are brand
// new: a day later (aDayLater) a clean, verified account has a stranger's standing.
describe('follow lists follow the profile view', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	const aDayLater = () => vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});
	const account = () => createTestAccount(harness);
	const list = (viewer: TestAccount, owner: TestAccount, which: 'followers' | 'following') =>
		createBuilder<FollowListResponse>(harness, viewer.token).get(`/users/${owner.userId}/${which}`);
	const strangerSet = (viewer: TestAccount) => `profile:stranger:${viewer.userId}:${feedDayAt(Date.now())}`;

	it.each([
		['full', 'a friend, level 0', HTTP_STATUS.OK],
		['public', 'a standing stranger, level 100', HTTP_STATUS.OK],
		['limited', 'a shared group DM only, level 0', HTTP_STATUS.FORBIDDEN],
		['blocked', 'a shared guild, the owner blocks the viewer, level 0', HTTP_STATUS.FORBIDDEN], // was 200
		['refused', 'a stranger, level 0', HTTP_STATUS.FORBIDDEN],
	] as const)('%s view (%s) → followers and following %i', async (view, _setup, status) => {
		const [owner, viewer] = [await account(), await account()];
		if (view === 'full') await createFriendship(harness, owner, viewer);
		if (view === 'limited') await sharedGroupDm(harness, owner, viewer);
		if (view === 'blocked') {
			await sharedGuild(harness, owner, viewer);
			await blockUser(harness, owner, viewer.userId);
		}
		aDayLater();
		await setProfileLevel(owner, view === 'public' ? EVERYONE : ALL_GUILDS);

		for (const which of ['followers', 'following'] as const) {
			await list(viewer, owner, which).expect(status).execute();
		}
	});

	it('a list read by a standing stranger spends the daily stranger budget (Ş10)', async () => {
		const [owner, stranger] = [await account(), await account()];
		aDayLater();
		await setProfileLevel(owner, EVERYONE);

		await list(stranger, owner, 'followers').execute();
		await list(stranger, owner, 'following').execute();
		expect(await harness.kvProvider.smembers(strangerSet(stranger))).toEqual([owner.userId]);
	});

	it('marks each row with whether the caller follows it, from one following-list read', async () => {
		const [owner, viewer, followedRow, otherRow] = [await account(), await account(), await account(), await account()];
		await createFriendship(harness, owner, viewer);
		for (const follower of [followedRow, otherRow, viewer]) await followDirectly(follower.userId, owner.userId);
		await followDirectly(viewer.userId, followedRow.userId);
		await followDirectly(owner.userId, followedRow.userId);
		await followDirectly(owner.userId, viewer.userId);
		const getFollow = vi.spyOn(FollowRepository.prototype, 'getFollow');
		const followingReads = vi.spyOn(FollowRepository.prototype, 'getFollowingIds');

		const followers = await list(viewer, owner, 'followers').execute();
		const following = await list(viewer, owner, 'following').execute();

		const marks = (page: FollowListResponse) =>
			Object.fromEntries(page.map((entry) => [entry.user.id, entry.is_following]));
		expect(marks(followers)).toEqual({
			[followedRow.userId]: true,
			[otherRow.userId]: false,
			[viewer.userId]: undefined,
		});
		expect(marks(following)).toEqual({[followedRow.userId]: true, [viewer.userId]: undefined});
		expect(followers.find((entry) => entry.user.id === viewer.userId)).not.toHaveProperty('is_following');
		// No N+1: never a follow row read per listed account, one following-list read per page.
		const rowIds = new Set([followedRow.userId, otherRow.userId]);
		expect(getFollow.mock.calls.filter(([, targetId]) => rowIds.has(targetId.toString()))).toEqual([]);
		expect(followingReads.mock.calls.filter(([userId]) => userId === createUserID(BigInt(viewer.userId)))).toHaveLength(
			2,
		);
	});

	type Setup = (owner: TestAccount, viewer: TestAccount) => Promise<unknown>;
	const none: Setup = async () => {};
	const LEVELS = [EVERYONE, ALL_GUILDS, FRIENDS_ONLY, ONLY_ME] as const;
	const NO = HTTP_STATUS.FORBIDDEN;
	const YES = HTTP_STATUS.NO_CONTENT;

	// New follow behavior by level 100 / 0 / 2 / 101. Standing rows move the clock a day on.
	it.each([
		['a friend', (owner, viewer) => createFriendship(harness, owner, viewer), false, [YES, YES, YES, NO]],
		['a shared guild member', (owner, viewer) => sharedGuild(harness, owner, viewer), false, [YES, YES, NO, NO]],
		[
			'followed back: the owner follows the viewer (Ş7)',
			(owner, viewer) => followDirectly(owner.userId, viewer.userId),
			false,
			[YES, YES, YES, NO],
		],
		[
			'a mutual follow the viewer left, followed again',
			async (owner, viewer) => {
				await followDirectly(owner.userId, viewer.userId);
				await followDirectly(viewer.userId, owner.userId);
				await createBuilder(harness, viewer.token).delete(`/users/${owner.userId}/follow`).expect(YES).execute();
			},
			false,
			[YES, YES, YES, NO],
		],
		[
			'a pending request, with standing',
			(owner, viewer) => sendFriendRequest(harness, viewer.token, owner.userId),
			true,
			[YES, NO, NO, NO],
		],
		[
			'a shared group DM, with standing',
			(owner, viewer) => sharedGroupDm(harness, owner, viewer),
			true,
			[YES, NO, NO, NO],
		],
		[
			'a pending request, without standing',
			(owner, viewer) => sendFriendRequest(harness, viewer.token, owner.userId),
			false,
			[NO, NO, NO, NO],
		],
		[
			'a shared group DM, without standing',
			(owner, viewer) => sharedGroupDm(harness, owner, viewer),
			false,
			[NO, NO, NO, NO],
		],
		['a standing stranger', none, true, [YES, NO, NO, NO]],
		['a stranger without standing', none, false, [NO, NO, NO, NO]],
		[
			'the owner blocks a standing guild mate',
			async (owner, viewer) => {
				await sharedGuild(harness, owner, viewer);
				await blockUser(harness, owner, viewer.userId);
			},
			true,
			[NO, NO, NO, NO],
		],
		[
			'a standing stranger blocks the owner',
			(owner, viewer) => blockUser(harness, viewer, owner.userId),
			true,
			[NO, NO, NO, NO],
		],
	] as Array<[string, Setup, boolean, Array<number>]>)(
		'%s: a new follow under 100 / 0 / 2 / 101',
		async (_row, setup, standing, expected) => {
			const [owner, viewer] = [await account(), await account()];
			await setup(owner, viewer);
			if (standing) aDayLater();
			const statuses: Array<number> = [];
			for (const level of LEVELS) {
				await setProfileLevel(owner, level);
				const {response} = await createBuilder(harness, viewer.token).put(`/users/${owner.userId}/follow`).executeRaw();
				statuses.push(response.status);
				// Unfollowing and removing a follower stay open on every row and level.
				await createBuilder(harness, viewer.token).delete(`/users/${owner.userId}/follow`).expect(YES).execute();
				await createBuilder(harness, owner.token).delete(`/users/@me/followers/${viewer.userId}`).expect(YES).execute();
			}
			expect(statuses).toEqual(expected);
		},
	);

	it('a follow spends no stranger budget (Ş10)', async () => {
		const [owner, stranger] = [await account(), await account()];
		aDayLater();
		await setProfileLevel(owner, EVERYONE);

		await createBuilder(harness, stranger.token).put(`/users/${owner.userId}/follow`).expect(YES).execute();
		expect(await harness.kvProvider.scard(strangerSet(stranger))).toBe(0);
	});

	// The feed switch belongs to the stranger path: a follow back needs neither it nor a stranger's standing.
	it('with the feed off a standing stranger may not follow a public account, but may follow one back that follows it', async () => {
		const [owner, follower, stranger] = [await account(), await account(), await account()];
		await followDirectly(owner.userId, follower.userId);
		aDayLater();
		await setProfileLevel(owner, EVERYONE);
		const limits = getLimitConfigService();
		const snapshot = limits.getConfigSnapshot();
		vi.spyOn(limits, 'getConfigSnapshot').mockReturnValue({
			...snapshot,
			rules: [...snapshot.rules, {id: 'test_feed_off', limits: {feature_feed: 0}}],
		});

		await createBuilder(harness, stranger.token).put(`/users/${owner.userId}/follow`).expect(NO).execute();
		await createBuilder(harness, follower.token).put(`/users/${owner.userId}/follow`).expect(YES).execute();
	});

	it('an "only me" account still shows in the follower list of a public account it follows (Epha 14:19)', async () => {
		const [owner, hidden, stranger] = [await account(), await account(), await account()];
		await followDirectly(hidden.userId, owner.userId);
		aDayLater();
		await setProfileLevel(owner, EVERYONE);
		await setProfileLevel(hidden, ProfilePrivacyLevels.ONLY_ME);

		const followers = await list(stranger, owner, 'followers').execute();
		expect(followers.map((entry) => entry.user.id)).toEqual([hidden.userId]);
	});
});
