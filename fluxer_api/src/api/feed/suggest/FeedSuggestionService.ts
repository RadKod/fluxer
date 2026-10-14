// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {createGuildID, createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {
	hasStrangerFollowStanding,
	isDiscoverAuthorEligible,
	isTrendActorEligible,
} from '@app/api/feed/discover/FeedDiscoverRules';
import type {FeedDiscoverService} from '@app/api/feed/discover/FeedDiscoverService';
import {opensPublicPostsToStrangers} from '@app/api/feed/FeedTimelineService';
import type {FeedSuggestionCache} from '@app/api/feed/suggest/FeedSuggestionCache';
import type {FeedSuggestionRepository} from '@app/api/feed/suggest/FeedSuggestionRepository';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {FOLLOWER_RANK_SIZE, type FollowRepository} from '@app/api/follow/FollowRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {User} from '@app/api/models/User';
import type {IGuildSearchService} from '@app/api/search/IGuildSearchService';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import {mapUserToPartialResponse} from '@app/api/user/UserMappers';
import {isUserAdult} from '@app/api/utils/AgeUtils';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {GuildFeatures, GuildNSFWLevel, getEffectiveGuildVerificationLevel} from '@fluxer/constants/src/GuildConstants';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {DEFAULT_FREE_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import type {SearchableGuild} from '@fluxer/schema/src/contracts/search/SearchDocumentTypes';
import type {FeedSuggestionsResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {createSnowflakeFromTimestamp, snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

// A pool copy older than this is no pool: nothing is shown from it and nobody follows through it.
export const SUGGESTION_POOL_MAX_AGE_MS = 600_000;
const SUGGESTION_POOL_SIZE = 100;
const SUGGESTION_PICK = 5;
// Random candidates a request draws before its own filters (the caller, follows, blocks, own communities).
const SUGGESTION_CANDIDATES = 20;
// The build looks at no more than this many ranked accounts a run (≈28 K partition reads a minute, 70 K at most,
// with the second sample window).
const SUGGESTION_EXAMINE_MAX = 300;
const CANDIDATE_BATCH = 20;
const CANDIDATE_CONCURRENCY = 8;
const SAMPLE_SIZE = 100;
const SAMPLE_MIN_SHARE = 0.5;
// The flush floor follows the ranking only while the build keeps at least this share of it; a ranking that lost more
// (deaths, bans, a KV loss) opens again from the admin floor, so it can fill back up.
const FLOOR_KEEP_SHARE = 0.9;
const DAY_MS = 86_400_000;
// AdminUserBanService: a permanent ban sets DISABLED and a ban end 100 years ahead; a timed one stays well under a year.
const PERMANENT_BAN_MS = 365 * 86_400_000;
const USERS_CHUNK = 100;
const USERS_CONCURRENCY = 8;
const BACKFILL_PAGE_SIZE = 1000;
const BACKFILL_PAGES_PER_JOB = 20;
const BACKFILL_BUDGET_MS = 20_000;

type FeedSuggestedGuild = FeedSuggestionsResponse['guilds'][number];
type Rejection = 'unfit' | 'feed_off' | 'privacy' | 'sample';

export interface FeedSuggestionSnapshot {
	version: number;
	users: Array<UserPartialResponse>;
	guilds: FeedSuggestionsResponse['guilds'];
}

interface FeedSuggestionServiceDeps {
	repository: FeedSuggestionRepository;
	followRepository: FollowRepository;
	userRepository: Pick<IUserRepository, 'listUsers' | 'findSettings' | 'getUserGuildIds'>;
	kvCounterService: Pick<KVCounterService, 'getMany'>;
	limitConfigService: LimitConfigService;
	discover: Pick<FeedDiscoverService, 'blockedAmong'>;
	guildSearch: () => IGuildSearchService | null;
	gatewayService: Pick<IGatewayService, 'getDiscoveryGuildCounts'>;
	workerService: Pick<IWorkerService<WorkerTaskName>, 'addJob'>;
	cache: Pick<FeedSuggestionCache, 'fresh'>;
	random?: () => number; // tests pin it; Math.random otherwise
}

/** Who may be in the people pool: the Keşfet author rule (clean, a day old, verified email), an adult, not a bot. */
export function isSuggestableAccount(user: User, nowMs: number): boolean {
	return (
		!user.isBot &&
		!user.isSystem &&
		isDiscoverAuthorEligible(user, nowMs, {hasVideo: false}) &&
		isUserAdult(user.dateOfBirth)
	);
}

// Lives with the Keşfet rules so the profile access rule can use it without loading this service (no import cycle).
export {hasStrangerFollowStanding} from '@app/api/feed/discover/FeedDiscoverRules';

// a minor, or an account without a date of birth, is never shown strangers to
// follow and cannot follow through the pool. The Keşfet post path keeps its own rule (hasStrangerFollowStanding only).
export function hasPoolFollowStanding(user: User, nowMs: number): boolean {
	return hasStrangerFollowStanding(user, nowMs) && isUserAdult(user.dateOfBirth);
}

// popular people and Discovery communities under the feed profile card. A cron build keeps one
// snapshot of the top 100 of each; every API process keeps it in memory (FeedSuggestionCache), so a request reads only
// the caller's own data.
export class FeedSuggestionService {
	constructor(private readonly deps: FeedSuggestionServiceDeps) {}

	isEnabledFor(user: User): boolean {
		return this.resolve('feature_feed_suggestions', user) !== 0;
	}

	/** Whether this process's pool copy (at most 10 minutes old) lists the account; no read. */
	isPooled(userId: UserID, nowMs = Date.now()): boolean {
		const id = userId.toString();
		return this.deps.cache.fresh(nowMs).users.some((user) => user.id === id);
	}

	/**
	 * The cron build (refreshFeedSuggestions, once a minute): -1 when another build holds the 50 s gate or took it from
	 * this one, else the number of people pooled. Keeps the follower ranking (trim, rescore, drop the dead for good, the
	 * flush's floor), queues its backfill once, and stores the pool snapshot. The ranking writes are
	 * repeatable: a build that lost its gate leaves them for the next one to redo and stores no snapshot.
	 */
	async buildSnapshot(now = Date.now()): Promise<number> {
		const {repository, followRepository, kvCounterService} = this.deps;
		const startedAt = Date.now();
		const token = await repository.claimBuild();
		if (!token) return -1;
		if (this.resolve('feature_feed_suggestions', null) === 0) {
			// Off: no floor, so every flush stops ranking within 10 s and the set stays as it is; the filled mark stays,
			// so turning it back on needs no backfill (the cost: counts that moved while off come back only as they change).
			await followRepository.deleteFollowerRankFloor();
			if (!(await repository.holdBuild(token))) return lostBuildGate();
			await repository.putSnapshot({version: now, users: [], guilds: []});
			await repository.endBuild(token, startedAt);
			Logger.info({enabled: false}, 'Built the feed suggestions');
			return 0;
		}
		const floorRule = this.floorRule();
		const {ranked, pruned} = await followRepository.pruneRankedFollowers(FOLLOWER_RANK_SIZE);
		const filledSize = await followRepository.getFollowerRankFilled();
		let filled = filledSize !== null;
		// a ranking that held accounts when it was filled and is empty now went missing alone (an eviction, a
		// manual DEL); the four keys share one hash tag only against losing a whole node. It is filled again. One filled
		// empty (nobody at the floor yet) stays so, with the admin floor, and no second scan runs (yeniden bakış 1).
		if (ranked === 0 && filledSize !== null && filledSize > 0) {
			Logger.warn(
				{},
				'The follower ranking is empty although it was filled; KV may have lost it, so it is filled again',
			);
			await followRepository.clearFollowerRankFilled();
			filled = false;
		}
		const ids = await followRepository.listRankedFollowers(FOLLOWER_RANK_SIZE);
		const [counts, users] = await Promise.all([
			kvCounterService.getMany(FOLLOWER_COUNT_COUNTER, ids.map(String)),
			this.listUsers(ids),
		]);
		// Dead for good (no row, deleted, permanently banned) or under the admin floor: out of the ranking. Temporarily
		// unfit accounts stay ranked and are skipped below, so an unban or a privacy change back needs no new follow.
		const kept: Array<{user: User; count: number}> = [];
		const drop: Array<UserID> = [];
		ids.forEach((id, index) => {
			const user = users.get(id);
			const count = Math.max(0, counts[index] ?? 0);
			if (!user || isGoneForGood(user, now) || count < floorRule) drop.push(id);
			else kept.push({user, count});
		});
		kept.sort((a, b) => b.count - a.count);
		// Unlocked against the flush: a flush between the counter read and these writes may lose its newer
		// score to the build's, or its fresh entry to the drop. Both heal: the next build rescores every ranked account it
		// reads with current counts, and a dropped account is ranked again on its next count change at or above the floor.
		await followRepository.unrankFollowers(drop);
		await followRepository.rankFollowers(kept.map(({user, count}) => [user.id, count]));
		// Only from what this build kept, and only while that is most of a ranking: one account dropping out moves the floor
		// by one place, not down to the admin floor (hysteresis); many dropping out open the ranking again.
		const floor =
			kept.length >= FLOOR_KEEP_SHARE * FOLLOWER_RANK_SIZE
				? Math.max(floorRule, kept[Math.min(kept.length, FOLLOWER_RANK_SIZE) - 1]!.count)
				: floorRule;
		// No floor before the ranking is filled: at the admin floor every flush of an account with a
		// couple of followers would write to it; the backfill fills it instead, from the admin floor.
		if (filled) await followRepository.putFollowerRankFloor(floor);
		else await this.queueBackfill();
		const picked = await this.pickPeople(kept, now, token, await repository.getDaySeed(Math.floor(now / DAY_MS)));
		if (picked === null) return lostBuildGate();
		const guilds = await this.pickGuildPool();
		if (!(await repository.holdBuild(token))) return lostBuildGate();
		const bytes = await repository.putSnapshot({version: now, users: picked.users, guilds});
		await repository.endBuild(token, startedAt);
		Logger.info(
			{
				ranked,
				pruned,
				removed: drop.length,
				ranked_kept: kept.length,
				floor: filled ? floor : null,
				floor_rule: floorRule,
				examined: picked.examined,
				sampled: picked.sampled,
				rejected: picked.rejected,
				pool_users: picked.users.length,
				pool_guilds: guilds.length,
				bytes,
				build_ms: Date.now() - startedAt,
			},
			'Built the feed suggestions',
		);
		return picked.users.length;
	}

	/** Up to five people and five communities, drawn at random from this process's pool copy (no shared read). */
	async suggest(viewer: User, now = Date.now()): Promise<FeedSuggestionsResponse> {
		const snapshot = this.deps.cache.fresh(now);
		const [users, guilds] = await Promise.all([
			hasPoolFollowStanding(viewer, now) ? this.pickUsers(viewer.id, snapshot.users) : [],
			Config.discovery.enabled ? this.pickGuilds(viewer.id, snapshot.guilds) : [],
		]);
		return {users, guilds};
	}

	/**
	 * One backfill job: up to 20 pages of 1000 stored follower counts or 20 s, ranking that stretch's top 1000 at or
	 * above the floor (the admin floor while the build writes none). Returns the page state to go on from, or null once the
	 * whole table was read, or at once when feature_feed_suggestions was turned off: the chain stops unfilled, and the
	 * build queues it again once the flag is back on.
	 */
	// TEMPORARY: a full scan of user_follow_stats, only when the ranking was never filled or KV lost it. Trigger:
	// more than 2 backfills in 7 days, or one running past 30 min. Path: a bucketed Cassandra follower rank table written on
	// the flush (bucket = floor(log2(count))), so neither a scan nor KV durability is needed (a schema change: its own gate).
	async backfillRanking(pageState: string | null): Promise<string | null> {
		const {followRepository} = this.deps;
		if (this.resolve('feature_feed_suggestions', null) === 0) {
			await followRepository.clearFollowerRankBackfill();
			return null;
		}
		const startedAt = Date.now();
		const floor = (await followRepository.getFollowerRankFloor()) ?? this.floorRule();
		let top: Array<[UserID, number]> = [];
		let next = pageState;
		for (let pages = 0; pages < BACKFILL_PAGES_PER_JOB && Date.now() - startedAt < BACKFILL_BUDGET_MS; pages++) {
			const page = await followRepository.scanFollowerCountsPage(next, BACKFILL_PAGE_SIZE);
			for (const row of page.rows) if (row.follower_count >= floor) top.push([row.user_id, row.follower_count]);
			if (top.length > 2 * FOLLOWER_RANK_SIZE) top = byCount(top).slice(0, FOLLOWER_RANK_SIZE);
			next = page.pageState;
			if (next === null) break;
		}
		await followRepository.rankFollowers(byCount(top).slice(0, FOLLOWER_RANK_SIZE));
		if (next === null) await followRepository.finishFollowerRankBackfill();
		else await followRepository.continueFollowerRankBackfill();
		return next;
	}

	// The admin floor; the limit page's min is only an HTML attribute, so below 1 counts as 1.
	private floorRule(): number {
		return Math.max(1, this.resolve('feed_suggestions_min_followers', null));
	}

	// the build (a worker cron, never a request) queues the backfill itself, once: the SETNX mark lives an hour
	// and every job of the chain renews it.
	private async queueBackfill(): Promise<void> {
		const {followRepository, workerService} = this.deps;
		if (!(await followRepository.startFollowerRankBackfill())) return;
		try {
			await workerService.addJob('backfillFeedSuggestionRanking', {page_state: null});
		} catch (error) {
			await followRepository.clearFollowerRankBackfill();
			Logger.warn({error}, 'Queueing the follower ranking backfill failed; the next build tries again');
		}
	}

	// Ranked order, 20 at a time, until 100 pass or 300 were looked at; the gate is held after every batch, so a build
	// that ran long stops before its reads pile up on a newer one.
	private async pickPeople(
		kept: Array<{user: User; count: number}>,
		now: number,
		token: string,
		daySeed: string,
	): Promise<{
		users: Array<UserPartialResponse>;
		rejected: Record<Rejection, number>;
		examined: number;
		sampled: number;
	} | null> {
		const rejected: Record<Rejection, number> = {unfit: 0, feed_off: 0, privacy: 0, sample: 0};
		const users: Array<UserPartialResponse> = [];
		let examined = 0;
		let sampled = 0;
		while (examined < kept.length && examined < SUGGESTION_EXAMINE_MAX && users.length < SUGGESTION_POOL_SIZE) {
			const batch = kept.slice(examined, examined + Math.min(CANDIDATE_BATCH, SUGGESTION_EXAMINE_MAX - examined));
			examined += batch.length;
			const verdicts = await mapWithConcurrency(
				batch,
				CANDIDATE_CONCURRENCY,
				async ({user, count}): Promise<Rejection | null> => {
					if (!isSuggestableAccount(user, now)) return 'unfit';
					if (this.resolve('feature_feed', user) === 0) return 'feed_off';
					if (!opensPublicPostsToStrangers(await this.deps.userRepository.findSettings(user.id), user))
						return 'privacy';
					sampled++;
					return (await this.passesFollowerSample(user, count, now, daySeed)) ? null : 'sample';
				},
			);
			verdicts.forEach((verdict, index) => {
				if (verdict !== null) rejected[verdict]++;
				else if (users.length < SUGGESTION_POOL_SIZE) users.push(mapUserToPartialResponse(batch[index]!.user));
			});
			if (!(await this.deps.repository.holdBuild(token))) return null;
		}
		return {users, rejected, examined, sampled};
	}

	// most of an account's newest followers must be accounts that could move Keşfet (clean, 72 h old), so a
	// ring of new or flagged accounts cannot lift someone into the list. With more followers than one window, so must the
	// ones who followed before a moment of the account's life: a mass of bought follows topped
	// with a few clean ones fails there. The moment is fixed per account and UTC day, between the account's opening and
	// the day's start, placed by the day's secret seed: one verdict a day (no flicker in and out of the pool), and nobody
	// outside can aim follows at it. A window with nobody before that moment passes nothing (errs toward hiding: an old
	// account whose followers all came lately stays out). Per window one follower bucket list and at most 16 buckets
	// (FollowRepository.listFollowers) plus one users IN (≤100 partitions); the second only for a candidate that passed
	// the first.
	private async passesFollowerSample(user: User, count: number, now: number, daySeed: string): Promise<boolean> {
		if (!(await this.fitShareHolds(user.id, undefined, now))) return false;
		if (count <= SAMPLE_SIZE) return true;
		const bornAt = snowflakeToDate(user.id).getTime();
		const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
		const share = createHash('sha256').update(`${daySeed}:${user.id}`).digest().readUInt32BE(0) / 2 ** 32;
		const moment = bornAt + Math.floor(share * Math.max(0, dayStart - bornAt));
		return this.fitShareHolds(user.id, createSnowflakeFromTimestamp(moment), now);
	}

	// Whether at least half of the up to 100 followers before `before` (the newest when undefined) could move Keşfet.
	private async fitShareHolds(userId: UserID, before: bigint | undefined, now: number): Promise<boolean> {
		const followers = await this.deps.followRepository.listFollowers(userId, {before, limit: SAMPLE_SIZE});
		if (followers.length === 0) return false;
		const accounts = await this.deps.userRepository.listUsers(followers.map((row) => row.user_id));
		const fit = accounts.filter((account) => isTrendActorEligible(account, now)).length;
		return fit / followers.length >= SAMPLE_MIN_SHARE;
	}

	// The 100 biggest approved, safe Discovery communities (the search Keşif uses); one with invites off is left out,
	// joining checks it again anyway. Online counts are best effort (GuildDiscoveryService.searchDiscoverable).
	private async pickGuildPool(): Promise<Array<FeedSuggestedGuild>> {
		const search = this.deps.guildSearch();
		if (!Config.discovery.enabled || search === null) return [];
		let guilds: Array<FeedSuggestedGuild>;
		try {
			guilds = mapGuildHits(
				await search.searchGuilds(
					'',
					{isDiscoverable: true, nsfwLevel: GuildNSFWLevel.SAFE, sortBy: 'memberCount', sortOrder: 'desc'},
					{limit: SUGGESTION_POOL_SIZE},
				),
			);
		} catch (error) {
			// a search timeout must not stop the build, or the people pool would age out with it.
			Logger.warn({error}, 'The community search failed; pooling people without communities');
			return [];
		}
		if (guilds.length === 0) return guilds;
		try {
			const counts = await this.deps.gatewayService.getDiscoveryGuildCounts(
				guilds.map((guild) => createGuildID(BigInt(guild.id))),
			);
			for (const guild of guilds) guild.online_count = counts.get(createGuildID(BigInt(guild.id)))?.onlineCount ?? 0;
		} catch (error) {
			Logger.warn({error}, 'Reading online counts for the suggested communities failed; showing 0');
		}
		return guilds;
	}

	// The caller's own block set (KV, 60 s) and one clustering IN on their own follow partition.
	private async pickUsers(viewerId: UserID, pool: Array<UserPartialResponse>): Promise<Array<UserPartialResponse>> {
		const self = viewerId.toString();
		const candidates = pickRandom(
			pool.filter((user) => user.id !== self),
			SUGGESTION_CANDIDATES,
			() => this.random(),
		);
		if (candidates.length === 0) return [];
		const ids = candidates.map((user) => user.id);
		const [blocked, followed] = await Promise.all([
			this.deps.discover.blockedAmong(viewerId, ids),
			this.deps.followRepository.getFollowedAmong(
				viewerId,
				ids.map((id) => createUserID(BigInt(id))),
			),
		]);
		return candidates
			.filter((user) => !blocked.has(user.id) && !followed.has(createUserID(BigInt(user.id))))
			.slice(0, SUGGESTION_PICK);
	}

	// The caller's own guild list, one partition.
	private async pickGuilds(viewerId: UserID, pool: Array<FeedSuggestedGuild>): Promise<Array<FeedSuggestedGuild>> {
		const candidates = pickRandom(pool, SUGGESTION_CANDIDATES, () => this.random());
		if (candidates.length === 0) return [];
		const member = new Set((await this.deps.userRepository.getUserGuildIds(viewerId)).map(String));
		return candidates.filter((guild) => !member.has(guild.id)).slice(0, SUGGESTION_PICK);
	}

	// listUsers reads its IDs in one IN; 100 at a time keeps each query small (FeedDiscoverService.listUsers).
	private async listUsers(userIds: Array<UserID>): Promise<Map<UserID, User>> {
		const chunks = Array.from({length: Math.ceil(userIds.length / USERS_CHUNK)}, (_, index) =>
			userIds.slice(index * USERS_CHUNK, (index + 1) * USERS_CHUNK),
		);
		const pages = await mapWithConcurrency(chunks, USERS_CONCURRENCY, (chunk) =>
			this.deps.userRepository.listUsers(chunk),
		);
		return new Map(pages.flat().map((user) => [user.id, user]));
	}

	private random(): number {
		return (this.deps.random ?? Math.random)();
	}

	// The build reads the default rule (user null), a request the caller's own (FeedDiscoverService.resolve pattern).
	private resolve(key: LimitKey, user: User | null): number {
		return resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user}),
			key,
			DEFAULT_FREE_LIMITS[key],
		);
	}
}

// Deleted, or banned for good (AdminUserBanService: DISABLED with a ban end a century ahead). A timed ban is not.
function isGoneForGood(user: User, now: number): boolean {
	if ((user.flags & UserFlags.DELETED) !== 0n) return true;
	return (
		(user.flags & UserFlags.DISABLED) !== 0n &&
		user.tempBannedUntil !== null &&
		user.tempBannedUntil.getTime() > now + PERMANENT_BAN_MS
	);
}

// Safe ones with invites on, in the Discovery list's shape (GuildDiscoveryService.searchDiscoverable).
function mapGuildHits({hits}: {hits: Array<SearchableGuild>}): Array<FeedSuggestedGuild> {
	return hits
		.filter((hit) => hit.nsfwLevel === GuildNSFWLevel.SAFE && !hit.features.includes(GuildFeatures.INVITES_DISABLED))
		.map((hit) => ({
			id: hit.id,
			name: hit.name,
			icon: hit.iconHash,
			banner: hit.bannerHash,
			description: hit.discoveryDescription,
			category_type: hit.discoveryCategory ?? 0,
			primary_language: hit.discoveryPrimaryLanguage ?? null,
			custom_tags: hit.discoveryTags ?? [],
			member_count: hit.memberCount,
			online_count: 0,
			features: hit.features,
			verification_level: getEffectiveGuildVerificationLevel(hit.verificationLevel, hit.isDiscoverable),
		}));
}

function byCount(entries: Array<[UserID, number]>): Array<[UserID, number]> {
	return entries.sort((a, b) => b[1] - a[1]);
}

// A partial Fisher-Yates: the first `count` of a shuffled copy.
function pickRandom<T>(items: ReadonlyArray<T>, count: number, random: () => number): Array<T> {
	const pool = [...items];
	const size = Math.min(count, pool.length);
	for (let index = 0; index < size; index++) {
		const other = index + Math.floor(random() * (pool.length - index));
		[pool[index], pool[other]] = [pool[other]!, pool[index]!];
	}
	return pool.slice(0, size);
}

function lostBuildGate(): number {
	Logger.warn({}, 'A feed suggestion build ran past its gate and another took it; dropping this build');
	return -1;
}
