// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {blockUser, createGuild} from '@app/api/channel/tests/ChannelTestUtils';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {FeedDiscoverService} from '@app/api/feed/discover/FeedDiscoverService';
import {feedSuggestionCache} from '@app/api/feed/suggest/FeedSuggestionCache';
import {FeedSuggestionService} from '@app/api/feed/suggest/FeedSuggestionService';
import {seedSuggestionPool} from '@app/api/feed/suggest/tests/FeedSuggestionTestUtils';
import {followDirectly, overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {FollowRepository} from '@app/api/follow/FollowRepository';
import {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {getGuildSearchService} from '@app/api/SearchFactory';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {onUserBanned} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {mapUserToPartialResponse} from '@app/api/user/UserMappers';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {FeedSuggestionsResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import {types} from 'cassandra-driver';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

type SuggestedGuild = FeedSuggestionsResponse['guilds'][number];

const HOUR = 3_600_000;
const MINUTE = 60_000;
const ADULT = types.LocalDate.fromString('2000-01-01');
const MINOR = types.LocalDate.fromString(`${new Date().getFullYear() - 15}-06-15`);

function guild(index: number): SuggestedGuild {
	return {
		id: String(1_300_000_000_000_000_000n + BigInt(index)),
		name: `Topluluk ${index}`,
		icon: null,
		banner: null,
		description: null,
		category_type: 0,
		primary_language: null,
		custom_tags: [],
		member_count: 1000 - index,
		online_count: 0,
		features: [],
		verification_level: 0,
	};
}

// GET /feed/suggestions reads this process's pool copy and only the caller's own data.
describe('GET /feed/suggestions', () => {
	let harness: ApiTestHarness;
	const suggestions = (viewer: TestAccount) =>
		createBuilder<FeedSuggestionsResponse>(harness, viewer.token).get('/feed/suggestions');
	const accounts = (count: number) => Promise.all(Array.from({length: count}, () => createTestAccount(harness)));
	const userOf = async (account: TestAccount) =>
		(await getUserRepository().findUnique(createUserID(BigInt(account.userId))))!;
	const userIds = (answer: FeedSuggestionsResponse) => answer.users.map((user) => user.id);
	// Test accounts are brand new: 100 h later they have a stranger's standing and may be in the pool.
	const later = () => vi.useFakeTimers({now: Date.now() + 100 * HOUR, toFake: ['Date']});
	async function pool(people: Array<TestAccount>, guilds: Array<SuggestedGuild> = []): Promise<void> {
		await seedSuggestionPool({users: await Promise.all(people.map(userOf)), guilds});
	}
	async function patchUser(account: TestAccount, patch: Partial<UserRow>): Promise<void> {
		const user = await userOf(account);
		await getUserRepository().patchUpsert(user.id, patch, user.toRow());
	}
	// An account made under the faked clock: the test snowflake service stamps IDs from its own start time.
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
	// A fresh process: shut the old subscription down first, or initialize would find it still stopping.
	async function restartCache(): Promise<void> {
		await feedSuggestionCache.shutdown();
		feedSuggestionCache.resetForTesting();
		feedSuggestionCache.setRefreshSubscriber(getKVClient());
		await feedSuggestionCache.initialize();
	}

	beforeAll(async () => {
		harness = await createApiTestHarness({search: 'enabled'});
	});
	beforeEach(async () => {
		await harness.reset();
		await restartCache();
		overrideLimits({feature_feed_suggestions: 1});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await feedSuggestionCache.shutdown();
		await harness?.shutdown();
	});

	it('answers 403 FEATURE_TEMPORARILY_DISABLED while feature_feed_suggestions is 0 (the default), and 403 while feature_feed is 0', async () => {
		const [viewer] = await accounts(1);
		vi.restoreAllMocks();
		await suggestions(viewer!).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();

		overrideLimits({feature_feed_suggestions: 1, feature_feed: 0});
		await suggestions(viewer!).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
	});

	it('answers 401 without a session', async () => {
		await createBuilderWithoutAuth(harness).get('/feed/suggestions').expect(HTTP_STATUS.UNAUTHORIZED).execute();
	});

	it('returns at most five people and five communities from the pool', async () => {
		const [viewer, ...people] = await accounts(9);
		const guilds = Array.from({length: 8}, (_, index) => guild(index));
		later();
		await pool(people, guilds);

		const answer = await suggestions(viewer!).execute();
		expect(answer.users).toHaveLength(5);
		expect(answer.guilds).toHaveLength(5);
		expect(new Set(userIds(answer)).size).toBe(5);
		expect(new Set(answer.guilds.map((entry) => entry.id)).size).toBe(5);
		for (const id of userIds(answer)) expect(people.map((person) => person.userId)).toContain(id);
		for (const entry of answer.guilds) expect(guilds).toContainEqual(entry);
	});

	it('never suggests the caller, accounts the caller follows, accounts blocked either way or communities the caller is in', async () => {
		const [viewer, followed, blocked, blocker, stranger] = await accounts(5);
		await followDirectly(viewer!.userId, followed!.userId);
		await blockUser(harness, viewer!, blocked!.userId);
		await blockUser(harness, blocker!, viewer!.userId);
		const own = await createGuild(harness, viewer!.token, 'Kendi topluluğum');
		later();
		await pool([viewer!, followed!, blocked!, blocker!, stranger!], [guild(1), {...guild(2), id: own.id}]);

		const answer = await suggestions(viewer!).execute();
		expect(userIds(answer)).toEqual([stranger!.userId]);
		expect(answer.guilds).toEqual([guild(1)]);
	});

	it('leaves people out for a caller without stranger standing and still suggests communities', async () => {
		const [person, spammer] = await accounts(2);
		const unverified = await createTestAccount(harness, {skipEmailVerification: true});
		await patchUser(spammer!, {flags: (await userOf(spammer!)).flags | UserFlags.SPAMMER});
		later();
		const young = await createYoungAccount();
		await pool([person!], [guild(1)]);

		for (const viewer of [unverified, young, spammer!]) {
			expect(await suggestions(viewer).execute()).toEqual({users: [], guilds: [guild(1)]});
		}
		// The same pool for a caller with the standing.
		const [other] = await accounts(1);
		expect(userIds(await suggestions(other!).execute())).toEqual([person!.userId]);
	});

	it('leaves people out for a minor caller', async () => {
		const [person, minor, undated] = await accounts(3);
		await patchUser(minor!, {date_of_birth: MINOR});
		await patchUser(undated!, {date_of_birth: null});
		later();
		await pool([person!], [guild(1)]);

		for (const viewer of [minor!, undated!]) {
			expect(await suggestions(viewer).execute()).toEqual({users: [], guilds: [guild(1)]});
		}
	});

	it('suggests no community while discovery is off', async () => {
		const [viewer, person] = await accounts(2);
		later();
		await pool([person!], [guild(1)]);

		const enabled = Config.discovery.enabled;
		Config.discovery.enabled = false;
		try {
			expect(await suggestions(viewer!).execute()).toEqual({
				users: [mapUserToPartialResponse(await userOf(person!))],
				guilds: [],
			});
		} finally {
			Config.discovery.enabled = enabled;
		}
	});

	it('an evicted (banned) account is gone from the next answer at once', async () => {
		const [viewer, banned, kept] = await accounts(3);
		later();
		await pool([banned!, kept!]);
		expect(userIds(await suggestions(viewer!).execute()).sort()).toEqual([banned!.userId, kept!.userId].sort());

		await onUserBanned({userId: createUserID(BigInt(banned!.userId))});
		expect(userIds(await suggestions(viewer!).execute())).toEqual([kept!.userId]);
	});

	it('different requests get different picks, and the most followed account is not in every answer', async () => {
		const now = Date.now();
		let sequence = 0;
		const account = () =>
			new User({
				...EMPTY_USER_ROW,
				user_id: createUserID(createSnowflake({timestamp: now - 100 * HOUR, workerId: 7, sequence: sequence++})),
				username: 'oneri',
				discriminator: 1,
				version: 1,
				email_verified: true,
				password_hash: 'hash',
				date_of_birth: ADULT,
			});
		// The pool in follower order: people[0] is the most followed.
		const people = Array.from({length: 12}, account);
		const viewer = account();
		const service = (random?: () => number) =>
			new FeedSuggestionService({
				cache: {fresh: () => ({version: now, users: people.map(mapUserToPartialResponse), guilds: []})},
				discover: {blockedAmong: async () => new Set<string>()},
				followRepository: {getFollowedAmong: async () => new Set<UserID>()},
				userRepository: {getUserGuildIds: async () => []},
				random,
			} as unknown as ConstructorParameters<typeof FeedSuggestionService>[0]);
		const picks = async (random?: () => number) =>
			(await service(random).suggest(viewer, now)).users.map((user) => user.id);
		const idsOf = (...users: Array<User>) => users.map((user) => user.id.toString());

		expect(await picks(() => 0)).toEqual(idsOf(...people.slice(0, 5)));
		expect(await picks(() => 0.999)).toEqual(idsOf(people[11]!, ...people.slice(0, 4)));

		const answers: Array<Array<string>> = [];
		for (let index = 0; index < 20; index++) answers.push(await picks());
		expect(new Set(answers.map((answer) => answer.join())).size).toBeGreaterThan(1);
		expect(answers.every((answer) => answer.includes(people[0]!.id.toString()))).toBe(false);
		for (const answer of answers) expect(new Set(answer).size).toBe(5);
	});

	it("reads only the caller's own data per request: one block set, one follow read, one guild list; no search, counter, ranking or users read", async () => {
		const [viewer, ...people] = await accounts(4);
		later();
		await pool(people, [guild(1), guild(2)]);
		const unread = [
			vi.spyOn(getGuildSearchService()!, 'searchGuilds'),
			vi.spyOn(KVCounterService.prototype, 'getMany'),
			vi.spyOn(KVCounterService.prototype, 'get'),
			vi.spyOn(FollowRepository.prototype, 'listRankedFollowers'),
			vi.spyOn(UserRepository.prototype, 'listUsers'),
		];
		const readOnce = [
			vi.spyOn(FeedDiscoverService.prototype, 'blockedAmong'),
			vi.spyOn(FollowRepository.prototype, 'getFollowedAmong'),
			vi.spyOn(UserRepository.prototype, 'getUserGuildIds'),
		];

		const answer = await suggestions(viewer!).execute();
		expect(answer.users).toHaveLength(3);
		expect(answer.guilds).toHaveLength(2);
		for (const spy of unread) expect(spy).not.toHaveBeenCalled();
		for (const spy of readOnce) expect(spy).toHaveBeenCalledTimes(1);
	});

	it('carries only partial user fields and Discovery guild fields: no email, phone, date of birth or follower count', async () => {
		const [viewer, person] = await accounts(2);
		later();
		await pool([person!], [guild(1)]);

		const answer = await suggestions(viewer!).execute();
		const partial = JSON.parse(JSON.stringify(mapUserToPartialResponse(await userOf(person!)))) as object;
		expect(Object.keys(answer.users[0]!).sort()).toEqual(Object.keys(partial).sort());
		expect(Object.keys(answer.guilds[0]!).sort()).toEqual(
			Object.keys(FeedSuggestionsResponse.shape.guilds.element.shape).sort(),
		);
		for (const key of ['email', 'phone', 'date_of_birth', 'follower_count']) {
			expect(answer.users[0]).not.toHaveProperty(key);
		}
	});

	it('returns empty lists when the pool is older than 10 minutes', async () => {
		const [viewer, person] = await accounts(2);
		later();
		await seedSuggestionPool({
			users: [await userOf(person!)],
			guilds: [guild(1)],
			version: Date.now() - 10 * MINUTE - 1,
		});

		expect(await suggestions(viewer!).execute()).toEqual({users: [], guilds: []});
	});
});
