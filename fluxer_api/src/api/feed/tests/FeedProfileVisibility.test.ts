// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getConfig} from '@app/api/Config';
import {
	blockUser,
	createFriendship,
	setupTestGuildWithMembers,
	updateUserSettings,
} from '@app/api/channel/tests/ChannelTestUtils';
import {FeedPostFlags} from '@app/api/database/types/FeedTypes';
import {
	captureJobs,
	createPost,
	followDirectly,
	getHome,
	overrideLimits,
	runFanout,
} from '@app/api/feed/tests/FeedTestUtils';
import {FollowService} from '@app/api/follow/FollowService';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedDiscoverRepository,
	getFeedRepository,
	getFeedTimelineService,
	getFeedVideoRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {BUNNY_TEST_SETTINGS, fakeBunnyStream} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserChannelRepository} from '@app/api/user/repositories/UserChannelRepository';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {ProfileAccessService} from '@app/api/user/services/ProfileAccessService';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {FeedPostListResponse, FeedVideoUploadResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

// the public bit, the posts list, one post, the home feed and Keşfet
// follow the author's current profile level.
const HOUR = 3_600_000;

describe('feed posts and the author profile level (Kapı 2 Ş2, Ş4)', () => {
	let harness: ApiTestHarness;
	const streamDefault = getConfig().bunnyStream;

	beforeAll(async () => {
		getConfig().bunnyStream = BUNNY_TEST_SETTINGS;
		harness = await createApiTestHarness();
	});
	beforeEach(() => {
		fakeBunnyStream.reset();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		getConfig().bunnyStream = streamDefault;
		await harness?.shutdown();
	});

	// Straight into the rows, so a level the settings route would refuse (100 without a date of birth) can be set up.
	async function setAccount(account: TestAccount, level: number, withoutDateOfBirth = false): Promise<void> {
		const id = createUserID(BigInt(account.userId));
		const repository = getUserRepository();
		if (withoutDateOfBirth) {
			const user = (await repository.findUnique(id))!;
			await repository.patchUpsert(id, {date_of_birth: null}, user.toRow());
		}
		await repository.patchSettings(id, {profile_privacy: level});
	}
	// Through the settings route, so a level change reaches what caches the owner's side.
	const setLevel = (account: TestAccount, level: number) =>
		updateUserSettings(harness, account.token, {profile_privacy: level});
	// A post row as any client would have written it, public bit included (the old client marked posts public at 0).
	async function plant(author: TestAccount, isPublic: boolean): Promise<string> {
		const postId = await getSnowflakeService().generate();
		await getFeedRepository().createPost({
			post_id: postId,
			author_id: createUserID(BigInt(author.userId)),
			content: isPublic ? 'açık' : 'gizli',
			media: null,
			edited_at: null,
			flags: isPublic ? FeedPostFlags.PUBLIC : 0,
			like_count: 0,
			comment_count: 0,
		});
		return postId.toString();
	}
	async function addFlag(account: TestAccount, flag: bigint): Promise<void> {
		const id = createUserID(BigInt(account.userId));
		const user = (await getUserRepository().findUnique(id))!;
		await getUserRepository().patchUpsert(id, {flags: user.flags | flag}, user.toRow());
	}
	// New accounts have no stranger standing (24 hours); a day later they do (posts stay inside their 72 hours).
	const aDayLater = () => vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});
	const listPosts = (viewer: TestAccount, author: TestAccount, query = '') =>
		createBuilder<FeedPostListResponse>(harness, viewer.token).get(`/users/${author.userId}/posts${query}`);
	const ids = (posts: FeedPostListResponse) => posts.map((post) => post.id);

	describe('the public bit (A3-1)', () => {
		const cases: Array<
			[level: number, dateOfBirth: string | null, clientPublic: boolean | undefined, expected: boolean]
		> = [
			[100, '2000-01-01', undefined, true],
			[100, '2000-01-01', false, true], // the client's word is ignored
			[0, '2000-01-01', true, false],
			[2, '2000-01-01', true, false],
			[100, null, true, false], // no date of birth: read as shared communities
		];

		it.each(cases)(
			'level %i, born %s, client public=%s → a post is public: %s',
			async (level, dob, clientPublic, expected) => {
				const author = await createTestAccount(harness);
				await setAccount(author, level, dob === null);
				const body = clientPublic === undefined ? {content: 'merhaba'} : {content: 'merhaba', public: clientPublic};
				expect((await createPost(harness, author, body).execute()).public).toBe(expected);
			},
		);

		it.each(cases)(
			'level %i, born %s, client public=%s → a video is public: %s',
			async (level, dob, clientPublic, expected) => {
				const author = await createTestAccount(harness);
				await setAccount(author, level, dob === null);
				overrideLimits({feature_feed_video: 1});
				const ticket = await createBuilder<FeedVideoUploadResponse>(harness, author.token)
					.post('/feed/videos')
					.body({
						filename: 'clip.mp4',
						file_size: 1000,
						content_type: 'video/mp4',
						content: 'video',
						...(clientPublic === undefined ? {} : {public: clientPublic}),
					})
					.execute();
				const row = await getFeedVideoRepository().get(ticket.id);
				expect((row!.flags & FeedPostFlags.PUBLIC) !== 0).toBe(expected);
			},
		);

		it('a post right after switching to everyone is public: the level is read fresh from the author partition', async () => {
			const author = await createTestAccount(harness);
			await updateUserSettings(harness, author.token, {profile_privacy: 0});
			expect((await createPost(harness, author, {content: 'önce', public: true}).execute()).public).toBe(false);
			await updateUserSettings(harness, author.token, {profile_privacy: 100});
			expect((await createPost(harness, author, {content: 'sonra'}).execute()).public).toBe(true);
		});
	});

	describe('the posts list (A3-2)', () => {
		// Newest first: a public post, then nine that are not, three times over; three older ones that are not public.
		async function mixedPosts(author: TestAccount): Promise<{publicIds: Array<string>; all: Array<string>}> {
			const all: Array<string> = [];
			for (let index = 0; index < 3; index++) all.unshift(await plant(author, false));
			const publicIds: Array<string> = [];
			for (let round = 0; round < 3; round++) {
				for (let index = 0; index < 9; index++) all.unshift(await plant(author, false));
				const id = await plant(author, true);
				all.unshift(id);
				publicIds.unshift(id);
			}
			return {publicIds, all};
		}

		it('a standing stranger reads only the posts marked public, filling a page from up to three pages', async () => {
			const [author, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
			await setLevel(author, 100);
			const {publicIds} = await mixedPosts(author);
			aDayLater();

			const first = await listPosts(stranger, author, '?limit=10').executeRaw();
			expect(first.response.status).toBe(HTTP_STATUS.OK);
			expect(ids(first.json)).toEqual(publicIds);
			// Three raw pages read and rows remain: the short page is not the end.
			const next = first.response.headers.get('X-Next-Before');
			expect(next).not.toBeNull();
			const rest = await listPosts(stranger, author, `?limit=10&before=${next}`).executeRaw();
			expect(rest.json).toEqual([]);
			expect(rest.response.headers.get('X-Next-Before')).toBeNull();
		});

		it('posts marked public at level 0 by the old client open to strangers once the author is public (Epha 14:19)', async () => {
			const [author, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
			await setLevel(author, 0);
			const old = await plant(author, true);
			await plant(author, false);
			aDayLater();

			await listPosts(stranger, author).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			await setLevel(author, 100);
			expect(ids(await listPosts(stranger, author).execute())).toEqual([old]);
		});

		it('the full view reads everything and advances from each raw page cursor', async () => {
			const [author, friend] = [await createTestAccount(harness), await createTestAccount(harness)];
			await createFriendship(harness, author, friend);
			await setLevel(author, 100);
			const {all} = await mixedPosts(author);

			let before: string | null = null;
			for (let offset = 0; offset < all.length; offset += 10) {
				const page = await listPosts(friend, author, `?limit=10${before ? `&before=${before}` : ''}`).executeRaw();
				expect(ids(page.json)).toEqual(all.slice(offset, offset + 10));
				const next = page.response.headers.get('X-Next-Before');
				expect(next).toBe(offset + 10 <= all.length ? all[offset + 9] : null);
				if (before && next) expect(BigInt(next)).toBeLessThan(BigInt(before));
				before = next;
			}
		});

		it('limited, blocked and refused views answer 403 (Ş1, Ş5)', async () => {
			const [onlyMe, friend, open, blocked, closed, stranger] = await Promise.all(
				Array.from({length: 6}, () => createTestAccount(harness)),
			);
			await createFriendship(harness, onlyMe!, friend!);
			await setLevel(onlyMe!, 101);
			await setLevel(open!, 100);
			await blockUser(harness, open!, blocked!.userId);
			await setLevel(closed!, 0);
			aDayLater();

			const refused = (viewer: TestAccount, author: TestAccount) =>
				listPosts(viewer, author).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			await refused(friend!, onlyMe!); // limited
			await refused(blocked!, open!); // a block, though a standing stranger would get the public view
			await refused(stranger!, closed!); // no bond under shared communities
		});

		it('a deleted or disabled author still answers 403 for the list', async () => {
			const [disabled, deleted, friend] = await Promise.all(Array.from({length: 3}, () => createTestAccount(harness)));
			for (const author of [disabled!, deleted!]) {
				await createFriendship(harness, author, friend!);
				await setLevel(author, 100);
				await plant(author, true);
			}
			await addFlag(disabled!, UserFlags.DISABLED);
			await addFlag(deleted!, UserFlags.DELETED);

			for (const author of [disabled!, deleted!]) {
				await listPosts(friend!, author).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			}
		});
	});

	describe('one post, the home feed and Keşfet (A3-3)', () => {
		const getPost = (viewer: TestAccount, postId: string) =>
			createBuilder(harness, viewer.token).get(`/feed/posts/${postId}`);
		const homeIds = async (viewer: TestAccount) => ids(await getHome(harness, viewer).execute());
		const verdict = (viewer: TestAccount, author: TestAccount) =>
			getKVClient().get(`feed:access:${viewer.userId}:${author.userId}`);
		const strangerBudget = () =>
			vi.spyOn(ProfileAccessService.prototype as unknown as {allowStranger: () => Promise<boolean>}, 'allowStranger');
		// A post through the API (its public bit is the author's level), written into the followers' home feeds.
		async function publish(author: TestAccount): Promise<string> {
			const jobs = captureJobs();
			const post = await createPost(harness, author, {content: 'yeni'}).execute();
			await runFanout(jobs);
			return post.id;
		}
		// Test accounts are brand new, so the list is built a day ahead (authors >= 24 h, posts still inside 72 h).
		async function buildKesfet(): Promise<Array<string>> {
			await getKVClient().del('feed:discover:build');
			await getFeedTimelineService().discover.buildSnapshot(Date.now() + 25 * HOUR);
			return (await getFeedDiscoverRepository().getSnapshot())?.entries.map((entry) => entry.post.id) ?? [];
		}

		it('narrowing closes a public post to strangers on the next request (Ş2)', async () => {
			const [owner, stranger, friend] = await Promise.all(Array.from({length: 3}, () => createTestAccount(harness)));
			await createFriendship(harness, owner!, friend!);
			await setLevel(owner!, 100);
			const post = (await createPost(harness, owner!, {content: 'açık'}).execute()).id;
			await getPost(stranger!, post).expect(HTTP_STATUS.OK).execute();

			await setLevel(owner!, 0);
			await getPost(stranger!, post).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			await getPost(friend!, post).expect(HTTP_STATUS.OK).execute();
			// The old client marked posts public at level 0: closed now, open once the owner is public.
			const old = await plant(owner!, true);
			await getPost(stranger!, old).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			await setLevel(owner!, 100);
			await getPost(stranger!, old).expect(HTTP_STATUS.OK).execute();
		});

		it('a public post of a spammer needs the full view (stranger 403, friend 200)', async () => {
			const [owner, stranger, friend] = await Promise.all(Array.from({length: 3}, () => createTestAccount(harness)));
			await createFriendship(harness, owner!, friend!);
			await setLevel(owner!, 100);
			const post = (await createPost(harness, owner!, {content: 'açık'}).execute()).id;
			await addFlag(owner!, UserFlags.SPAMMER);

			await getPost(stranger!, post).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			await getPost(friend!, post).expect(HTTP_STATUS.OK).execute();
		});

		it('a public post of an author who blocks the viewer is not found (404)', async () => {
			const [owner, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
			await setLevel(owner, 100);
			const post = (await createPost(harness, owner, {content: 'açık'}).execute()).id;
			await blockUser(harness, owner, viewer.userId);

			await getPost(viewer, post).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST).execute();
		});

		it('a non-public post is 403 to the public view', async () => {
			const [owner, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
			await setLevel(owner, 100);
			const post = await plant(owner, false);
			aDayLater();

			expect(await listPosts(stranger, owner).execute()).toEqual([]); // the public view, which lists no such post
			await getPost(stranger, post).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		});

		it('a public post read spends no stranger budget; the posts list does (Ş10)', async () => {
			const [owner, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
			await setLevel(owner, 100);
			const post = (await createPost(harness, owner, {content: 'açık'}).execute()).id;
			aDayLater();
			const budget = strangerBudget();

			await getPost(stranger, post).expect(HTTP_STATUS.OK).execute();
			await createBuilder(harness, stranger.token).get(`/feed/posts/${post}/comments`).execute();
			await createBuilder(harness, stranger.token)
				.put(`/feed/posts/${post}/like`)
				.expect(HTTP_STATUS.NO_CONTENT)
				.execute();
			expect(budget).not.toHaveBeenCalled();
			await listPosts(stranger, owner).execute();
			expect(budget).toHaveBeenCalledTimes(1);
		});

		it('Keşfet skips — never kills — a post whose author is no longer public, and a 72 h old-client public post of an author who turns public enters it', async () => {
			const [author, oldClient] = [await createTestAccount(harness), await createTestAccount(harness)];
			await setLevel(author, 100);
			const post = (await createPost(harness, author, {content: 'açık'}).execute()).id;
			await setLevel(oldClient, 0);
			const old = await plant(oldClient, true);
			for (const id of [post, old]) await getFeedDiscoverRepository().rankPost(BigInt(id), 10);
			const ranked = () => getKVClient().zrangebyscore('feed:discover:z', '-inf', '+inf');

			let listed = await buildKesfet();
			expect(listed).toContain(post);
			expect(listed).not.toContain(old);
			await setLevel(author, 0);
			listed = await buildKesfet();
			expect(listed).not.toContain(post);
			// Skipped, not dead: still ranked.
			expect(await ranked()).toEqual(expect.arrayContaining([post, old]));
			await setLevel(author, 100);
			await setLevel(oldClient, 100);
			expect(await buildKesfet()).toEqual(expect.arrayContaining([post, old]));
		});

		it('the home feed drops a cached "p" verdict once the author is not public and a cached "1" once the author is "only me" (denetim 8)', async () => {
			const [stranger, open, friend, closing] = await Promise.all(
				Array.from({length: 4}, () => createTestAccount(harness)),
			);
			await setLevel(open!, 100);
			await setLevel(closing!, 0);
			await createFriendship(harness, closing!, friend!);
			await followDirectly(stranger!.userId, open!.userId);
			await followDirectly(friend!.userId, closing!.userId);
			const fromOpen = await publish(open!);
			const fromClosing = await publish(closing!);
			aDayLater();
			expect(await homeIds(stranger!)).toEqual([fromOpen]);
			expect(await verdict(stranger!, open!)).toBe('p');
			expect(await homeIds(friend!)).toEqual([fromClosing]);
			expect(await verdict(friend!, closing!)).toBe('1');

			await setLevel(open!, 0);
			await setLevel(closing!, 101);
			// The next home page, inside the verdicts' 60 s: the level says no, and the verdicts are not rewritten.
			expect(await homeIds(stranger!)).toEqual([]);
			expect(await homeIds(friend!)).toEqual([]);
			expect(await verdict(stranger!, open!)).toBe('p');
			expect(await verdict(friend!, closing!)).toBe('1');
		});

		it('the home feed spends no stranger budget and reads the viewer side once per page (denetim 3, 15)', async () => {
			const viewer = await createTestAccount(harness);
			const authors = await Promise.all(Array.from({length: 3}, () => createTestAccount(harness)));
			const posted: Array<string> = [];
			for (const author of authors) {
				await setLevel(author, 100);
				await followDirectly(viewer.userId, author.userId);
				posted.unshift(await publish(author));
			}
			aDayLater();
			const viewerId = createUserID(BigInt(viewer.userId));
			const budget = strangerBudget();
			const guildReads = vi.spyOn(UserRepository.prototype, 'getUserGuildIds');
			const channelReads = vi.spyOn(UserChannelRepository.prototype, 'listPrivateChannels');

			expect(await homeIds(viewer)).toEqual(posted);
			expect(budget).not.toHaveBeenCalled();
			expect(guildReads.mock.calls.filter(([userId]) => userId === viewerId)).toHaveLength(1);
			expect(channelReads.mock.calls.filter(([userId]) => userId === viewerId)).toHaveLength(1);
		});

		it('a block hides the author on the next home page even while the follow removal waits for its retry (V-4)', async () => {
			const {owner: viewer, members} = await setupTestGuildWithMembers(harness, 1);
			const author = members[0]!;
			await setLevel(author, 0);
			await followDirectly(viewer.userId, author.userId);
			const post = await publish(author);
			expect(await homeIds(viewer)).toEqual([post]);
			expect(await verdict(viewer, author)).toBe('1');

			vi.spyOn(FollowService.prototype, 'removeFollowsBetween').mockRejectedValue(new Error('follow store down'));
			await blockUser(harness, author, viewer.userId);
			expect(await homeIds(viewer)).toEqual([]);
		});

		// a cached "1" outlives neither a narrowing to friends and mutual follows nor a broken bond.
		it('0 → 2 hides the author from a follower bound only by a shared community on the next home page', async () => {
			const {owner: author, members} = await setupTestGuildWithMembers(harness, 1);
			const member = members[0]!;
			await setLevel(author, 0);
			await followDirectly(member.userId, author.userId);
			const post = await publish(author);
			expect(await homeIds(member)).toEqual([post]);
			expect(await verdict(member, author)).toBe('1');

			await setLevel(author, 2);
			expect(await homeIds(member)).toEqual([]);
		});

		it('an unfriend hides the author on the next home page', async () => {
			const [author, friend] = [await createTestAccount(harness), await createTestAccount(harness)];
			await setLevel(author, 0);
			await createFriendship(harness, author, friend);
			await followDirectly(friend.userId, author.userId);
			const post = await publish(author);
			expect(await homeIds(friend)).toEqual([post]);
			expect(await verdict(friend, author)).toBe('1');

			await createBuilder(harness, friend.token)
				.delete(`/users/@me/relationships/${author.userId}`)
				.expect(HTTP_STATUS.NO_CONTENT)
				.execute();
			expect(await homeIds(friend)).toEqual([]);
		});
	});
});
