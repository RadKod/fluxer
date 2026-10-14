// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {blockUser, createFriendship, updateUserSettings} from '@app/api/channel/tests/ChannelTestUtils';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {FeedDiscoverService} from '@app/api/feed/discover/FeedDiscoverService';
import {feedSuggestionCache} from '@app/api/feed/suggest/FeedSuggestionCache';
import {FeedSuggestionService} from '@app/api/feed/suggest/FeedSuggestionService';
import {seedSuggestionPool} from '@app/api/feed/suggest/tests/FeedSuggestionTestUtils';
import {captureJobs, createPost, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedSuggestionService,
	getFollowRepository,
	getLimitConfigService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import aggregateFeedNotification from '@app/api/worker/tasks/AggregateFeedNotification';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ProfilePrivacyLevels, UserFlags} from '@fluxer/constants/src/UserConstants';
import type {LimitConfigSnapshot, LimitRule} from '@fluxer/limits/src/LimitTypes';
import type {FeedNotificationListResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {types} from 'cassandra-driver';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const SUGGESTIONS_ON: LimitRule = {id: 'test_suggestions_on', limits: {feature_feed_suggestions: 1}};
const minorBirthDate = () => types.LocalDate.fromString(`${new Date().getFullYear() - 10}-06-15`);

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

// PUT /users/:id/follow without post_id, for a caller the profile rule refuses, through this
// process's copy of the feed suggestion pool. Since the public view a standing stranger
// follows a public account before this path: it answers only callers the profile rule refuses and opens nothing for them
// (it needs the same standing and a public account), so what stays to see is which refusal they get.
describe('following an account from the feed suggestion pool', () => {
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
	const follows = async (caller: TestAccount, targetId: string) =>
		(await getFollowRepository().getFollow(createUserID(BigInt(caller.userId)), createUserID(BigInt(targetId)))) !==
		null;
	// Test accounts are brand new: a day later they are old enough for the pool and for a stranger's standing, and a post
	// made before stays inside Keşfet's 72 hours for the post path controls.
	const aDayLater = () => vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});
	const useRules = (...rules: Array<LimitRule>) =>
		vi
			.spyOn(getLimitConfigService(), 'getConfigSnapshot')
			.mockReturnValue({...baseLimits, rules: [...baseLimits.rules, ...rules]});
	const userOf = async (userId: string) => (await getUserRepository().findUnique(createUserID(BigInt(userId))))!;
	// The build's snapshot, as this process reads it; seeded under the faked clock so its version is "now".
	const pool = async (...userIds: Array<string>) => seedSuggestionPool({users: await Promise.all(userIds.map(userOf))});
	const accounts = (count: number) => Promise.all(Array.from({length: count}, () => createTestAccount(harness)));
	async function patchUser(userId: string, patch: Partial<UserRow>) {
		const user = await userOf(userId);
		await getUserRepository().patchUpsert(
			user.id,
			{...patch, ...(patch.flags != null ? {flags: user.flags | patch.flags} : {})},
			user.toRow(),
		);
	}
	// An account made now, under the faked clock: the test snowflake service stamps IDs from its own counter.
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

	it('a stranger follows an account in the suggestion pool without post_id, and the account gets one follow notification', async () => {
		const [target, caller] = (await accounts(2)) as [TestAccount, TestAccount];
		const jobs = captureJobs();
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(target.userId);

		await follow(caller, target.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
		await follow(caller, target.userId, {}).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await follows(caller, target.userId)).toBe(true);

		for (const job of jobs.splice(0)) {
			if (job.task === 'aggregateFeedNotification') await aggregateFeedNotification(job.payload, helpers);
		}
		const inbox = await createBuilder<FeedNotificationListResponse>(harness, target.token)
			.get('/feed/notifications')
			.execute();
		expect(inbox.filter((entry) => entry.type === 'follow')).toEqual([
			expect.objectContaining({actor_count: 1, actors: [expect.objectContaining({id: caller.userId})]}),
		]);
	});

	it("refuses 403 a stranger's follow of an account at shared communities, pooled or not; a public one outside the pool opens on the public view", async () => {
		const [target, closed, closedPooled, caller] = (await accounts(4)) as Array<TestAccount>;
		await setProfileLevel(closed!, ProfilePrivacyLevels.ALL_GUILDS);
		await setProfileLevel(closedPooled!, ProfilePrivacyLevels.ALL_GUILDS);
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(closedPooled!.userId);

		for (const account of [closed!, closedPooled!]) {
			await follow(caller!, account.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			expect(await follows(caller!, account.userId)).toBe(false);
		}
		await follow(caller!, target!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	// Before the pool path existed, such a follow was a plain 403; the caller's own standing matters only for a pooled
	// account, so an unverified caller is never told to verify an email for an account the pool does not list.
	it('answers a plain 403 without an email prompt when the target is not pooled', async () => {
		const [target, pooled] = (await accounts(2)) as [TestAccount, TestAccount];
		const unverified = await createTestAccount(harness, {skipEmailVerification: true});
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(pooled.userId);

		await follow(unverified, target.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		await follow(unverified, pooled.userId)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED)
			.execute();
	});

	// A trait rule only raises a limit, so "off for this caller" is the default rule (0) with a trait rule at 1 for another.
	// Unverified callers: the profile rule refuses them, so the switch shows as a plain 403 where the pool path, reached,
	// asks for the email.
	it('refuses 403 while feature_feed_suggestions is off for the caller, even for a pooled account', async () => {
		const [target] = (await accounts(1)) as [TestAccount];
		const off = await createTestAccount(harness, {skipEmailVerification: true});
		const on = await createTestAccount(harness, {skipEmailVerification: true});
		await patchUser(on.userId, {traits: new Set(['akis_suggestions_on'])});
		aDayLater();
		await pool(target.userId);

		await follow(off, target.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		useRules({
			id: 'test_suggestions_trait',
			filters: {traits: ['akis_suggestions_on']},
			limits: {feature_feed_suggestions: 1},
		});
		await follow(off, target.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		expect(await follows(off, target.userId)).toBe(false);
		await follow(on, target.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED).execute();
	});

	it('refuses a pooled account whose live state changed after the build: privacy narrowed, spammer, disabled, a minor, no date of birth, deleted; suspicious or feed off still opens on the public view', async () => {
		const [caller, control, narrowed, spammer, disabled, suspicious, minor, noBirthDate, noFeed, deleted] =
			(await accounts(10)) as Array<TestAccount>;
		aDayLater();
		const changed = [narrowed!, spammer!, disabled!, suspicious!, minor!, noBirthDate!, noFeed!, deleted!];
		await pool(control!.userId, ...changed.map((account) => account.userId));
		// Only the live rows change; the pool copy still lists every one of them. A new hiding flag broadcasts an eviction
		// (FeedUserLifecycleHooks); this process misses it here, as while it reconnects, so only the live read refuses.
		vi.spyOn(feedSuggestionCache, 'evict').mockImplementation(() => {});
		await updateUserSettings(harness, narrowed!.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});
		await patchUser(spammer!.userId, {flags: UserFlags.SPAMMER});
		await patchUser(disabled!.userId, {flags: UserFlags.DISABLED});
		await patchUser(suspicious!.userId, {flags: UserFlags.ACCOUNT_LIMITED});
		await patchUser(minor!.userId, {date_of_birth: minorBirthDate()});
		await patchUser(noBirthDate!.userId, {date_of_birth: null});
		await patchUser(deleted!.userId, {flags: UserFlags.DELETED});
		for (const account of [caller!, control!, ...changed.filter((account) => account !== noFeed)]) {
			await patchUser(account.userId, {traits: new Set(['akis_feed_on'])});
		}
		useRules(
			SUGGESTIONS_ON,
			{id: 'test_feed_off', limits: {feature_feed: 0}},
			{id: 'test_feed_on', filters: {traits: ['akis_feed_on']}, limits: {feature_feed: 1}},
		);

		// The public view (Tablo 2) asks nothing of the owner's feed or suspicious-activity checks; the pool did.
		const opened = [suspicious!, noFeed!];
		for (const target of changed) {
			expect(getFeedSuggestionService().isPooled(createUserID(BigInt(target.userId)))).toBe(true);
			if (opened.includes(target)) {
				await follow(caller!, target.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
				continue;
			}
			await follow(caller!, target.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			expect(await follows(caller!, target.userId)).toBe(false);
		}
		await follow(caller!, control!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	it('keeps the stranger standing on the pool path: EMAIL_VERIFICATION_REQUIRED when unverified, 403 when younger than a day, unclaimed, spammer or suspicious', async () => {
		const [target, unclaimed, spammer, suspicious, clean] = (await accounts(5)) as Array<TestAccount>;
		const unverified = await createTestAccount(harness, {skipEmailVerification: true});
		await patchUser(unclaimed!.userId, {password_hash: null});
		await patchUser(spammer!.userId, {flags: UserFlags.SPAMMER});
		await patchUser(suspicious!.userId, {flags: UserFlags.ACCOUNT_LIMITED});
		aDayLater();
		const young = await createYoungAccount();
		useRules(SUGGESTIONS_ON);
		await pool(target!.userId);

		await follow(unverified, target!.userId)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED)
			.execute();
		for (const caller of [young, unclaimed!, spammer!, suspicious!]) {
			const {response} = await follow(caller, target!.userId).executeRaw();
			expect(response.status).toBe(HTTP_STATUS.FORBIDDEN);
		}
		for (const caller of [unverified, young, unclaimed!, spammer!, suspicious!]) {
			expect(await follows(caller, target!.userId)).toBe(false);
		}
		await follow(clean!, target!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	// The pool's adult rule shows only to a caller the profile rule refuses (the next test); a standing minor or undated
	// stranger follows a public account on the public view, which asks no viewer age (Tablo 1), as the Keşfet post path
	// never did (decision K).
	it('a standing minor or undated viewer follows a pooled public account on the public view, with or without a post', async () => {
		const [target, minor, noBirthDate, adult] = (await accounts(4)) as Array<TestAccount>;
		const postId = (await createPost(harness, target!, {content: 'açık', public: true}).execute()).id;
		await patchUser(minor!.userId, {date_of_birth: minorBirthDate()});
		await patchUser(noBirthDate!.userId, {date_of_birth: null});
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(target!.userId);
		const isPooled = vi.spyOn(FeedSuggestionService.prototype, 'isPooled');

		for (const viewer of [minor!, noBirthDate!]) {
			await follow(viewer, target!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
			expect(await follows(viewer, target!.userId)).toBe(true);
			await follow(viewer, target!.userId, {post_id: postId}).expect(HTTP_STATUS.NO_CONTENT).execute();
		}
		expect(isPooled).not.toHaveBeenCalled();
		await follow(adult!, target!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	// The age rule comes before the caller's standing, so a minor never learns from an email prompt which accounts the
	// pool lists.
	it('a minor caller gets a plain 403 before any email prompt', async () => {
		const [target] = (await accounts(1)) as [TestAccount];
		const minor = await createTestAccount(harness, {skipEmailVerification: true});
		const undated = await createTestAccount(harness, {skipEmailVerification: true});
		await patchUser(minor.userId, {date_of_birth: minorBirthDate()});
		await patchUser(undated.userId, {date_of_birth: null});
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(target.userId);

		for (const viewer of [minor, undated]) {
			await follow(viewer, target.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		}
	});

	// Unverified callers reach the pool path: a fresh copy lists the account and asks for the email, a stale one does not.
	it("refuses 403 when this process's pool copy is older than 10 minutes", async () => {
		const [target] = (await accounts(1)) as Array<TestAccount>;
		const caller = await createTestAccount(harness, {skipEmailVerification: true});
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(target!.userId);

		vi.setSystemTime(Date.now() + 9 * MINUTE);
		await follow(caller, target!.userId)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED)
			.execute();
		vi.setSystemTime(Date.now() + MINUTE + 1000);
		await follow(caller, target!.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		expect(await follows(caller, target!.userId)).toBe(false);
	});

	it('the pool path never asks Keşfet for a post author', async () => {
		const [target] = (await accounts(1)) as Array<TestAccount>;
		const caller = await createTestAccount(harness, {skipEmailVerification: true});
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(target!.userId);
		const discoverAuthorOf = vi.spyOn(FeedDiscoverService.prototype, 'discoverAuthorOf');
		const isPooled = vi.spyOn(FeedSuggestionService.prototype, 'isPooled');

		await follow(caller, target!.userId)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED)
			.execute();
		expect(isPooled).toHaveBeenCalledTimes(1);
		expect(discoverAuthorOf).not.toHaveBeenCalled();
	});

	// At shared communities the profile rule refuses the standing caller, so the stranger paths answer.
	it('with post_id only the post path counts: a bad post is 403 even for a pooled account', async () => {
		const [target, other, caller] = (await accounts(3)) as Array<TestAccount>;
		await setProfileLevel(target!, ProfilePrivacyLevels.ALL_GUILDS);
		const closed = (await createPost(harness, target!, {content: 'gizli'}).execute()).id;
		const othersPost = (await createPost(harness, other!, {content: 'açık', public: true}).execute()).id;
		const unknown = (await getSnowflakeService().generate()).toString();
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(target!.userId);
		const isPooled = vi.spyOn(FeedSuggestionService.prototype, 'isPooled');

		for (const postId of [closed, othersPost, unknown]) {
			await follow(caller!, target!.userId, {post_id: postId})
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
		}
		expect(isPooled).not.toHaveBeenCalled();
		expect(await follows(caller!, target!.userId)).toBe(false);
		await setProfileLevel(target!, ProfilePrivacyLevels.EVERYONE);
		await follow(caller!, target!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	it('blocks either way, bots, system accounts, yourself and max_following still refuse on the pool path', async () => {
		const [target, blocker, blocked, system, caller] = (await accounts(5)) as Array<TestAccount>;
		const bot = await createTestBotAccount(harness);
		await blockUser(harness, blocker!, target!.userId);
		await blockUser(harness, target!, blocked!.userId);
		await patchUser(system!.userId, {system: true});
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(target!.userId, bot.botUserId, system!.userId, caller!.userId);

		for (const account of [blocker!, blocked!]) {
			await follow(account, target!.userId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			expect(await follows(account, target!.userId)).toBe(false);
		}
		await follow(caller!, bot.botUserId).expect(HTTP_STATUS.FORBIDDEN).execute();
		await follow(caller!, system!.userId).expect(HTTP_STATUS.FORBIDDEN).execute();
		await follow(caller!, caller!.userId).expect(HTTP_STATUS.FORBIDDEN).execute();
		expect(await follows(caller!, bot.botUserId)).toBe(false);
		expect(await follows(caller!, system!.userId)).toBe(false);

		useRules(SUGGESTIONS_ON, {id: 'test_following_cap', limits: {max_following: 0}});
		await follow(caller!, target!.userId).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.MAX_FOLLOWING).execute();
		useRules(SUGGESTIONS_ON);
		await follow(caller!, target!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
	});

	it('the profile, the post list and both follow lists open on the public view and close when the account narrows: a follow is no bond', async () => {
		const [target, caller] = (await accounts(2)) as Array<TestAccount>;
		aDayLater();
		useRules(SUGGESTIONS_ON);
		await pool(target!.userId);
		await follow(caller!, target!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();

		const paths = ['profile', 'posts', 'followers', 'following'];
		for (const path of paths) {
			await createBuilder(harness, caller!.token)
				.get(`/users/${target!.userId}/${path}`)
				.expect(HTTP_STATUS.OK)
				.execute();
		}
		await setProfileLevel(target!, ProfilePrivacyLevels.ALL_GUILDS);
		for (const path of paths) {
			await createBuilder(harness, caller!.token)
				.get(`/users/${target!.userId}/${path}`)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
		}
	});

	it('a friend still follows with or without the pool, and an empty body works as before', async () => {
		const [target, other, pooled, friend] = (await accounts(4)) as Array<TestAccount>;
		for (const account of [target!, other!, pooled!]) await createFriendship(harness, account, friend!);
		aDayLater();
		const isPooled = vi.spyOn(FeedSuggestionService.prototype, 'isPooled');

		await follow(friend!, target!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
		await follow(friend!, other!.userId, {}).expect(HTTP_STATUS.NO_CONTENT).execute();
		// Profile access comes first: a friend the pool path would refuse (no date of birth) never reaches it.
		useRules(SUGGESTIONS_ON);
		await pool(pooled!.userId);
		await patchUser(friend!.userId, {date_of_birth: null});
		await follow(friend!, pooled!.userId).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(isPooled).not.toHaveBeenCalled();
		for (const account of [target!, other!, pooled!]) expect(await follows(friend!, account.userId)).toBe(true);
	});
});
