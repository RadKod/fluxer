// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {type FeedPostRow, isPublicFeedPost} from '@app/api/database/types/FeedTypes';
import type {DiscoverEntry, FeedDiscoverCache} from '@app/api/feed/discover/FeedDiscoverCache';
import {
	type DiscoverBlockSet,
	EVICTION_MARGIN_MS,
	type FeedDiscoverRepository,
} from '@app/api/feed/discover/FeedDiscoverRepository';
import {
	DISCOVER_HIDDEN_AUTHOR_FLAGS,
	DISCOVER_SNAPSHOT_SIZE,
	diversifyByAuthor,
	feedPostHasVideo,
	isDiscoverAuthorEligible,
	isInTrendWindow,
	parseDiscoverCursor,
} from '@app/api/feed/discover/FeedDiscoverRules';
import type {FeedRepository} from '@app/api/feed/FeedRepository';
import type {FeedPostBase, FeedTimelineService} from '@app/api/feed/FeedTimelineService';
import {isStreamMedia} from '@app/api/feed/video/FeedVideoUrls';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import type {UserAccountLookupService} from '@app/api/user/services/UserAccountLookupService';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {DEFAULT_RESTRICTED_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import type {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

const SCAN_PAGE = 1000;
const SCAN_MAX = 10_000;
const USERS_CHUNK = 100;
const USERS_CONCURRENCY = 8;
const BLOCK_CHECK_CONCURRENCY = 8;
const INCOMING_BLOCK_CAP = 5000;
const PAGE_LOG_INTERVAL_MS = 60_000;
// Every API process reads the whole snapshot every 20-25 s: long posts must not blow it up.
const SNAPSHOT_BYTE_BUDGET = 2 * 1024 * 1024;
const SNAPSHOT_ENVELOPE_BYTES = 64;

// The instance's media arms: feature_feed_discover_media (images) and feature_feed_discover_video (a Bunny video).
interface MediaArms {
	mediaAllowed: boolean;
	videoAllowed: boolean;
}

function passesMediaArms(row: FeedPostRow, {mediaAllowed, videoAllowed}: MediaArms): boolean {
	const media = row.media ?? [];
	return media.some(isStreamMedia) ? videoAllowed : mediaAllowed || media.length === 0;
}

interface FeedDiscoverServiceDeps {
	repository: FeedDiscoverRepository;
	feedRepository: FeedRepository;
	userRepository: Pick<
		UserRepository,
		'listUsers' | 'listBlockedUserIds' | 'listIncomingRelationships' | 'getRelationship'
	>;
	profiles: Pick<UserAccountLookupService, 'getProfileAudience'>;
	limitConfigService: LimitConfigService;
	timeline: Pick<FeedTimelineService, 'buildBaseResponses' | 'applyViewerState'>;
	cache: Pick<FeedDiscoverCache, 'current'>;
}

// Keşfet: a cron build ranks, filters and stores one snapshot of ready post responses; every API process
// keeps it in memory (FeedDiscoverCache), so a page costs only the reader's own data: the block set (KV, 60 s) and
// the liked/voted partitions. The counts on a page come from the snapshot (at most ~65 s old); the request path never
// reads the counter keys (the first page's counters would be one hot key at 10 M).
export class FeedDiscoverService {
	private pages = 0;
	private overflowPages = 0;
	private pagesLoggedAt = Date.now();

	constructor(private readonly deps: FeedDiscoverServiceDeps) {}

	isEnabledFor(user: User): boolean {
		return this.resolve('feature_feed_discover', user) !== 0;
	}

	/**
	 * The cron build (refreshFeedDiscover, 30 s): -1 when another build started in the last 20 s or is still running, or
	 * when this one ran so long that another took over, else the snapshot size. Walks the ranking 1000 at a time until 1000
	 * posts qualify or 10 K were looked at, and takes the dead entries (deleted, not public, past 72 h, hidden, hidden
	 * author) out of the ranking so they cannot clog its top. The snapshot stays within 2 MB.
	 */
	async buildSnapshot(now = Date.now()): Promise<number> {
		const {repository, timeline} = this.deps;
		const startedAt = Date.now();
		const token = await repository.claimBuild();
		if (!token) return -1;
		if (this.resolve('feature_feed_discover', null) === 0) {
			await repository.putSnapshot({version: now, entries: []});
			await repository.pruneEvictionsBefore(now - EVICTION_MARGIN_MS);
			await repository.endBuild(token, startedAt);
			return 0;
		}
		const arms = this.mediaArms();
		const {ranked, pruned} = await repository.pruneRanked();
		const eligible: Array<{authorId: string; row: FeedPostRow}> = [];
		const dead: Array<bigint> = [];
		let scanned = 0;
		let skippedMedia = 0;
		for (let offset = 0; eligible.length < DISCOVER_SNAPSHOT_SIZE && offset < SCAN_MAX; offset += SCAN_PAGE) {
			const page = await repository.listRanked(offset, SCAN_PAGE);
			scanned += page.length;
			const judged = await this.judge(page, now, arms);
			eligible.push(...judged.eligible);
			dead.push(...judged.dead);
			skippedMedia += judged.skippedMedia;
			if (!(await repository.holdBuild(token))) return lostBuildGate();
			if (page.length < SCAN_PAGE) break;
		}
		await repository.unrankPosts(dead);
		const ordered = diversifyByAuthor(eligible).slice(0, DISCOVER_SNAPSHOT_SIZE);
		const built = await timeline.buildBaseResponses(
			ordered.map((entry) => entry.row),
			createRequestCache(),
		);
		const bases = arms.mediaAllowed ? built : built.map(withoutOpenPreviewMedia);
		const {kept, overBudget} = withinByteBudget(
			bases.map((post, index) => ({authorId: ordered[index]!.authorId, post})),
		);
		// A build that lost its gate may be older than the snapshot a later build already stored: it writes nothing.
		if (!(await repository.holdBuild(token))) return lostBuildGate();
		const bytes = await repository.putSnapshot({version: now, entries: kept});
		// Only now, and only evictions older than this snapshot: an older snapshot a process may still read keeps its
		// evictions readable.
		await repository.pruneEvictionsBefore(now - EVICTION_MARGIN_MS);
		await repository.endBuild(token, startedAt);
		const evicted = await repository.countEvictions();
		Logger.info(
			{
				ranked,
				pruned,
				scanned,
				eligible: eligible.length,
				removed: dead.length,
				skipped_media: skippedMedia,
				over_budget: overBudget,
				// Distinct authors in the list: a ring of accounts lifting each other shows as few authors.
				authors: new Set(kept.map((entry) => entry.authorId)).size,
				bytes,
				evicted_zcard: evicted,
			},
			'Built the Keşfet snapshot',
		);
		return kept.length;
	}

	async getPage(
		viewerId: UserID,
		options: {cursor?: string; limit: number},
	): Promise<{posts: Array<FeedPostResponse>; nextCursor: string | null}> {
		const snapshot = this.deps.cache.current();
		const blocks = await this.getBlockSet(viewerId);
		const page: Array<DiscoverEntry> = [];
		let index = parseDiscoverCursor(options.cursor);
		while (index < snapshot.entries.length && page.length < options.limit) {
			const chunk = snapshot.entries.slice(index, index + options.limit - page.length);
			const blocked = await this.blockedIn(
				blocks,
				viewerId,
				chunk.map((entry) => entry.authorId),
			);
			for (const entry of chunk) if (!blocked.has(entry.authorId)) page.push(entry);
			index += chunk.length;
		}
		this.countPage();
		return {
			posts: await this.deps.timeline.applyViewerState(
				viewerId,
				page.map((entry) => entry.post),
			),
			nextCursor: index < snapshot.entries.length ? `${snapshot.version}.${index}` : null,
		};
	}

	/**
	 * the author of `postId` while Keşfet would list it — the build's own rule in judge
	 * (public, inside 72 h, not hidden or deleted, a clean author old enough with the feed on, the media flags) — else
	 * null. Not the ranking or the snapshot: those change every 30 s and a post read minutes ago may have left them.
	 * The caller checks blocks and its own standing.
	 */
	async discoverAuthorOf(postId: bigint, now = Date.now()): Promise<User | null> {
		if (this.resolve('feature_feed_discover', null) === 0) return null;
		const {eligible} = await this.judge([postId], now, this.mediaArms());
		return eligible[0]?.author ?? null;
	}

	/**
	 * Of public posts a home feed shows a follower outside the profile rule, the ones Keşfet keeps out
	 * although they are public: hidden by reports, or media the arms keep off (judge's rule). One KV read.
	 */
	async keptOut(rows: Array<FeedPostRow>): Promise<Set<bigint>> {
		if (rows.length === 0) return new Set();
		const arms = this.mediaArms();
		const hidden = await this.deps.repository.listHidden(rows.map((row) => row.post_id));
		return new Set(
			rows.filter((row) => hidden.has(row.post_id) || !passesMediaArms(row, arms)).map((row) => row.post_id),
		);
	}

	/**
	 * Which of `authorIds` block the viewer or are blocked by them (the comment filter; the home feed's public-only
	 * authors, which pass `blocks` so a request reads the set once).
	 */
	async blockedAmong(
		viewerId: UserID,
		authorIds: Array<string>,
		blocks: Promise<DiscoverBlockSet> = this.getBlockSet(viewerId),
	): Promise<Set<string>> {
		return this.blockedIn(await blocks, viewerId, authorIds);
	}

	// The 60 s block set, plus point checks when the reader's incoming relationships overflow it.
	// TEMPORARY: a reader blocked by more than 5000 accounts gets one getRelationship read per unknown
	// author on each page (8 at a time). Trigger: overflow_pages / pages above 1 % in the "Keşfet pages that checked
	// blocks one by one" log. Path: a KV "blocked me" set written on block and unblock (upstream hook).
	private async blockedIn(blocks: DiscoverBlockSet, viewerId: UserID, authorIds: Array<string>): Promise<Set<string>> {
		const blocked = new Set(authorIds.filter((authorId) => blocks.ids.has(authorId)));
		if (!blocks.overflow) return blocked;
		this.overflowPages++;
		const unknown = [...new Set(authorIds)].filter((authorId) => !blocked.has(authorId));
		const verdicts = await mapWithConcurrency(unknown, BLOCK_CHECK_CONCURRENCY, (authorId) =>
			this.blocksViewer(authorId, viewerId),
		);
		unknown.forEach((authorId, position) => {
			if (verdicts[position]) blocked.add(authorId);
		});
		return blocked;
	}

	// Dead (taken out of the ranking): deleted, not public, past 72 h, hidden, no author or a hidden author. Skipped for
	// now: authors too new (24 h, 7 days with video), unverified or feed-disabled, images while
	// feature_feed_discover_media is 0 and a Bunny video while feature_feed_discover_video is 0.
	private async judge(postIds: Array<bigint>, now: number, arms: MediaArms) {
		const {repository, feedRepository} = this.deps;
		const dead = postIds.filter((id) => !isInTrendWindow(id, now));
		const live = postIds.filter((id) => isInTrendWindow(id, now));
		const hidden = await repository.listHidden(live);
		const rows = await feedRepository.getPosts(live.filter((id) => !hidden.has(id)));
		const candidates = live.flatMap((id) => {
			const row = rows.get(id);
			if (!row || !isPublicFeedPost(row) || hidden.has(id)) {
				dead.push(id);
				return [];
			}
			return [row];
		});
		const authorIds = [...new Set(candidates.map((row) => row.author_id))];
		// only an author whose level is "everyone" now; any other is skipped, not dead (they may open
		// their profile again). The level is the 60 s profile side record's, one per distinct author per build (at most
		// 10 K every 30 s, one build at a time behind the build gate).
		const [authors, audiences] = await Promise.all([
			this.listUsers(authorIds),
			mapWithConcurrency(authorIds, USERS_CONCURRENCY, (authorId) => this.deps.profiles.getProfileAudience(authorId)),
		]);
		const closed = new Set(authorIds.filter((_, index) => audiences[index] !== 'everyone'));
		let skippedMedia = 0;
		const eligible = candidates.flatMap((row) => {
			const author = authors.get(row.author_id);
			if (!author || (author.flags & DISCOVER_HIDDEN_AUTHOR_FLAGS) !== 0n) {
				dead.push(row.post_id);
				return [];
			}
			if (closed.has(row.author_id)) return [];
			if (!passesMediaArms(row, arms)) {
				skippedMedia++;
				return [];
			}
			const shown =
				isDiscoverAuthorEligible(author, now, {hasVideo: feedPostHasVideo(row)}) &&
				this.resolve('feature_feed', author) !== 0;
			return shown ? [{authorId: row.author_id.toString(), row, author}] : [];
		});
		return {eligible, dead, skippedMedia};
	}

	// listUsers reads its IDs in one IN; 100 at a time keeps each query small.
	private async listUsers(userIds: Array<UserID>): Promise<Map<UserID, User>> {
		const chunks = Array.from({length: Math.ceil(userIds.length / USERS_CHUNK)}, (_, index) =>
			userIds.slice(index * USERS_CHUNK, (index + 1) * USERS_CHUNK),
		);
		const pages = await mapWithConcurrency(chunks, USERS_CONCURRENCY, (chunk) =>
			this.deps.userRepository.listUsers(chunk),
		);
		return new Map(pages.flat().map((user) => [user.id, user]));
	}

	// Blocks either way, 60 s in KV; the block hook marks both accounts' keys so a stale set cannot land.
	async getBlockSet(viewerId: UserID): Promise<DiscoverBlockSet> {
		const cached = await this.deps.repository.getBlockSet(viewerId);
		if (cached) return cached;
		const [outgoing, incoming] = await Promise.all([
			this.deps.userRepository.listBlockedUserIds(viewerId),
			this.deps.userRepository.listIncomingRelationships(viewerId, {limit: INCOMING_BLOCK_CAP + 1}),
		]);
		const set: DiscoverBlockSet = {
			ids: new Set([
				...outgoing.map(String),
				...incoming
					.slice(0, INCOMING_BLOCK_CAP)
					.filter((row) => row.type === RelationshipTypes.BLOCKED)
					.map((row) => row.source_user_id.toString()),
			]),
			overflow: incoming.length > INCOMING_BLOCK_CAP,
		};
		await this.deps.repository.putBlockSet(viewerId, set);
		return set;
	}

	private async blocksViewer(authorId: string, viewerId: UserID): Promise<boolean> {
		const relationship = await this.deps.userRepository.getRelationship(
			createUserID(BigInt(authorId)),
			viewerId,
			RelationshipTypes.BLOCKED,
		);
		return relationship !== null;
	}

	// countHomePage pattern (FeedTimelineService): the overflow trigger is overflow pages over pages.
	private countPage(): void {
		this.pages++;
		const now = Date.now();
		if (now - this.pagesLoggedAt < PAGE_LOG_INTERVAL_MS) return;
		if (this.overflowPages > 0) {
			Logger.info(
				{pages: this.pages, overflow_pages: this.overflowPages},
				'Keşfet pages that checked blocks one by one',
			);
		}
		this.pages = 0;
		this.overflowPages = 0;
		this.pagesLoggedAt = now;
	}

	private mediaArms(): MediaArms {
		return {
			mediaAllowed: this.resolve('feature_feed_discover_media', null) !== 0,
			videoAllowed: this.resolve('feature_feed_discover_video', null) !== 0,
		};
	}

	// Instance-wide keys (feature_feed_discover_media, and the build's feature_feed_discover) read the default rule.
	private resolve(key: LimitKey, user: User | null): number {
		return resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user}),
			key,
			DEFAULT_RESTRICTED_LIMITS[key],
		);
	}
}

function lostBuildGate(): number {
	Logger.warn({}, 'A Keşfet build ran past its gate and another took it; dropping this build');
	return -1;
}

/** The entries that fit the snapshot's byte budget, in order; one that does not fit is left out and counted. */
function withinByteBudget(entries: Array<DiscoverEntry>): {kept: Array<DiscoverEntry>; overBudget: number} {
	const kept: Array<DiscoverEntry> = [];
	let bytes = SNAPSHOT_ENVELOPE_BYTES;
	for (const entry of entries) {
		const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
		if (bytes + size > SNAPSHOT_BYTE_BUDGET) continue;
		bytes += size;
		kept.push(entry);
	}
	return {kept, overBudget: entries.length - kept.length};
}

// Twitch and Kick card images can come from anywhere on those sites; while media stays out of Keşfet their cards
// drop to text there. YouTube thumbnails (through the media proxy) and invite cards stay: accepted risk.
function withoutOpenPreviewMedia(post: FeedPostBase): FeedPostBase {
	const preview = post.link_preview;
	if (!preview?.embed || (preview.kind !== 'twitch' && preview.kind !== 'kick')) return post;
	return {...post, link_preview: {...preview, embed: {...preview.embed, thumbnail: null, image: null, video: null}}};
}
