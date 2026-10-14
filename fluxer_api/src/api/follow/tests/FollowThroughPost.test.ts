// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {
	blockUser,
	createFriendship,
	setupTestGuildWithMembers,
	updateUserSettings,
} from '@app/api/channel/tests/ChannelTestUtils';
import {type FeedMedia, FeedPostFlags} from '@app/api/database/types/FeedTypes';
import {FeedDiscoverService} from '@app/api/feed/discover/FeedDiscoverService';
import {captureJobs, createPost, type QueuedJob, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {FollowService} from '@app/api/follow/FollowService';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedDiscoverRepository,
	getFeedRepository,
	getFollowRepository,
	getLimitConfigService,
	getProfileAccessService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import aggregateFeedNotification from '@app/api/worker/tasks/AggregateFeedNotification';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ProfilePrivacyLevels, UserFlags} from '@fluxer/constants/src/UserConstants';
import type {LimitConfigSnapshot, LimitRule} from '@fluxer/limits/src/LimitTypes';
import type {FeedNotificationListResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const {EVERYONE, ALL_GUILDS, SMALL_GUILDS_ONLY, FRIENDS_ONLY} = ProfilePrivacyLevels;
const IMAGE: FeedMedia = {
	attachment_id: 1n,
	filename: 'a.png',
	size: 10n,
	description: null,
	width: 10,
	height: 10,
	content_type: 'image/png',
	content_hash: null,
	placeholder: null,
	flags: 0,
	nsfw: false,
};

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

async function runNotificationJobs(jobs: Array<QueuedJob>): Promise<void> {
	for (const job of jobs.splice(0)) {
		if (job.task === 'aggregateFeedNotification') await aggregateFeedNotification(job.payload, helpers);
	}
}

// PUT /users/:id/follow with post_id, for a caller the profile rule refuses. Since the public view
//  a standing stranger follows a public author before this path: it answers only callers the profile
// rule refuses and opens nothing for them (it needs the same standing and a public author), so these tests pin which
// answer they get and that the public view, not the post, decides.
describe('following the author of a public Discover post', () => {
	let harness: ApiTestHarness;
	let baseLimits: LimitConfigSnapshot;

	beforeAll(async () => {
		harness = await createApiTestHarness();
		baseLimits = getLimitConfigService().getConfigSnapshot();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	const follow = (caller: TestAccount, targetId: string, body?: object) => {
		const builder = createBuilder(harness, caller.token).put(`/users/${targetId}/follow`);
		return body === undefined ? builder : builder.body(body);
	};
	const follows = async (caller: TestAccount, target: TestAccount) =>
		(await getFollowRepository().getFollow(
			createUserID(BigInt(caller.userId)),
			createUserID(BigInt(target.userId)),
		)) !== null;
	// Test accounts are brand new: a day later the author may be listed and the caller has a stranger's standing.
	const aDayLater = () => vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});
	const publicPost = async (author: TestAccount) =>
		(await createPost(harness, author, {content: 'açık', public: true}).execute()).id;
	// An account made now, under the faked clock: the test snowflake service stamps IDs from its own counter, so it is
	// pointed at the faked time for this one account and put back where it was.
	async function createYoungAccount(): Promise<TestAccount> {
		const snowflakes = getSnowflakeService() as unknown as {startTimestampMs?: number};
		const saved = snowflakes.startTimestampMs;
		snowflakes.startTimestampMs = Date.now();
		try {
			return await createTestAccount(harness);
		} finally {
			snowflakes.startTimestampMs = saved;
		}
	}
	const useRules = (...rules: Array<LimitRule>) =>
		vi
			.spyOn(getLimitConfigService(), 'getConfigSnapshot')
			.mockReturnValue({...baseLimits, rules: [...baseLimits.rules, ...rules]});
	async function patchUser(account: TestAccount, patch: {flags?: bigint; traits?: Set<string>}) {
		const id = createUserID(BigInt(account.userId));
		const user = (await getUserRepository().findUnique(id))!;
		await getUserRepository().patchUpsert(
			id,
			{
				...(patch.flags !== undefined ? {flags: user.flags | patch.flags} : {}),
				...(patch.traits ? {traits: patch.traits} : {}),
			},
			user.toRow(),
		);
	}

	it('a standing stranger naming a Keşfet post follows its public author on the public view, before the post path, and the author gets one follow notification', async () => {
		const [author, caller] = [await createTestAccount(harness), await createTestAccount(harness)];
		const postId = await publicPost(author);
		const judge = vi.spyOn(FeedDiscoverService.prototype as never, 'judge');
		const jobs = captureJobs();
		aDayLater();

		// The public view lets the standing stranger in (Tablo 2): the post is never judged.
		await follow(caller, author.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();
		await follow(caller, author.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await follows(caller, author)).toBe(true);
		expect(judge).not.toHaveBeenCalled();

		await runNotificationJobs(jobs);
		const inbox = await createBuilder<FeedNotificationListResponse>(harness, author.token)
			.get('/feed/notifications')
			.execute();
		expect(inbox.filter((entry) => entry.type === 'follow')).toEqual([
			expect.objectContaining({actor_count: 1, actors: [expect.objectContaining({id: caller.userId})]}),
		]);
	});

	it('without post_id a stranger is refused by an author at shared communities; a friend follows with or without it, and an empty body works as before', async () => {
		const [author, stranger, friend, other] = [
			await createTestAccount(harness),
			await createTestAccount(harness),
			await createTestAccount(harness),
			await createTestAccount(harness),
		];
		await createFriendship(harness, author, friend);
		await createFriendship(harness, other, friend);
		await setProfileLevel(author, ALL_GUILDS);
		const closed = (await createPost(harness, author, {content: 'gizli'}).execute()).id;
		const discoverAuthorOf = vi.spyOn(FeedDiscoverService.prototype, 'discoverAuthorOf');
		aDayLater();

		await follow(stranger, author.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		await follow(stranger, author.userId, {}).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		expect(discoverAuthorOf).not.toHaveBeenCalled();
		// Profile access comes first: a friend never reaches the post, which here Keşfet would not list.
		await follow(friend, author.userId, {post_id: closed}).expect(HTTP_STATUS.NO_CONTENT).execute();
		await follow(friend, other.userId, {}).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(discoverAuthorOf).not.toHaveBeenCalled();
		expect(await follows(friend, author)).toBe(true);
		expect(await follows(friend, other)).toBe(true);
		expect(await follows(stranger, author)).toBe(false);
	});

	// The post path opens nothing the profile rule refuses: an author out of the public view refuses every post_id alike,
	// a valid one included, so a post ID tells nothing about a post the caller may not see.
	it('refuses with 403 MISSING_ACCESS an author at shared communities whatever the post: not public, deleted, hidden by reports, of another author, unknown or valid', async () => {
		const [author, other, caller] = [
			await createTestAccount(harness),
			await createTestAccount(harness),
			await createTestAccount(harness),
		];
		await setProfileLevel(author, ALL_GUILDS);
		const closed = (await createPost(harness, author, {content: 'gizli'}).execute()).id;
		await setProfileLevel(author, EVERYONE);
		const deleted = await publicPost(author);
		await createBuilder(harness, author.token)
			.delete(`/feed/posts/${deleted}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const hidden = await publicPost(author);
		await getFeedDiscoverRepository().hidePost(BigInt(hidden));
		const othersPost = await publicPost(other);
		const unknown = (await getSnowflakeService().generate()).toString();
		const valid = await publicPost(author);
		await setProfileLevel(author, ALL_GUILDS);
		aDayLater();

		for (const postId of [closed, deleted, hidden, othersPost, unknown, valid]) {
			await follow(caller, author.userId, {post_id: postId})
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
		}
		expect(await follows(caller, author)).toBe(false);
		// The post of the other author is fine for its own author: only the target it names is refused (IDOR).
		await follow(caller, other.userId, {post_id: othersPost}).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	// A trait rule only raises a limit (LimitRuleRuntime takes the higher value), so "off for one account" is the default
	// rule at 0 with a trait rule back at 1 for the others; Keşfet off for the caller alone cannot be set apart from the
	// instance switch that way.
	it("refuses a spammer or disabled author and a caller whose feed is off; the public view asks nothing of the author's feed or age, nor of Keşfet", async () => {
		const [spammer, disabled, noFeed, author, caller] = await Promise.all(
			Array.from({length: 5}, () => createTestAccount(harness)),
		);
		const posts = {
			spammer: await publicPost(spammer!),
			disabled: await publicPost(disabled!),
			noFeed: await publicPost(noFeed!),
			author: await publicPost(author!),
		};
		await patchUser(spammer!, {flags: UserFlags.SPAMMER});
		await patchUser(disabled!, {flags: UserFlags.DISABLED});
		for (const account of [spammer!, disabled!, author!, caller!]) {
			await patchUser(account, {traits: new Set(['akis_feed_on'])});
		}
		aDayLater();
		const young = await createYoungAccount();
		await patchUser(young, {traits: new Set(['akis_feed_on'])});
		const youngPost = await publicPost(young);
		const feedOnlyFor = () =>
			useRules(
				{id: 'test_feed_off', limits: {feature_feed: 0}},
				{id: 'test_feed_on', filters: {traits: ['akis_feed_on']}, limits: {feature_feed: 1}},
			);
		feedOnlyFor();

		const refused = [
			[spammer!, posts.spammer],
			[disabled!, posts.disabled],
		] as const;
		for (const [target, postId] of refused) {
			await follow(caller!, target.userId, {post_id: postId})
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
		}
		// Tablo 2: a standing stranger follows a public account; the feed and age rules were Keşfet's, not the profile's.
		const opened = [
			[noFeed!, posts.noFeed],
			[young, youngPost],
			[author!, posts.author],
		] as const;
		for (const [target, postId] of opened) {
			await follow(caller!, target.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();
		}
		await createBuilder(harness, caller!.token)
			.delete(`/users/${author!.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		await patchUser(caller!, {traits: new Set()});
		await follow(caller!, author!.userId, {post_id: posts.author})
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		expect(await follows(caller!, author!)).toBe(false);

		useRules({id: 'test_discover_off', limits: {feature_feed_discover: 0}});
		await follow(caller!, author!.userId, {post_id: posts.author}).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	it('a post with images under feature_feed_discover_media 0 no longer decides: the public view lets the standing stranger in', async () => {
		const [author, caller] = [await createTestAccount(harness), await createTestAccount(harness)];
		const postId = await getSnowflakeService().generate();
		await getFeedRepository().createPost({
			post_id: postId,
			author_id: createUserID(BigInt(author.userId)),
			content: 'görselli',
			media: [IMAGE],
			edited_at: null,
			flags: FeedPostFlags.PUBLIC,
			like_count: 0,
			comment_count: 0,
		});
		aDayLater();

		await follow(caller, author.userId, {post_id: postId.toString()}).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await follows(caller, author)).toBe(true);
	});

	it("refuses the post path when the author's own profile privacy keeps them out (friends only, small communities, shared communities)", async () => {
		const {owner: author, members} = await setupTestGuildWithMembers(harness, 1);
		const guildMate = members[0]!;
		const caller = await createTestAccount(harness);
		const postId = await publicPost(author);
		aDayLater();

		for (const level of [FRIENDS_ONLY, SMALL_GUILDS_ONLY, ALL_GUILDS]) {
			await updateUserSettings(harness, author.token, {profile_privacy: level});
			await follow(caller, author.userId, {post_id: postId})
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
		}
		// A guild mate the friends-only setting leaves out gets no way around it through the post either.
		await updateUserSettings(harness, author.token, {profile_privacy: FRIENDS_ONLY});
		await follow(guildMate, author.userId, {post_id: postId})
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		expect(await follows(caller, author)).toBe(false);

		// Only the public level opens a stranger's follow (the level now, not the post's bit).
		await updateUserSettings(harness, author.token, {profile_privacy: EVERYONE});
		await follow(caller, author.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	it('refuses a caller without standing: EMAIL_VERIFICATION_REQUIRED when unverified, 403 when younger than 24 hours', async () => {
		const author = await createTestAccount(harness);
		const unverified = await createTestAccount(harness, {skipEmailVerification: true});
		const postId = await publicPost(author);
		aDayLater();
		const young = await createYoungAccount();

		await follow(unverified, author.userId, {post_id: postId})
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED)
			.execute();
		await follow(young, author.userId, {post_id: postId})
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		expect(await follows(unverified, author)).toBe(false);
		expect(await follows(young, author)).toBe(false);
	});

	it('refuses a caller who is a spammer or flagged for suspicious activity', async () => {
		const [author, spammer, suspicious, clean] = await Promise.all(
			Array.from({length: 4}, () => createTestAccount(harness)),
		);
		const postId = await publicPost(author!);
		await patchUser(spammer!, {flags: UserFlags.SPAMMER});
		await patchUser(suspicious!, {flags: UserFlags.ACCOUNT_LIMITED});
		aDayLater();

		for (const caller of [spammer!, suspicious!]) {
			const {response} = await follow(caller, author!.userId, {post_id: postId}).executeRaw();
			expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
			expect(await follows(caller, author!)).toBe(false);
		}
		await follow(clean!, author!.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	it('refuses between accounts that block each other either way, bots and yourself, even with a valid post', async () => {
		const [author, blocker, blocked] = await Promise.all(Array.from({length: 3}, () => createTestAccount(harness)));
		const bot = await createTestBotAccount(harness);
		const postId = await publicPost(author!);
		await blockUser(harness, blocker!, author!.userId);
		await blockUser(harness, author!, blocked!.userId);
		aDayLater();

		for (const caller of [blocker!, blocked!]) {
			await follow(caller, author!.userId, {post_id: postId})
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
			expect(await follows(caller, author!)).toBe(false);
		}
		await follow(blocker!, bot.botUserId, {post_id: postId}).expect(HTTP_STATUS.FORBIDDEN).execute();
		await follow(author!, author!.userId, {post_id: postId}).expect(HTTP_STATUS.FORBIDDEN).execute();
	});

	it('keeps max_following on the post path (400 MAX_FOLLOWING)', async () => {
		const [author, caller] = [await createTestAccount(harness), await createTestAccount(harness)];
		const postId = await publicPost(author);
		aDayLater();
		useRules({id: 'test_following_cap', limits: {max_following: 0}});

		await follow(caller, author.userId, {post_id: postId})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.MAX_FOLLOWING)
			.execute();
		expect(await follows(caller, author)).toBe(false);
	});

	it('answers 400 for a post_id that is not a snowflake', async () => {
		const [author, caller] = [await createTestAccount(harness), await createTestAccount(harness)];
		for (const postId of ['abc', -1, {}]) {
			await follow(caller, author.userId, {post_id: postId}).expect(HTTP_STATUS.BAD_REQUEST).execute();
		}
	});

	it("reads the author's users row once before the follow on the public view: the side record decides, no Keşfet judge (O4)", async () => {
		const [author, caller] = [await createTestAccount(harness), await createTestAccount(harness)];
		const postId = await publicPost(author);
		aDayLater();
		const authorId = createUserID(BigInt(author.userId));
		await getProfileAccessService().sideOf(authorId); // the side record, as a popular author's always is
		const discoverAuthorOf = vi.spyOn(FeedDiscoverService.prototype, 'discoverAuthorOf');
		const followCall = vi.spyOn(FollowService.prototype, 'follow');
		const findUnique = vi.spyOn(UserRepository.prototype, 'findUnique');

		await follow(caller, author.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(discoverAuthorOf).not.toHaveBeenCalled();
		// Up to FollowService.follow (whose FOLLOW_CREATE event reads the user cache): only the follow's own target read.
		const end = followCall.mock.invocationCallOrder[0]!;
		const authorReads = findUnique.mock.calls.filter(
			([userId], index) => findUnique.mock.invocationCallOrder[index]! < end && userId === authorId,
		);
		expect(authorReads).toHaveLength(1);
	});

	it('unfollowing a stranger followed through a post needs no post', async () => {
		const [author, caller] = [await createTestAccount(harness), await createTestAccount(harness)];
		const postId = await publicPost(author);
		aDayLater();
		await follow(caller, author.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();

		await createBuilder(harness, caller.token)
			.delete(`/users/${author.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await follows(caller, author)).toBe(false);
	});

	it('the profile, the post list and the follow lists open on the public view and close when the author narrows: a follow is no bond', async () => {
		const [author, caller] = [await createTestAccount(harness), await createTestAccount(harness)];
		const postId = await publicPost(author);
		aDayLater();
		await follow(caller, author.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();

		const paths = ['profile', 'posts', 'followers', 'following'];
		for (const path of paths) {
			await createBuilder(harness, caller.token)
				.get(`/users/${author.userId}/${path}`)
				.expect(HTTP_STATUS.OK)
				.execute();
		}
		await setProfileLevel(author, ALL_GUILDS);
		for (const path of paths) {
			await createBuilder(harness, caller.token)
				.get(`/users/${author.userId}/${path}`)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
		}
	});
});
