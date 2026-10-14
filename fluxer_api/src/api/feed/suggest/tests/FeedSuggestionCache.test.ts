// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {FeedDiscoverRepository} from '@app/api/feed/discover/FeedDiscoverRepository';
import {feedSuggestionCache} from '@app/api/feed/suggest/FeedSuggestionCache';
import {FeedSuggestionRepository} from '@app/api/feed/suggest/FeedSuggestionRepository';
import {
	hasPoolFollowStanding,
	hasStrangerFollowStanding,
	isSuggestableAccount,
} from '@app/api/feed/suggest/FeedSuggestionService';
import {seedSuggestionPool} from '@app/api/feed/suggest/tests/FeedSuggestionTestUtils';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedDiscoverRepository,
	getFeedSuggestionService,
	getLimitConfigService,
} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {resetServiceStateForTesting} from '@app/api/test/ResetServiceState';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {FeedSuggestionsResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import {types} from 'cassandra-driver';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.now();
const ADULT = types.LocalDate.fromString('2000-01-01');
const MINOR = types.LocalDate.fromString(`${new Date().getFullYear() - 10}-06-15`);
const GUILD: FeedSuggestionsResponse['guilds'][number] = {
	id: '1300000000000000001',
	name: 'Topluluk',
	icon: null,
	banner: null,
	description: null,
	category_type: 0,
	primary_language: null,
	custom_tags: [],
	member_count: 5000,
	online_count: 120,
	features: [],
	verification_level: 0,
};

let sequence = 0;
// A clean, claimed adult account `ageMs` old; worker 7 keeps its ID apart from the ones the services generate.
function account(ageMs: number, patch: Partial<UserRow> = {}): User {
	return new User({
		...EMPTY_USER_ROW,
		user_id: createUserID(createSnowflake({timestamp: NOW - ageMs, workerId: 7, sequence: sequence++ % 4096})),
		username: 'popular',
		discriminator: 1,
		version: 1,
		email_verified: true,
		password_hash: 'hash',
		date_of_birth: ADULT,
		...patch,
	});
}

// every API process keeps the suggestion snapshot; the pool path of PUT /users/:id/follow and
// GET /feed/suggestions read only this copy.
describe('feed suggestion snapshot cache', () => {
	let harness: ApiTestHarness;
	const discover = () => getFeedDiscoverRepository();
	const pooled = (user: User) => getFeedSuggestionService().isPooled(user.id);
	const poolIds = () => feedSuggestionCache.fresh().users.map((user) => user.id);
	const ids = (...users: Array<User>) => users.map((user) => user.id.toString());
	// A fresh process: shut the old subscription down first, or initialize would find it still stopping.
	async function restartCache(): Promise<void> {
		await feedSuggestionCache.shutdown();
		feedSuggestionCache.resetForTesting();
		feedSuggestionCache.setRefreshSubscriber(getKVClient());
		await feedSuggestionCache.initialize();
	}

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		await restartCache();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await feedSuggestionCache.shutdown();
		await harness?.shutdown();
	});

	it('a process keeps the stored suggestion snapshot and knows who is in the pool', async () => {
		const [first, second, outsider] = [account(100 * HOUR), account(100 * HOUR), account(100 * HOUR)];
		await seedSuggestionPool({users: [first, second], guilds: [GUILD]});

		expect(poolIds()).toEqual(ids(first, second));
		expect(feedSuggestionCache.fresh().guilds).toEqual([GUILD]);
		expect(pooled(first)).toBe(true);
		expect(pooled(outsider)).toBe(false);
		// A page reads only the process's copy, never the key.
		await getKVClient().del('feed:suggest:snapshot');
		expect(pooled(second)).toBe(true);
	});

	it('an author eviction on the Keşfet channel drops that account at once, and a post eviction changes nothing', async () => {
		const [kept, banned] = [account(100 * HOUR), account(100 * HOUR)];
		await seedSuggestionPool({users: [kept, banned], guilds: [GUILD]});

		await discover().publishEvict('post', banned.id.toString());
		expect(poolIds()).toEqual(ids(kept, banned));
		await discover().publishEvict('author', banned.id.toString());
		expect(poolIds()).toEqual(ids(kept));
		expect(pooled(banned)).toBe(false);
		expect(feedSuggestionCache.fresh().guilds).toEqual([GUILD]);
	});

	it('a ban eviction stays applied past 120 s while no newer snapshot came', async () => {
		const [kept, banned] = [account(100 * HOUR), account(100 * HOUR)];
		await seedSuggestionPool({users: [kept, banned]});
		await discover().publishEvict('author', banned.id.toString());

		// Two minutes on, Keşfet's build has pruned the eviction and its own 120 s memory is over; the suggestion
		// snapshot stays valid for 10 minutes, so this one is still the one read.
		vi.useFakeTimers({now: Date.now() + 121_000, toFake: ['Date']});
		await discover().pruneEvictionsBefore(Date.now());
		await feedSuggestionCache.refresh();
		expect(poolIds()).toEqual(ids(kept));
		expect(pooled(banned)).toBe(false);
	});

	it('a snapshot built after the eviction takes over and the eviction is forgotten', async () => {
		const [kept, returned] = [account(100 * HOUR), account(100 * HOUR)];
		await seedSuggestionPool({users: [kept, returned]});
		await discover().publishEvict('author', returned.id.toString());
		expect(poolIds()).toEqual(ids(kept));

		// Built 30 s later, and the account passed every rule again by then.
		vi.useFakeTimers({now: Date.now() + 30_000, toFake: ['Date']});
		await seedSuggestionPool({users: [kept, returned], version: Date.now()});
		expect(poolIds()).toEqual(ids(kept, returned));
		expect(pooled(returned)).toBe(true);
	});

	it('a process that starts after an eviction still leaves the evicted account out', async () => {
		const [kept, banned] = [account(100 * HOUR), account(100 * HOUR)];
		await seedSuggestionPool({users: [kept, banned]});
		await feedSuggestionCache.shutdown();
		feedSuggestionCache.resetForTesting();

		// The broadcast reaches no process of this one's; the evictions ZSET keeps it.
		await discover().publishEvict('author', banned.id.toString());
		await restartCache();
		expect(poolIds()).toEqual(ids(kept));
	});

	it('keeps the last copy when the evictions cannot be read and the new snapshot is older than the eviction memory', async () => {
		const [first, second] = [account(100 * HOUR), account(100 * HOUR)];
		await seedSuggestionPool({users: [first], version: Date.now() - 5 * MINUTE});
		vi.spyOn(FeedDiscoverRepository.prototype, 'listEvictionsSince').mockRejectedValue(new Error('kv down'));

		await seedSuggestionPool({users: [second], version: Date.now() - 3 * MINUTE});
		expect(poolIds()).toEqual(ids(first));
		await seedSuggestionPool({users: [second], version: Date.now() - MINUTE});
		expect(poolIds()).toEqual(ids(second));
	});

	it('a snapshot older than 10 minutes gives no pool for showing or following', async () => {
		const member = account(100 * HOUR);
		const version = Date.now() - 10 * MINUTE + 1000;
		await seedSuggestionPool({users: [member], guilds: [GUILD], version});
		expect(pooled(member)).toBe(true);

		vi.useFakeTimers({now: version + 10 * MINUTE + 1, toFake: ['Date']});
		expect(feedSuggestionCache.fresh()).toEqual({version, users: [], guilds: []});
		expect(pooled(member)).toBe(false);
	});

	it('a missing snapshot key keeps the last copy until it is 10 minutes old', async () => {
		const member = account(100 * HOUR);
		const version = Date.now();
		await seedSuggestionPool({users: [member], version});
		await getKVClient().del('feed:suggest:snapshot');

		vi.useFakeTimers({now: version + 9 * MINUTE, toFake: ['Date']});
		await feedSuggestionCache.refresh();
		expect(pooled(member)).toBe(true);
		vi.setSystemTime(version + 10 * MINUTE + 1);
		await feedSuggestionCache.refresh();
		expect(pooled(member)).toBe(false);
	});

	it('a failed read keeps the last copy', async () => {
		const member = account(100 * HOUR);
		await seedSuggestionPool({users: [member]});
		const read = vi.spyOn(FeedSuggestionRepository.prototype, 'getSnapshot').mockRejectedValue(new Error('kv down'));
		await new FeedSuggestionRepository(getKVClient()).putSnapshot({version: Date.now(), users: [], guilds: []});

		await feedSuggestionCache.refresh();
		expect(pooled(member)).toBe(true);
		// Also the very first read of a process that starts: the API starts with an empty pool.
		await expect(restartCache()).resolves.toBeUndefined();
		expect(read).toHaveBeenCalled();
		expect(poolIds()).toEqual([]);
	});

	it('one build at a time: the 50 s gate is claimed once, held while it runs and kept until 50 s after its start', async () => {
		const repository = new FeedSuggestionRepository(getKVClient());
		const startedAt = Date.now();
		const token = await repository.claimBuild();
		expect(token).not.toBeNull();
		expect(await repository.claimBuild()).toBeNull();
		expect(await repository.holdBuild(token!)).toBe(true);
		expect(await repository.holdBuild('another build')).toBe(false);

		await repository.endBuild(token!, startedAt);
		vi.useFakeTimers({now: startedAt + 49_000, toFake: ['Date']});
		expect(await repository.claimBuild()).toBeNull();
		vi.setSystemTime(startedAt + 51_000);
		expect(await repository.claimBuild()).not.toBeNull();
	});

	it("feature_feed_suggestions follows the caller's own limit rule", () => {
		const [tester, other] = [account(100 * HOUR, {traits: new Set(['akis_suggest_on'])}), account(100 * HOUR)];
		const service = getFeedSuggestionService();
		expect(service.isEnabledFor(tester)).toBe(false);

		const limitConfigService = getLimitConfigService();
		const snapshot = limitConfigService.getConfigSnapshot();
		vi.spyOn(limitConfigService, 'getConfigSnapshot').mockReturnValue({
			...snapshot,
			rules: [
				...snapshot.rules,
				{id: 'test_suggest_on', filters: {traits: ['akis_suggest_on']}, limits: {feature_feed_suggestions: 1}},
			],
		});
		expect(service.isEnabledFor(tester)).toBe(true);
		expect(service.isEnabledFor(other)).toBe(false);

		vi.restoreAllMocks();
		overrideLimits({feature_feed_suggestions: 1});
		expect(service.isEnabledFor(other)).toBe(true);
	});

	// Last: the full service reset also stops the other process caches of this harness.
	it('is empty again after the test reset', async () => {
		await seedSuggestionPool({users: [account(100 * HOUR)], guilds: [GUILD]});
		expect(poolIds()).toHaveLength(1);

		await resetServiceStateForTesting();
		expect(feedSuggestionCache.fresh().users).toEqual([]);
		expect(feedSuggestionCache.fresh().guilds).toEqual([]);
	});
});

describe('who may be suggested and who may follow through the pool', () => {
	const unfitAccounts = (): Array<[string, User]> => [
		['23 hours old', account(23 * HOUR)],
		['no verified email', account(100 * HOUR, {email_verified: false})],
		['unclaimed', account(100 * HOUR, {password_hash: null})],
		['spammer', account(100 * HOUR, {flags: UserFlags.SPAMMER})],
		['disabled', account(100 * HOUR, {flags: UserFlags.DISABLED})],
		['suspicious', account(100 * HOUR, {flags: UserFlags.ACCOUNT_LIMITED})],
	];

	it('suggestable: a clean adult account a day old, not a bot or system account, with a verified email', () => {
		expect(isSuggestableAccount(account(25 * HOUR), NOW)).toBe(true);
		const unfit: Array<[string, User]> = [
			['bot', account(100 * HOUR, {bot: true})],
			['system', account(100 * HOUR, {system: true})],
			['minor', account(100 * HOUR, {date_of_birth: MINOR})],
			['no date of birth', account(100 * HOUR, {date_of_birth: null})],
			...unfitAccounts(),
		];
		for (const [reason, user] of unfit) expect(isSuggestableAccount(user, NOW), reason).toBe(false);
	});

	it('stranger standing: the public commenter rule plus clean flags', () => {
		expect(hasStrangerFollowStanding(account(25 * HOUR), NOW)).toBe(true);
		// Age is not part of it: the Keşfet post path keeps its own rule.
		expect(hasStrangerFollowStanding(account(25 * HOUR, {date_of_birth: MINOR}), NOW)).toBe(true);
		expect(hasStrangerFollowStanding(account(25 * HOUR, {date_of_birth: null}), NOW)).toBe(true);
		for (const [reason, user] of unfitAccounts()) expect(hasStrangerFollowStanding(user, NOW), reason).toBe(false);
	});

	it('pool standing: stranger standing and an adult; a minor or an account without a date of birth has none', () => {
		expect(hasPoolFollowStanding(account(25 * HOUR), NOW)).toBe(true);
		expect(hasPoolFollowStanding(account(25 * HOUR, {date_of_birth: MINOR}), NOW)).toBe(false);
		expect(hasPoolFollowStanding(account(25 * HOUR, {date_of_birth: null}), NOW)).toBe(false);
		for (const [reason, user] of unfitAccounts()) expect(hasPoolFollowStanding(user, NOW), reason).toBe(false);
	});
});
