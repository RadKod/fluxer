// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {
	blockUser,
	leaveGuild,
	setupTestGuildWithMembers,
	updateUserSettings,
} from '@app/api/channel/tests/ChannelTestUtils';
import {type FeedMedia, FeedPostFlags} from '@app/api/database/types/FeedTypes';
import {FeedDiscoverService} from '@app/api/feed/discover/FeedDiscoverService';
import {FeedRepository} from '@app/api/feed/FeedRepository';
import {
	captureJobs,
	createPost,
	followDirectly,
	getHome,
	overrideLimits,
	runFanout,
	setProfileLevel,
} from '@app/api/feed/tests/FeedTestUtils';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {FollowService} from '@app/api/follow/FollowService';
import {Logger} from '@app/api/Logger';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedDiscoverRepository,
	getFeedRepository,
	getFeedTimelineService,
	getFollowRepository,
	getKVCounterService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ProfilePrivacyLevels, UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
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

// A followed author the reader sees only as a public profile (a standing
// stranger of an author whose level is "everyone") shows their public posts only.
describe('home feed: followed authors outside the profile rule', () => {
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

	const homeIds = async (viewer: TestAccount, query = '') =>
		(await getHome(harness, viewer, query).execute()).map((post) => post.id);
	// the public bit is the author's level when posting (100 public, 0 not); the author keeps that level.
	const post = async (author: TestAccount, isPublic: boolean) => {
		await setProfileLevel(author, isPublic ? 100 : 0);
		return (await createPost(harness, author, {content: isPublic ? 'açık' : 'gizli'}).execute()).id;
	};
	// New accounts have no stranger standing (24 hours); readers of a public-only author need it.
	const aDayLater = () => vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});
	const accessVerdict = (viewer: TestAccount, author: TestAccount) =>
		getKVClient().get(`feed:access:${viewer.userId}:${author.userId}`);
	async function addFlag(account: TestAccount, flag: bigint): Promise<void> {
		const id = createUserID(BigInt(account.userId));
		const user = (await getUserRepository().findUnique(id))!;
		await getUserRepository().patchUpsert(id, {flags: user.flags | flag}, user.toRow());
	}
	// A follower in a shared community who stays when the author leaves it.
	async function followerLeftBehind() {
		const {owner: viewer, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const author = members[0]!;
		await createBuilder(harness, viewer.token)
			.put(`/users/${author.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await leaveGuild(harness, author.token, guild.id);
		return {viewer, author};
	}
	// A public post row written into the reader's home feed as the fan-out would, with `media`.
	async function plantPublic(viewer: TestAccount, author: TestAccount, media: Array<FeedMedia>): Promise<string> {
		const postId = await getSnowflakeService().generate();
		const authorId = createUserID(BigInt(author.userId));
		await getFeedRepository().createPost({
			post_id: postId,
			author_id: authorId,
			content: 'açık',
			media,
			edited_at: null,
			flags: FeedPostFlags.PUBLIC,
			like_count: 0,
			comment_count: 0,
		});
		await getFeedRepository().addToHomes([createUserID(BigInt(viewer.userId))], postId, authorId);
		return postId.toString();
	}

	// First: the pulled author poll remembers the latest clock, which the tests below move forward (only Date).
	it('a pulled (celebrity) stranger shows only public posts', async () => {
		const {viewer, author} = await followerLeftBehind();
		const friendsOnly = await createTestAccount(harness);
		await followDirectly(viewer.userId, friendsOnly.userId);
		for (const pulled of [author, friendsOnly]) {
			await getKVCounterService().add(FOLLOWER_COUNT_COUNTER, pulled.userId, 20_000);
		}
		await post(author, false);
		const open = await post(author, true);
		await post(friendsOnly, true);
		await updateUserSettings(harness, friendsOnly.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});
		aDayLater();
		await getFeedTimelineService().refreshCelebrities();

		expect(await homeIds(viewer, '?limit=1')).toEqual([open]);
		expect(await homeIds(viewer)).toEqual([open]);
	});

	it('a stranger followed through a Discover post shows only their public posts in the home feed, and the page still fills', async () => {
		const [author, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
		const listed = await post(author, true);
		vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});
		await createBuilder(harness, viewer.token)
			.put(`/users/${author.userId}/follow`)
			.body({post_id: listed})
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const jobs = captureJobs();
		const closed = await post(author, false);
		const open = await post(author, true);
		await runFanout(jobs);

		expect(await homeIds(viewer, '?limit=1')).toEqual([open]);
		expect(await homeIds(viewer)).toEqual([open]);
		await createBuilder(harness, viewer.token)
			.get(`/feed/posts/${closed}`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
	});

	it('a public author who left the shared community keeps showing their public posts only', async () => {
		const {viewer, author} = await followerLeftBehind();
		const jobs = captureJobs();
		await post(author, false);
		const open = await post(author, true);
		await runFanout(jobs);
		aDayLater();

		expect(await homeIds(viewer)).toEqual([open]);
	});

	it('an author whose level is not public shows a stranger nothing, public posts included (friends only, small communities, shared communities)', async () => {
		const {owner: viewer, members} = await setupTestGuildWithMembers(harness, 1);
		const friendsOnly = members[0]!;
		const smallOnly = await createTestAccount(harness);
		const guildsOnly = await createTestAccount(harness);
		const open = await createTestAccount(harness);
		await createBuilder(harness, viewer.token)
			.put(`/users/${friendsOnly.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		for (const author of [smallOnly, guildsOnly, open]) await followDirectly(viewer.userId, author.userId);
		const jobs = captureJobs();
		await post(friendsOnly, true);
		await post(smallOnly, true);
		await post(guildsOnly, true);
		const shown = await post(open, true);
		await runFanout(jobs);
		await updateUserSettings(harness, friendsOnly.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});
		await updateUserSettings(harness, smallOnly.token, {profile_privacy: ProfilePrivacyLevels.SMALL_GUILDS_ONLY});
		await updateUserSettings(harness, guildsOnly.token, {profile_privacy: ProfilePrivacyLevels.ALL_GUILDS});
		aDayLater();

		expect(await homeIds(viewer)).toEqual([shown]);
	});

	it("a spammer, disabled or suspicious stranger's public posts stay out of the home feed", async () => {
		const viewer = await createTestAccount(harness);
		const [spammer, disabled, suspicious, clean] = await Promise.all(
			Array.from({length: 4}, () => createTestAccount(harness)),
		);
		for (const author of [spammer!, disabled!, suspicious!, clean!]) await followDirectly(viewer.userId, author.userId);
		const jobs = captureJobs();
		for (const author of [spammer!, disabled!, suspicious!]) await post(author, true);
		const shown = await post(clean!, true);
		await runFanout(jobs);
		await addFlag(spammer!, UserFlags.SPAMMER);
		await addFlag(disabled!, UserFlags.DISABLED);
		await addFlag(suspicious!, UserFlags.DISABLED_SUSPICIOUS_ACTIVITY);
		aDayLater();

		expect(await homeIds(viewer)).toEqual([shown]);
	});

	it("keeps the profile access verdict in KV as the profile rule said: '1' the full view, 'p' the public view, '0' otherwise", async () => {
		const {owner: viewer, members} = await setupTestGuildWithMembers(harness, 1);
		const guildMate = members[0]!;
		const [stranger, spammer, friendsOnly] = await Promise.all(
			Array.from({length: 3}, () => createTestAccount(harness)),
		);
		for (const author of [guildMate, stranger!, spammer!, friendsOnly!]) {
			await followDirectly(viewer.userId, author.userId);
		}
		const jobs = captureJobs();
		const fromMate = await post(guildMate, false);
		const fromStranger = await post(stranger!, true);
		await post(spammer!, true);
		await post(friendsOnly!, true);
		await runFanout(jobs);
		await updateUserSettings(harness, friendsOnly!.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});
		await addFlag(spammer!, UserFlags.SPAMMER);
		aDayLater();

		expect((await homeIds(viewer)).sort()).toEqual([fromMate, fromStranger].sort());
		expect(await accessVerdict(viewer, guildMate)).toBe('1');
		expect(await accessVerdict(viewer, stranger!)).toBe('p');
		// A spammer has no public view (the owner side record); Keşfet is judged on every request, never stored.
		expect(await accessVerdict(viewer, spammer!)).toBe('0');
		expect(await accessVerdict(viewer, friendsOnly!)).toBe('0');
	});

	it('feature_feed_discover at 0 turns the home feed back to the profile rule alone', async () => {
		const {viewer, author} = await followerLeftBehind();
		const jobs = captureJobs();
		const open = await post(author, true);
		await runFanout(jobs);
		aDayLater();
		expect(await homeIds(viewer)).toEqual([open]);

		overrideLimits({feature_feed_discover: 0});
		expect(await homeIds(viewer)).toEqual([]);
		expect(await accessVerdict(viewer, author)).toBe('p');
	});

	it('reads each post of a public-only author once per home request', async () => {
		const {viewer, author} = await followerLeftBehind();
		const jobs = captureJobs();
		await post(author, false);
		const open = await post(author, true);
		await runFanout(jobs);
		aDayLater();
		const reads = vi.spyOn(FeedRepository.prototype, 'getPosts');

		expect(await homeIds(viewer)).toEqual([open]);
		const requested = reads.mock.calls.flatMap(([postIds]) => postIds.map(String));
		expect(requested.length).toBe(new Set(requested).size);
		expect(requested).toContain(open);
	});

	it("reads no users row of the reader for the public-only rule: Keşfet's switch comes with the signed-in account", async () => {
		const {viewer, author} = await followerLeftBehind();
		const jobs = captureJobs();
		const open = await post(author, true);
		await runFanout(jobs);
		aDayLater();
		const viewerId = createUserID(BigInt(viewer.userId));
		const reads = vi.spyOn(UserRepository.prototype, 'findUnique');

		expect(await homeIds(viewer)).toEqual([open]);
		// Only signing the request in reads it.
		expect(reads.mock.calls.filter(([userId]) => userId === viewerId)).toHaveLength(1);
	});

	it("keeps Keşfet's moderation on public-only authors (report hides, the media arm); authors under the profile rule keep every post", async () => {
		const {owner: viewer, members} = await setupTestGuildWithMembers(harness, 1);
		const [mate, stranger] = [members[0]!, await createTestAccount(harness)];
		for (const author of [mate, stranger]) await followDirectly(viewer.userId, author.userId);
		const mateHidden = await plantPublic(viewer, mate, []);
		const mateImage = await plantPublic(viewer, mate, [IMAGE]);
		const open = await plantPublic(viewer, stranger, []);
		const hidden = await plantPublic(viewer, stranger, []);
		const withImage = await plantPublic(viewer, stranger, [IMAGE]);
		for (const postId of [hidden, mateHidden]) await getFeedDiscoverRepository().hidePost(BigInt(postId));
		await setProfileLevel(stranger, 100);
		aDayLater();
		const sorted = (ids: Array<string>) => [...ids].sort();

		// feature_feed_discover_media is 0 by default, as on Keşfet. Dropped before the page is cut: it still fills.
		expect(await homeIds(viewer, '?limit=1')).toEqual([open]);
		expect(sorted(await homeIds(viewer))).toEqual(sorted([open, mateHidden, mateImage]));
		overrideLimits({feature_feed_discover_media: 1});
		expect(sorted(await homeIds(viewer))).toEqual(sorted([open, withImage, mateHidden, mateImage]));
	});

	it('a public-only author who blocks the reader, or whom the reader blocked, shows nothing even when the block hook could not drop the follows', async () => {
		const viewer = await createTestAccount(harness);
		const [blocker, blocked, open] = await Promise.all(Array.from({length: 3}, () => createTestAccount(harness)));
		for (const author of [blocker!, blocked!, open!]) await followDirectly(viewer.userId, author.userId);
		const jobs = captureJobs();
		const shown = await post(open!, true);
		for (const author of [blocker!, blocked!]) await post(author, true);
		await runFanout(jobs);
		vi.spyOn(FollowService.prototype, 'removeFollowsBetween').mockRejectedValue(new Error('follow store down'));
		await blockUser(harness, blocker!, viewer.userId);
		await blockUser(harness, viewer, blocked!.userId);
		const following = (await getFollowRepository().getFollowingIds(createUserID(BigInt(viewer.userId)))).map(String);
		expect(following).toEqual(expect.arrayContaining([blocker!.userId, blocked!.userId]));
		aDayLater();
		const blockSetReads = vi.spyOn(FeedDiscoverService.prototype, 'getBlockSet');

		// limit=1 judges the authors in two rounds (the newest first); the block set is read once for the request.
		expect(await homeIds(viewer, '?limit=1')).toEqual([shown]);
		expect(blockSetReads).toHaveBeenCalledTimes(1);
		expect(await homeIds(viewer)).toEqual([shown]);
	});

	// Last: it moves the clock forward (only Date), which the pulled author poll then remembers.
	it('counts the rows dropped for public-only authors in the minute budget log', async () => {
		const {viewer, author} = await followerLeftBehind();
		const jobs = captureJobs();
		await post(author, false);
		await post(author, false);
		const deleted = await post(author, true);
		await post(author, true);
		await runFanout(jobs);
		await createBuilder(harness, author.token)
			.delete(`/feed/posts/${deleted}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const info = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'info');
		const cutLogs = () =>
			(info.mock.calls as Array<Array<unknown>>).filter((call) => call[1] === 'Feed home pages cut by a budget');
		// Past the clock an earlier test moved the service to, so the next minute starts from this call.
		vi.useFakeTimers({now: Date.now() + 26 * HOUR, toFake: ['Date']});
		await getHome(harness, viewer).execute();
		info.mockClear();

		await getHome(harness, viewer).execute();
		expect(cutLogs()).toEqual([]);
		vi.setSystemTime(Date.now() + 61_000);
		await getHome(harness, viewer).execute();

		// Two pages, each dropping the two posts that are not public; the deleted public post is not counted.
		expect(cutLogs()).toEqual([
			[
				{pages: 2, read_budget: 0, author_budget: 0, pulled_author_budget: 0, public_only_dropped: 4},
				'Feed home pages cut by a budget',
			],
		]);
	});
});
