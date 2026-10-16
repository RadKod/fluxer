// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {FeedSuggestionRepository} from '@app/api/feed/suggest/FeedSuggestionRepository';
import {captureJobs, followDirectly, overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {FollowRepository} from '@app/api/follow/FollowRepository';
import {counterPartition} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedSuggestionService,
	getFollowRepository,
	getKVCounterService,
	getLimitConfigService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {UserSettings} from '@app/api/models/UserSettings';
import {getGuildSearchService} from '@app/api/SearchFactory';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {InMemorySearchProvider} from '@app/api/test/search/InMemorySearchProvider';
import {onUserBanned} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {mapUserToPartialResponse} from '@app/api/user/UserMappers';
import type {CronScheduler} from '@app/api/worker/CronScheduler';
import {JOBS_STREAM_MAX_AGE_MS} from '@app/api/worker/JetStreamWorkerQueue';
import backfillFeedSuggestionRanking from '@app/api/worker/tasks/BackfillFeedSuggestionRanking';
import refreshFeedSuggestions from '@app/api/worker/tasks/RefreshFeedSuggestions';
import {registerCronJobs} from '@app/api/worker/WorkerMain';
import {GuildFeatures, GuildNSFWLevel, getEffectiveGuildVerificationLevel} from '@fluxer/constants/src/GuildConstants';
import {ProfilePrivacyLevels, UserFlags} from '@fluxer/constants/src/UserConstants';
import type {SearchableGuild} from '@fluxer/schema/src/contracts/search/SearchDocumentTypes';
import {createSnowflake, snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {types} from 'cassandra-driver';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// The build runs this far ahead, so planted accounts (and their followers) are 100 h old by default.
const AHEAD = 100 * HOUR;
const ADULT = types.LocalDate.fromString('2000-01-01');
const MINOR = types.LocalDate.fromString(`${new Date().getFullYear() - 10}-06-15`);
const RANK_KEY = 'follow:rank:{rank}:followers';
const FLOOR_KEY = 'follow:rank:{rank}:floor';
const FILLED_KEY = 'follow:rank:{rank}:filled';
const BACKFILL_KEY = 'follow:rank:{rank}:backfill';
const BUILD_GATE_KEY = 'feed:suggest:build';
const BUILT = 'Built the feed suggestions';
const EMPTY_WARNING =
	'The follower ranking is empty although it was filled; KV may have lost it, so it is filled again';
const SEARCH_WARNING = 'The community search failed; pooling people without communities';
const LOST_GATE_WARNING = 'A feed suggestion build ran past its gate and another took it; dropping this build';
const FEED_ON = 'akis_feed_on';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

let sequence = 0;
const snowflake = (timestamp: number, workerId = 7) =>
	createSnowflake({timestamp, workerId, sequence: sequence++ % 4096});

function guildDoc(memberCount: number, patch: Partial<SearchableGuild> = {}): SearchableGuild {
	return {
		id: snowflake(Date.now(), 8).toString(),
		ownerId: '1',
		name: `Topluluk ${memberCount}`,
		vanityUrlCode: null,
		iconHash: null,
		bannerHash: null,
		splashHash: null,
		features: ['DISCOVERABLE'],
		verificationLevel: 1,
		mfaLevel: 0,
		nsfwLevel: GuildNSFWLevel.SAFE,
		createdAt: 0,
		memberCount,
		discoveryDescription: 'Herkese açık',
		discoveryCategory: 1,
		discoveryPrimaryLanguage: 'tr',
		discoveryTags: ['oyun'],
		isDiscoverable: true,
		...patch,
	};
}

// the minute build of the suggestion pool, the follower ranking it keeps and the
// backfill it queues (DOLDURMA).
describe('feed suggestion build', () => {
	let harness: ApiTestHarness;
	let fans: Array<User>;
	const kv = () => getKVClient();
	const repository = () => new FeedSuggestionRepository(getKVClient());
	const snapshot = async () => (await repository().getSnapshot())!;
	const poolIds = async () => (await snapshot()).users.map((user) => user.id);
	const ids = (...users: Array<User>) => users.map((user) => user.id.toString());
	const ranked = () => kv().zrangebyscore(RANK_KEY, '-inf', '+inf');
	const rankedAt = (count: number) => kv().zrangebyscore(RANK_KEY, -count, -count);
	const search = () => getGuildSearchService()!;
	const logSpy = (level: 'info' | 'warn') => vi.spyOn(Logger.child({}) as unknown as NoopLogger, level);
	// Stops Date where it is, for exact TTLs (the KV mock rounds the remaining seconds down).
	const freeze = () => vi.useFakeTimers({now: Date.now(), toFake: ['Date']});

	// The 50 s build gate is cleared first so it does not carry over from the previous build.
	async function build(now = Date.now() + AHEAD): Promise<number> {
		await kv().del(BUILD_GATE_KEY);
		return getFeedSuggestionService().buildSnapshot(now);
	}

	// A users row written straight to the repository, `ageMs` old when the build runs; worker 7 keeps the ID apart. Its
	// profile is public (the pool takes public profiles only), as an account of 16 or older starts.
	async function plant(patch: Partial<UserRow> = {}, ageMs = AHEAD): Promise<User> {
		const id = createUserID(snowflake(Date.now() + AHEAD - ageMs));
		await getUserRepository().upsertSettings({
			...UserSettings.getDefaultUserSettings({userId: id, locale: 'en-US', isAdult: true}),
			profile_privacy: ProfilePrivacyLevels.EVERYONE,
		});
		return getUserRepository().create({
			...EMPTY_USER_ROW,
			user_id: id,
			username: `oneri${sequence}`,
			discriminator: 1,
			version: 1,
			email_verified: true,
			password_hash: 'hash',
			date_of_birth: ADULT,
			...patch,
		});
	}

	// `count` followers in KV and in the ranking, as the counter flush leaves them, and follow rows for the sample.
	async function rank(user: User, count: number, followers: Array<User> = fans): Promise<void> {
		await getKVCounterService().add(FOLLOWER_COUNT_COUNTER, user.id.toString(), count);
		await getFollowRepository().rankFollowers([[user.id, count]]);
		for (const follower of followers) await followDirectly(follower.id.toString(), user.id.toString());
	}

	// The start of the first UTC day the build may run on with planted accounts at least 100 h old all day.
	const firstFullDay = () => Math.ceil((Date.now() + AHEAD) / DAY) * DAY;

	// A follow row stamped at `timestamp`, so a test can place followers in an account's past.
	async function followAt(follower: User, target: User, timestamp: number): Promise<void> {
		const followId = createSnowflake({timestamp, workerId: 9, sequence: sequence++ % 4096});
		await getFollowRepository().insertFollowing({user_id: follower.id, target_id: target.id, follow_id: followId});
		await getFollowRepository().putFollower(target.id, followId, follower.id);
	}

	// Many ranked accounts at once, without followers; bots by default, so the build skips them without a read.
	async function plantRanked(counts: Array<number>, patch: Partial<UserRow> = {bot: true}): Promise<Array<User>> {
		const users = await Promise.all(counts.map(() => plant(patch)));
		await getFollowRepository().rankFollowers(users.map((user, index) => [user.id, counts[index]!]));
		await Promise.all(
			users.map((user, index) => getKVCounterService().add(FOLLOWER_COUNT_COUNTER, user.id.toString(), counts[index]!)),
		);
		return users;
	}

	// feature_feed off by default and on for accounts with the trait: the one way to turn it off for a single account
	// (a trait rule can only raise a limit).
	function feedOnlyForTrait(): void {
		vi.restoreAllMocks();
		const base = getLimitConfigService().getConfigSnapshot();
		vi.spyOn(getLimitConfigService(), 'getConfigSnapshot').mockReturnValue({
			...base,
			rules: [
				...base.rules,
				{id: 'test_suggest_on', limits: {feature_feed_suggestions: 1, feature_feed: 0}},
				{id: 'test_feed_on', filters: {traits: [FEED_ON]}, limits: {feature_feed: 1}},
			],
		});
	}

	// Shared communities, the level most existing accounts read as.
	async function narrowProfile(user: User): Promise<void> {
		await getUserRepository().patchSettings(user.id, {profile_privacy: ProfilePrivacyLevels.ALL_GUILDS});
	}

	beforeAll(async () => {
		harness = await createApiTestHarness({search: 'enabled'});
	});
	beforeEach(async () => {
		await harness.reset();
		await search().deleteAllDocuments();
		overrideLimits({feature_feed_suggestions: 1});
		// Filled, as the backfill leaves it; the tests of the backfill itself start from an unfilled ranking.
		await getFollowRepository().finishFollowerRankBackfill();
		fans = [await plant({traits: new Set([FEED_ON])}), await plant({traits: new Set([FEED_ON])})];
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('pools the most followed accounts that pass every rule, at most 100, as partial users', async () => {
		const accounts: Array<User> = [];
		for (let index = 0; index < 105; index++) {
			const user = await plant();
			await rank(user, 1000 - index);
			accounts.push(user);
		}

		expect(await build()).toBe(100);
		const {users} = await snapshot();
		expect(users.map((user) => user.id)).toEqual(ids(...accounts.slice(0, 100)));
		expect(users[0]).toEqual(mapUserToPartialResponse(accounts[0]!));
	});

	it('keeps out bots, system accounts, minors, accounts without a date of birth, unverified or unclaimed, spammers, suspicious, disabled, younger than a day, feed off and a profile that is not public', async () => {
		feedOnlyForTrait();
		const traits = new Set([FEED_ON]);
		const fit = await plant({traits});
		const narrow = await plant({traits});
		await narrowProfile(narrow);
		const out = [
			await plant({traits, bot: true}),
			await plant({traits, system: true}),
			await plant({traits, date_of_birth: MINOR}),
			await plant({traits, date_of_birth: null}),
			await plant({traits, email_verified: false}),
			await plant({traits, password_hash: null}),
			await plant({traits, flags: UserFlags.SPAMMER}),
			await plant({traits, flags: UserFlags.ACCOUNT_LIMITED}),
			await plant({traits, flags: UserFlags.DISABLED}),
			await plant({traits}, 23 * HOUR),
			await plant(),
			narrow,
		];
		await rank(fit, 100);
		for (const [index, user] of out.entries()) await rank(user, 99 - index);

		expect(await build()).toBe(1);
		expect(await poolIds()).toEqual(ids(fit));
		// Skipped, not dropped: an account that becomes fit again needs no new follow to come back.
		expect(await ranked()).toHaveLength(out.length + 1);
	});

	it('keeps out an account whose newest followers are mostly new or flagged accounts (sample)', async () => {
		const young = await plant({}, 24 * HOUR);
		const flagged = await plant({flags: UserFlags.SPAMMER});
		const [ring, half, lone] = [await plant(), await plant(), await plant()];
		await rank(ring, 10, [fans[0]!, young, flagged]);
		await rank(half, 9, [fans[0]!, young]);
		await rank(lone, 8, []);

		await build();
		expect(await poolIds()).toEqual(ids(half));
	});

	it('keeps out an account whose newest followers pass but older followers do not', async () => {
		const clean = await Promise.all(Array.from({length: 120}, () => plant()));
		const flagged = await Promise.all(Array.from({length: 60}, () => plant({flags: UserFlags.SPAMMER})));
		const [ring, steady, lately] = [await plant(), await plant(), await plant()];
		// The second window ends at a moment between an account's opening and the start of the build's UTC day, so
		// follows made right after the opening are always in it and follows made later that day never are.
		const day = firstFullDay();
		const bornAt = (user: User) => snowflakeToDate(user.id).getTime();
		const lateInDay = day + 11 * HOUR;
		// ring: flagged followers from its first moment, 60 clean ones lately; its newest 100 are 60 % clean.
		for (const follower of flagged) await followAt(follower, ring, bornAt(ring) + 1);
		for (const follower of clean.slice(0, 60)) await followAt(follower, ring, lateInDay);
		// steady: clean followers all along.
		for (const follower of clean.slice(0, 60)) await followAt(follower, steady, bornAt(steady) + 1);
		for (const follower of clean.slice(60)) await followAt(follower, steady, lateInDay);
		// lately: every follower came today; before the sampled moment there is none to judge.
		for (const follower of clean) await followAt(follower, lately, lateInDay);
		for (const account of [ring, steady, lately]) await rank(account, 120, []);

		await build(day + 12 * HOUR);
		expect(await poolIds()).toEqual(ids(steady));
	});

	it('keeps the same second-window moment for an account within a day', async () => {
		const account = await plant();
		const clean = await Promise.all(Array.from({length: 101}, () => plant()));
		for (const follower of clean) await followAt(follower, account, snowflakeToDate(account.id).getTime() + 1);
		await rank(account, 101, []);
		const list = vi.spyOn(FollowRepository.prototype, 'listFollowers');
		const moment = async (now: number): Promise<bigint> => {
			list.mockClear();
			await build(now);
			const second = list.mock.calls.find(([, options]) => options.before !== undefined);
			return second![1].before!;
		};
		const day = firstFullDay();

		const morning = await moment(day + HOUR);
		expect(await poolIds()).toEqual(ids(account));
		expect(await moment(day + 20 * HOUR)).toBe(morning);
		expect(await moment(day + DAY + HOUR)).not.toBe(morning);
	});

	it('keeps out an account under feed_suggestions_min_followers, and pools it once the floor is lowered', async () => {
		overrideLimits({feed_suggestions_min_followers: 5});
		const [under, over] = [await plant(), await plant()];
		await rank(under, 4);
		await rank(over, 6);

		await build();
		expect(await poolIds()).toEqual(ids(over));
		expect(await ranked()).toEqual(ids(over));
		expect(await kv().get(FLOOR_KEY)).toBe('5');

		overrideLimits({feed_suggestions_min_followers: 3});
		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('3');
		// Its next count change reaches the flush, which ranks it from the lowered floor.
		await getKVCounterService().add(FOLLOWER_COUNT_COUNTER, under.id.toString(), 0);
		await getKVCounterService().flushPartition(counterPartition(FOLLOWER_COUNT_COUNTER, under.id.toString()), 1000);
		expect(await rankedAt(4)).toEqual(ids(under));
		await build();
		expect(await poolIds()).toEqual(ids(over, under));
	});

	it('treats a floor below 1 as 1', async () => {
		overrideLimits({feed_suggestions_min_followers: 0});
		const [one, none] = [await plant(), await plant()];
		await rank(one, 1);
		await rank(none, 0);

		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('1');
		expect(await poolIds()).toEqual(ids(one));
		expect(await ranked()).toEqual(ids(one));
	});

	it('rescores the ranking with current counts, drops deleted and gone accounts and those under the floor', async () => {
		const [grown, shrunk, deleted, under] = [
			await plant(),
			await plant(),
			await plant({flags: UserFlags.DELETED}),
			await plant(),
		];
		const gone = createUserID(snowflake(Date.now()));
		await rank(grown, 10);
		await rank(shrunk, 8);
		await rank(deleted, 7);
		await rank(under, 1);
		// Stored scores gone stale: the build reads the counters.
		await getFollowRepository().rankFollowers([
			[grown.id, 3],
			[shrunk.id, 50],
			[gone, 40],
		]);

		await build();
		expect(await ranked()).toEqual(ids(grown, shrunk));
		expect(await rankedAt(10)).toEqual(ids(grown));
		expect(await rankedAt(8)).toEqual(ids(shrunk));
	});

	it('a deleted account ranked again by a late flush is dropped by the next build', async () => {
		const [deleted, kept] = [await plant(), await plant()];
		await rank(deleted, 9);
		await rank(kept, 5);
		await getFollowRepository().deleteFollowerData(deleted.id);
		await getUserRepository().patchUpsert(deleted.id, {flags: deleted.flags | UserFlags.DELETED}, deleted.toRow());
		expect(await ranked()).toEqual(ids(kept));
		// Its dirty counter reached a flush after the deletion.
		await getFollowRepository().rankFollowers([[deleted.id, 9]]);

		await build();
		expect(await ranked()).toEqual(ids(kept));
	});

	it('drops a permanently banned account from the ranking even after a later flush ranked it again', async () => {
		const now = Date.now();
		const banned = await plant({flags: UserFlags.DISABLED, temp_banned_until: new Date(now + 100 * 365 * 24 * HOUR)});
		const timed = await plant({flags: UserFlags.DISABLED, temp_banned_until: new Date(now + 30 * 24 * HOUR)});
		const kept = await plant();
		await rank(banned, 9);
		await rank(timed, 8);
		await rank(kept, 5);
		await onUserBanned({userId: banned.id});
		await getFollowRepository().rankFollowers([[banned.id, 9]]);

		await build();
		// A timed ban stays ranked and is only skipped, so it comes back without a new follow once the ban ends.
		expect(await ranked()).toEqual(ids(timed, kept));
		expect(await poolIds()).toEqual(ids(kept));
	});

	it('writes the admin floor while the ranking holds fewer than 1000, and the 1000th count once it is full', async () => {
		freeze();
		const small = await plant();
		await rank(small, 7);
		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('2');
		expect(await kv().ttl(FLOOR_KEY)).toBe(600);

		await plantRanked(Array.from({length: 1000}, (_, index) => 2000 - index));
		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('1001');
		expect(await ranked()).not.toContain(small.id.toString());
	});

	it('keeps the floor when one ranked account drops out', async () => {
		const bots = await plantRanked(Array.from({length: 1000}, (_, index) => 2000 - index));
		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('1001');

		const lowest = bots.at(-1)!;
		await getUserRepository().patchUpsert(lowest.id, {flags: UserFlags.DELETED}, lowest.toRow());
		await build();
		expect(await kv().zcard(RANK_KEY)).toBe(999);
		expect(await kv().get(FLOOR_KEY)).toBe('1002');
		// Nor on the build after, with 999 ranked and no newcomer.
		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('1002');
	});

	it('falls back to the admin floor when many ranked accounts drop out', async () => {
		const bots = await plantRanked(Array.from({length: 1000}, (_, index) => 2000 - index));
		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('1001');

		// 150 gone: the 850 left are under 90 % of the ranking, so the floor is no longer their lowest count.
		for (const bot of bots.slice(0, 150)) {
			await getUserRepository().patchUpsert(bot.id, {flags: UserFlags.DELETED}, bot.toRow());
		}
		await build();
		expect(await kv().zcard(RANK_KEY)).toBe(850);
		expect(await kv().get(FLOOR_KEY)).toBe('2');
	});

	it('trims the ranking to 1000 every build', async () => {
		const top = await plant();
		await rank(top, 5000);
		await getFollowRepository().rankFollowers(
			Array.from({length: 1200}, () => [createUserID(snowflake(Date.now())), 10] as [UserID, number]),
		);
		const list = vi.spyOn(FollowRepository.prototype, 'listRankedFollowers');
		const info = logSpy('info');

		await build();
		expect(info).toHaveBeenCalledWith(expect.objectContaining({ranked: 1201, pruned: 201}), BUILT);
		expect(list).toHaveBeenCalledWith(1000);
		expect(await ranked()).toEqual(ids(top));
	});

	it('pools the biggest approved Discovery communities, without age restricted ones or ones with invites off, at most 100', async () => {
		const good = Array.from({length: 101}, (_, index) => guildDoc(1000 - index));
		await search().indexDocuments([
			...good,
			guildDoc(9000, {nsfwLevel: GuildNSFWLevel.AGE_RESTRICTED}),
			guildDoc(8000, {features: ['DISCOVERABLE', GuildFeatures.INVITES_DISABLED]}),
			guildDoc(7000, {isDiscoverable: false}),
		]);
		vi.spyOn(NoopGatewayService.prototype, 'getDiscoveryGuildCounts').mockResolvedValue(
			new Map([[BigInt(good[0]!.id) as GuildID, {memberCount: 1000, onlineCount: 42}]]),
		);

		await build();
		const {guilds} = await snapshot();
		// The search takes the top 100 approved, safe ones; the one with invites off is among them and is left out.
		expect(guilds.map((guild) => guild.id)).toEqual(good.slice(0, 99).map((guild) => guild.id));
		expect(guilds[0]).toEqual({
			id: good[0]!.id,
			name: 'Topluluk 1000',
			icon: null,
			banner: null,
			description: 'Herkese açık',
			category_type: 1,
			primary_language: 'tr',
			custom_tags: ['oyun'],
			member_count: 1000,
			online_count: 42,
			features: ['DISCOVERABLE'],
			verification_level: getEffectiveGuildVerificationLevel(1, true),
		});
		expect(guilds[1]!.online_count).toBe(0);
	});

	it('pools no community while discovery is off or search is unavailable, and still pools people', async () => {
		const person = await plant();
		await rank(person, 5);
		await search().indexDocuments([guildDoc(100)]);
		await build();
		expect((await snapshot()).guilds).toHaveLength(1);

		const enabled = Config.discovery.enabled;
		Config.discovery.enabled = false;
		try {
			await build();
		} finally {
			Config.discovery.enabled = enabled;
		}
		expect((await snapshot()).guilds).toEqual([]);
		expect(await poolIds()).toEqual(ids(person));

		vi.spyOn(InMemorySearchProvider.prototype, 'getGuildSearchService').mockReturnValue(null as never);
		await build();
		expect((await snapshot()).guilds).toEqual([]);
		expect(await poolIds()).toEqual(ids(person));
	});

	it('a failing community search still pools people', async () => {
		const person = await plant();
		await rank(person, 5);
		await search().indexDocuments([guildDoc(100)]);
		vi.spyOn(search(), 'searchGuilds').mockRejectedValue(new Error('search timed out'));
		const warn = logSpy('warn');

		expect(await build()).toBe(1);
		expect(await poolIds()).toEqual(ids(person));
		expect((await snapshot()).guilds).toEqual([]);
		expect(warn).toHaveBeenCalledWith(expect.objectContaining({error: expect.any(Error)}), SEARCH_WARNING);
	});

	it('stops the ranking while feature_feed_suggestions is off: deletes the floor, writes an empty pool, keeps the filled mark', async () => {
		const person = await plant();
		await rank(person, 5);
		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('2');
		expect(await poolIds()).toEqual(ids(person));

		vi.restoreAllMocks();
		const jobs = captureJobs();
		expect(await build()).toBe(0);
		expect(await kv().get(FLOOR_KEY)).toBeNull();
		expect(await snapshot()).toEqual({version: expect.any(Number), users: [], guilds: []});
		expect(await kv().get(FILLED_KEY)).toBe('0');
		expect(await ranked()).toEqual(ids(person));
		expect(jobs).toEqual([]);
	});

	it('queues one backfill while the flag is on and the ranking was never filled, and none while one runs or after it finished', async () => {
		freeze();
		await kv().del(FILLED_KEY);
		// Not empty: an empty ranking marked filled is filled again (the requeue test).
		await rank(await plant(), 5);
		const jobs = captureJobs();
		await build();
		expect(jobs).toEqual([{task: 'backfillFeedSuggestionRanking', payload: {page_state: null}}]);
		expect(await kv().ttl(BACKFILL_KEY)).toBe(3600);

		await build();
		expect(jobs).toHaveLength(1);
		await getFollowRepository().finishFollowerRankBackfill();
		await build();
		expect(jobs).toHaveLength(1);

		// A queue that fails leaves no running mark behind, so the next build queues it again.
		await kv().del(FILLED_KEY);
		vi.mocked(NoopWorkerService.prototype.addJob).mockRejectedValueOnce(new Error('queue down'));
		await build();
		expect(await kv().get(BACKFILL_KEY)).toBeNull();
		await build();
		expect(jobs).toHaveLength(2);
	});

	it("the backfill ranks each chunk's top accounts at or above the floor, continues from the page state and marks the ranking filled at the end", async () => {
		freeze();
		await kv().del(FILLED_KEY);
		await getFollowRepository().putFollowerRankFloor(250);
		await getFollowRepository().startFollowerRankBackfill();
		// Half its hour gone: the job renews the running mark.
		vi.setSystemTime(Date.now() + 1_800_000);
		await getFollowRepository().putFollowerRankFloor(250);
		// 25 pages of 100 rows: the first job reads 20 (counts 500..2499), the second the last 5 (counts 0..499).
		const pages = Array.from({length: 25}, (_, page) => ({
			rows: Array.from({length: 100}, (_, row) => {
				const count = page < 20 ? 500 + page * 100 + row : (page - 20) * 100 + row;
				return {user_id: createUserID(1_000_000n + BigInt(page * 100 + row)), follower_count: count};
			}),
			pageState: page < 24 ? String(page + 1) : null,
		}));
		const scan = vi
			.spyOn(FollowRepository.prototype, 'scanFollowerCountsPage')
			.mockImplementation(async (pageState) => pages[Number(pageState ?? 0)]!);
		const jobs = captureJobs();

		await backfillFeedSuggestionRanking({page_state: null}, helpers);
		expect(scan).toHaveBeenCalledTimes(20);
		expect(scan).toHaveBeenLastCalledWith('19', 1000);
		expect(jobs).toEqual([{task: 'backfillFeedSuggestionRanking', payload: {page_state: '20'}}]);
		// Only the job's top 1000 (counts 1500..2499).
		expect(await kv().zcard(RANK_KEY)).toBe(1000);
		expect(await rankedAt(2499)).toHaveLength(1);
		expect(await rankedAt(1500)).toHaveLength(1);
		expect(await rankedAt(1499)).toEqual([]);
		expect(await kv().get(FILLED_KEY)).toBeNull();
		expect(await kv().ttl(BACKFILL_KEY)).toBe(3600);

		await backfillFeedSuggestionRanking(jobs[0]!.payload, helpers);
		expect(jobs).toHaveLength(1);
		// Nothing under the floor: counts 250..499 of the last pages.
		expect(await kv().zcard(RANK_KEY)).toBe(1250);
		expect(await rankedAt(250)).toHaveLength(1);
		expect(await rankedAt(249)).toEqual([]);
		// Filled with the size the ranking had then.
		expect(await kv().get(FILLED_KEY)).toBe('1250');
		expect(await kv().get(BACKFILL_KEY)).toBeNull();
	});

	it('turning feature_feed_suggestions off stops the backfill chain without marking the ranking filled', async () => {
		await kv().del(FILLED_KEY);
		await getFollowRepository().startFollowerRankBackfill();
		const scan = vi
			.spyOn(FollowRepository.prototype, 'scanFollowerCountsPage')
			.mockResolvedValue({rows: [{user_id: createUserID(1_000_001n), follower_count: 50}], pageState: 'more'});
		const jobs = captureJobs();
		await backfillFeedSuggestionRanking({page_state: null}, helpers);
		expect(jobs).toEqual([{task: 'backfillFeedSuggestionRanking', payload: {page_state: 'more'}}]);
		const size = await kv().zcard(RANK_KEY);

		overrideLimits({feature_feed_suggestions: 0});
		scan.mockClear();
		await backfillFeedSuggestionRanking(jobs[0]!.payload, helpers);
		expect(scan).not.toHaveBeenCalled();
		expect(jobs).toHaveLength(1);
		expect(await kv().zcard(RANK_KEY)).toBe(size);
		expect(await kv().get(FILLED_KEY)).toBeNull();
		expect(await kv().get(BACKFILL_KEY)).toBeNull();
	});

	it('writes no floor until the ranking is filled', async () => {
		await kv().del(FILLED_KEY);
		overrideLimits({feed_suggestions_min_followers: 5});
		const person = await plant();
		await rank(person, 6);
		const jobs = captureJobs();

		await build();
		expect(await kv().get(FLOOR_KEY)).toBeNull();
		expect(await poolIds()).toEqual(ids(person));
		// The backfill fills it from the admin floor meanwhile.
		vi.spyOn(FollowRepository.prototype, 'scanFollowerCountsPage').mockResolvedValue({
			rows: [
				{user_id: createUserID(1_000_004n), follower_count: 4},
				{user_id: createUserID(1_000_007n), follower_count: 7},
			],
			pageState: null,
		});
		await backfillFeedSuggestionRanking(jobs[0]!.payload, helpers);
		expect(await rankedAt(7)).toEqual(['1000007']);
		expect(await rankedAt(4)).toEqual([]);

		await build();
		expect(await kv().get(FLOOR_KEY)).toBe('5');
	});

	it('requeues the backfill when the ranking is empty but marked filled', async () => {
		// Filled while it held 1000 accounts: an empty ranking now is a lost one.
		await kv().set(FILLED_KEY, '1000');
		const warn = logSpy('warn');
		const jobs = captureJobs();

		await build();
		expect(warn).toHaveBeenCalledWith({}, EMPTY_WARNING);
		expect(await kv().get(FILLED_KEY)).toBeNull();
		expect(await kv().get(FLOOR_KEY)).toBeNull();
		expect(jobs).toEqual([{task: 'backfillFeedSuggestionRanking', payload: {page_state: null}}]);
	});

	it('an empty ranking after a backfill that found nothing writes the admin floor and queues no second scan', async () => {
		await kv().del(FILLED_KEY);
		await getFollowRepository().startFollowerRankBackfill();
		// Nobody at or above the admin floor yet.
		vi.spyOn(FollowRepository.prototype, 'scanFollowerCountsPage').mockResolvedValue({
			rows: [{user_id: createUserID(1_000_001n), follower_count: 1}],
			pageState: null,
		});
		const jobs = captureJobs();
		await backfillFeedSuggestionRanking({page_state: null}, helpers);
		expect(await kv().get(FILLED_KEY)).toBe('0');
		const warn = logSpy('warn');

		await build();
		await build();
		expect(jobs).toEqual([]);
		expect(warn).not.toHaveBeenCalledWith({}, EMPTY_WARNING);
		expect(await kv().get(FILLED_KEY)).toBe('0');
		expect(await kv().get(FLOOR_KEY)).toBe('2');
	});

	it('one build at a time: a build that lost its gate writes no snapshot (its ranking writes are repeatable)', async () => {
		const person = await plant();
		await rank(person, 5);
		const now = Date.now() + AHEAD;
		expect(await build(now)).toBe(1);
		expect(await getFeedSuggestionService().buildSnapshot(now + 1000)).toBe(-1);

		const later = {version: now + HOUR, users: [], guilds: []};
		const list = FollowRepository.prototype.listRankedFollowers;
		vi.spyOn(FollowRepository.prototype, 'listRankedFollowers').mockImplementationOnce(async function (
			this: FollowRepository,
			limit: number,
		) {
			// This build ran past its 50 s: a later one took the gate and stored a newer snapshot.
			await kv().del(BUILD_GATE_KEY);
			await kv().set(BUILD_GATE_KEY, 'later-build');
			await repository().putSnapshot(later);
			return list.call(this, limit);
		});
		const warn = logSpy('warn');
		await kv().del(BUILD_GATE_KEY);
		expect(await getFeedSuggestionService().buildSnapshot(now + 60_000)).toBe(-1);
		expect(warn).toHaveBeenCalledWith({}, LOST_GATE_WARNING);
		expect((await snapshot()).version).toBe(later.version);
		// Its ranking writes stand; the next build repeats them to the same result.
		expect(await ranked()).toEqual(ids(person));
		expect(await kv().get(FLOOR_KEY)).toBe('2');
		expect(await build()).toBe(1);
		expect(await ranked()).toEqual(ids(person));

		// Lost after its last candidate batch, while the community search ran: no snapshot either.
		const searchGuilds = search().searchGuilds.bind(search());
		vi.spyOn(search(), 'searchGuilds').mockImplementationOnce(async (...args) => {
			await kv().set(BUILD_GATE_KEY, 'later-build');
			await repository().putSnapshot(later);
			return searchGuilds(...args);
		});
		await kv().del(BUILD_GATE_KEY);
		expect(await getFeedSuggestionService().buildSnapshot(now + 120_000)).toBe(-1);
		expect((await snapshot()).version).toBe(later.version);
	});

	it('a build that loses its gate between candidate batches writes no snapshot', async () => {
		for (let index = 0; index < 25; index++) await rank(await plant(), 100 - index);
		const findSettings = UserRepository.prototype.findSettings;
		vi.spyOn(UserRepository.prototype, 'findSettings').mockImplementationOnce(async function (
			this: UserRepository,
			userId: UserID,
		) {
			await kv().del(BUILD_GATE_KEY);
			await kv().set(BUILD_GATE_KEY, 'later-build');
			return findSettings.call(this, userId);
		});
		const samples = vi.spyOn(FollowRepository.prototype, 'listFollowers');
		await repository().putSnapshot({version: 1, users: [], guilds: []});

		expect(await build()).toBe(-1);
		expect((await snapshot()).version).toBe(1);
		// The second batch was never examined.
		expect(samples.mock.calls.length).toBeLessThanOrEqual(20);
	});

	it('examines at most 300 candidates', async () => {
		await plantRanked(
			Array.from({length: 400}, (_, index) => 1000 - index),
			{date_of_birth: MINOR},
		);
		const info = logSpy('info');

		expect(await build()).toBe(0);
		expect(await poolIds()).toEqual([]);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({
				examined: 300,
				sampled: 0,
				pool_users: 0,
				rejected: {unfit: 300, feed_off: 0, privacy: 0, sample: 0},
			}),
			BUILT,
		);
	});

	it('logs how many candidates each rule dropped', async () => {
		feedOnlyForTrait();
		const traits = new Set([FEED_ON]);
		const fit = await plant({traits});
		const narrow = await plant({traits});
		await narrowProfile(narrow);
		const flagged = await plant({flags: UserFlags.SPAMMER});
		await rank(fit, 20);
		await rank(await plant({traits, bot: true}), 19);
		await rank(await plant({traits, date_of_birth: MINOR}), 18);
		await rank(await plant(), 17);
		await rank(narrow, 16);
		await rank(await plant({traits}), 15, [flagged]);
		const info = logSpy('info');

		await build();
		expect(info).toHaveBeenCalledWith(
			{
				ranked: 6,
				pruned: 0,
				removed: 0,
				ranked_kept: 6,
				floor: 2,
				floor_rule: 2,
				examined: 6,
				sampled: 2,
				rejected: {unfit: 2, feed_off: 1, privacy: 1, sample: 1},
				pool_users: 1,
				pool_guilds: 0,
				bytes: expect.any(Number),
				build_ms: expect.any(Number),
			},
			BUILT,
		);
	});

	it('registers the suggestion build every minute', async () => {
		const cron = {upsert: vi.fn()};
		registerCronJobs(cron as unknown as CronScheduler, JOBS_STREAM_MAX_AGE_MS);
		expect(cron.upsert).toHaveBeenCalledWith('refreshFeedSuggestions', 'refreshFeedSuggestions', {}, '20 * * * * *', {
			ledger: false,
		});

		// The task builds at the real now, where a planted account is brand new: no pool yet, but a build ran.
		await rank(await plant(), 5);
		await refreshFeedSuggestions({}, helpers);
		expect((await repository().getSnapshot())?.users).toEqual([]);
		expect(await kv().get(FLOOR_KEY)).toBe('2');
	});
});
