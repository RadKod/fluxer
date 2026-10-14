// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {type FeedHomeRow, type FeedPostRow, isPublicFeedPost} from '@app/api/database/types/FeedTypes';
import {feedDiscoverCache} from '@app/api/feed/discover/FeedDiscoverCache';
import type {DiscoverBlockSet, FeedDiscoverRepository} from '@app/api/feed/discover/FeedDiscoverRepository';
import {DISCOVER_HIDDEN_AUTHOR_FLAGS} from '@app/api/feed/discover/FeedDiscoverRules';
import {FeedDiscoverService} from '@app/api/feed/discover/FeedDiscoverService';
import {isFeedContentVisible} from '@app/api/feed/FeedContentVisibility';
import {feedInviteBases, mapFeedLinkPreview} from '@app/api/feed/FeedLinkPreview';
import {mapFeedMediaToResponse} from '@app/api/feed/FeedMediaService';
import {
	type AuthorAccess,
	type FeedRepository,
	feedDay,
	feedDayAt,
	HOME_WINDOW_DAYS,
	homeFloorId,
	NO_CURSOR,
} from '@app/api/feed/FeedRepository';
import type {FeedInteractionService} from '@app/api/feed/interaction/FeedInteractionService';
import {
	type FeedVideoBase,
	feedVideoBaseOf,
	isStreamMedia,
	mapFeedVideoToResponse,
} from '@app/api/feed/video/FeedVideoUrls';
import {signFeedViewTicket} from '@app/api/feed/views/FeedViews';
import type {FollowRepository} from '@app/api/follow/FollowRepository';
import type {IMediaService} from '@app/api/infrastructure/IMediaService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {createRequestCache, type RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import type {UserSettings} from '@app/api/models/UserSettings';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import type {ProfileViewer} from '@app/api/user/profile/ProfileAccessRules';
import {resolveProfileAudience} from '@app/api/user/profile/ProfilePrivacy';
import type {UserAccountLookupService} from '@app/api/user/services/UserAccountLookupService';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

const CELEBRITY_REFRESH_MS = 15_000;
// Changes are polled from a little before the last poll, so API servers whose clocks differ by up to a minute agree.
const CELEBRITY_POLL_OVERLAP_MS = 60_000;
const DAY_MS = 86_400_000;
const HOME_WINDOW_MS = HOME_WINDOW_DAYS * DAY_MS;
// feed_home is read in pages of this size whatever the client limit (at most 50), so the read count does not grow as
// the limit shrinks.
const HOME_PAGE_SIZE = 50;
// TEMPORARY: after mass unfollows a reader's feed_home holds many rows of authors no longer followed. A request
// reads at most 21 full pages; past one read per day partition that is at most this many more reads, so a request
// stays at HOME_WINDOW_DAYS + 2 + 20 = 52 feed_home reads. Such a page can come back short or empty although older
// posts remain; getHome then gives nextBefore so the client asks again below what was read. Path: drop the rows on
// unfollow (a worker job over the day partitions). Trigger: pages cut by the budget above 1 % of home pages. The rows
// expire with the 30 day TTL.
const HOME_EXTRA_PAGES = 20;
const ACCESS_CHECK_CONCURRENCY = 8;
// Raw pages the public view of a posts list reads at most to fill one.
const AUTHOR_PUBLIC_PAGES = 3;
// Authors a home request checks at most; past it the page stops before the first unchecked author, short but exact.
const AUTHOR_CHECK_BUDGET = 100;
// Home pages served and the ones a budget cut, logged at most once a minute per API process and only when one was cut:
// the GEÇİCİ triggers of HOME_EXTRA_PAGES (read_budget) and takeVisible (pulled_author_budget) are these over pages.
const CUT_LOG_INTERVAL_MS = 60_000;
// public_only_dropped: the temporary closedPosts trigger, over pages.
const NO_CUTS = {pages: 0, read_budget: 0, author_budget: 0, pulled_author_budget: 0, public_only_dropped: 0};

// Disabled (bans, NCMEC, a self-disabled account) and deleted accounts show no posts until they come back.
const HIDDEN_AUTHOR_FLAGS = UserFlags.DISABLED | UserFlags.DELETED;

export function isHiddenFeedAuthor(user: User): boolean {
	return (user.flags & HIDDEN_AUTHOR_FLAGS) !== 0n;
}

/**
 * an author's public posts reach strangers only while the author's effective level is "everyone" (16 or
 * older with a date of birth): the public bit of a new post, following through a Keşfet post and the suggestion pool.
 */
export function opensPublicPostsToStrangers(
	settings: Pick<UserSettings, 'profilePrivacy'> | null,
	user: Pick<User, 'dateOfBirth'>,
): boolean {
	return resolveProfileAudience(settings?.profilePrivacy, user.dateOfBirth) === 'everyone';
}

export type ProfileAccessReader = Pick<UserAccountLookupService, 'resolveProfileAccess' | 'getProfileAudience'>;

export interface FeedPollBase {
	options: Array<string>;
	expires_at: string;
	votes: Array<number>;
}

// A post response without the viewer's part: raw poll counts that applyViewerState hides or shows, and the unsigned
// Bunny video, signed per request; never sent as is. The view ticket is the viewer's own, so a base never holds
// one (the Keşfet snapshot is shared by every reader), nor author_following (the viewer's own, Keşfet only).
export type FeedPostBase = Omit<FeedPostResponse, 'liked' | 'poll' | 'video' | 'view_token' | 'author_following'> & {
	poll: FeedPollBase | null;
	video: FeedVideoBase | null;
};

type ViewerStates = Awaited<ReturnType<FeedInteractionService['getViewerStates']>>;

// While view counts are on, the count (a Keşfet snapshot built without it has none) and the viewer's ticket for
// POST /feed/views, signed only here, after the caller's access check; while off, neither. `followed` (Keşfet only)
// gives author_following on every post but the viewer's own.
function withViewerState(
	viewerId: UserID,
	bases: Array<FeedPostBase>,
	{liked, pollVotes}: ViewerStates,
	viewsOn: boolean,
	followed: ReadonlySet<UserID> | null,
): Array<FeedPostResponse> {
	const now = Date.now();
	const stream = Config.bunnyStream;
	return bases.map(({poll, video, view_count, ...base}) => {
		const response: FeedPostResponse = {...base, liked: liked.has(BigInt(base.id))};
		if (poll) {
			const voted = pollVotes.get(BigInt(base.id)) ?? null;
			const visible = voted !== null || base.author.id === viewerId.toString() || Date.parse(poll.expires_at) <= now;
			response.poll = {options: poll.options, expires_at: poll.expires_at, votes: visible ? poll.votes : null, voted};
		}
		// Only signed URLs, made after the caller's access check; without full Bunny settings the post shows no video.
		if (video && stream.enabled) {
			response.video = mapFeedVideoToResponse(stream, video, now);
		}
		if (viewsOn) {
			if (view_count !== undefined) response.view_count = view_count;
			response.view_token = signFeedViewTicket(viewerId, BigInt(base.id), now);
		}
		if (followed && base.author.id !== viewerId.toString()) {
			response.author_following = followed.has(createUserID(BigInt(base.author.id)));
		}
		return response;
	});
}

// One home request's author verdicts: true shows the author's posts, false hides them, missing means not judged.
// publicOnly: shown authors of whom only public posts are shown, only while `publicReach` (Keşfet, which
// that rule rides on, is on for the reader); `posts` keeps the rows read to tell (null when gone or kept out by
// Keşfet's moderation) for the page load, and `blocks` the reader's Keşfet block set, read once for those authors.
interface AuthorCheck {
	viewerId: UserID;
	viewer: ProfileViewer;
	requestCache: RequestCache;
	access: ProfileAccessReader;
	publicReach: boolean;
	visible: Map<UserID, boolean>;
	publicOnly: Set<UserID>;
	posts: Map<bigint, FeedPostRow | null>;
	blocks?: Promise<DiscoverBlockSet>;
}

interface FeedTimelineServiceDeps {
	repository: FeedRepository;
	followRepository: FollowRepository;
	userRepository: Pick<
		IUserRepository,
		'listUsers' | 'listBlockedUserIds' | 'listIncomingRelationships' | 'getRelationship'
	>;
	// The owner side record's level for Keşfet, outside a request.
	profiles: Pick<UserAccountLookupService, 'getProfileAudience'>;
	userCacheService: UserCacheService;
	interactionService: FeedInteractionService;
	discoverRepository: FeedDiscoverRepository;
	limitConfigService: LimitConfigService;
	mediaService: Pick<IMediaService, 'getExternalMediaProxyURL'>;
}

// The read side of the feed (hybrid fan-out). A home page merges three sources, newest first:
// - feed_home: the day partitions the fan-out jobs wrote, kept only for authors the reader still follows, which also
//   drops blocked authors (a block removes the follows both ways);
// - pulled (celebrity) authors, no extra table: every API process keeps the newest 20 post IDs of each
//   pulled author in memory, polled from KV every 15 s, and intersects them with the reader's following list (KV, 60 s).
//   A home read spends no Cassandra partition and no per-author KV read on them;
// - the reader's own posts, read only when feed:last:<reader> says there are any in the window.
// Each source yields its newest posts below the cursor, so the merged page is exact. Deleted posts are dropped when the
// rows load (feed_home takes no deletes). The page keeps only authors the reader may see under the profile access rule
// (as GET /users/:id/posts) who are not disabled or deleted, or, for a followed author the reader may not see under
// that rule, only their public posts (the public post rule, never past the author's own narrower privacy);
// they are dropped before the page is cut, so a page of hidden authors does not end the feed.
// Not temporary. Trigger: more than 10^6 pulled authors (process memory) -> keep the lists in a bucketed KV set.
export class FeedTimelineService {
	private celebrities = new Map<string, Array<bigint>>();
	private refreshedAt = 0;
	private refreshing: Promise<void> | null = null;
	private cuts = {...NO_CUTS};
	private cutsLoggedAt = Date.now();
	readonly discover: FeedDiscoverService;

	constructor(readonly deps: FeedTimelineServiceDeps) {
		this.discover = new FeedDiscoverService({
			repository: deps.discoverRepository,
			feedRepository: deps.repository,
			userRepository: deps.userRepository,
			profiles: deps.profiles,
			limitConfigService: deps.limitConfigService,
			timeline: this,
			cache: feedDiscoverCache,
		});
	}

	/** Loads the pulled authors whose lists changed since the last poll (the whole window on the first poll). */
	async refreshCelebrities(): Promise<void> {
		const {repository} = this.deps;
		const startedAt = Date.now();
		const since = this.refreshedAt === 0 ? startedAt - HOME_WINDOW_MS : this.refreshedAt - CELEBRITY_POLL_OVERLAP_MS;
		const changed = await repository.listCelebritiesChangedSince(since);
		const lists = await repository.getCelebrityRecentMany(changed);
		changed.forEach((authorId, index) => {
			const list = lists[index];
			if (list && list.length > 0) {
				this.celebrities.set(authorId, list);
			} else {
				this.celebrities.delete(authorId);
			}
		});
		const floor = homeFloorId(startedAt);
		for (const [authorId, list] of this.celebrities) {
			if (list[0]! < floor) this.celebrities.delete(authorId);
		}
		this.refreshedAt = startedAt;
		// A day past the window: those authors' lists have expired and no poll asks that far back.
		await repository.pruneCelebrities(startedAt - HOME_WINDOW_MS - DAY_MS);
	}

	/**
	 * One home page and nextBefore, the `before` to continue from, or null when nothing is known to remain. A full page
	 * continues below its last post even when deleted posts drop out as the rows load; a short page cut by the read or
	 * author check budget continues below the lowest row it read, so an empty page with nextBefore is not the end.
	 */
	async getHome(
		viewerId: UserID,
		options: {
			before?: bigint;
			limit: number;
			access: ProfileAccessReader;
			publicReach: boolean;
			viewer: ProfileViewer;
			requestCache: RequestCache;
		},
	): Promise<{posts: Array<FeedPostRow>; nextBefore: bigint | null}> {
		const {limit} = options;
		const cursor = options.before ?? NO_CURSOR;
		await this.refreshCelebritiesIfStale();
		const now = Date.now();
		const floor = homeFloorId(now);
		const [following, own] = await Promise.all([
			this.deps.followRepository.getFollowingIds(viewerId),
			this.ownPostIds(viewerId, cursor, limit, floor),
		]);
		const followed = new Set(following.map(String));
		const check: AuthorCheck = {
			viewerId,
			viewer: options.viewer,
			requestCache: options.requestCache,
			access: options.access,
			publicReach: options.publicReach,
			visible: new Map([[viewerId, true]]),
			publicOnly: new Set(),
			posts: new Map(),
		};
		const home = await this.readHome(check, followed, cursor, limit, now);
		const authorOf = new Map<bigint, UserID>(own.map((postId) => [postId, viewerId]));
		for (const row of home.rows) authorOf.set(row.post_id, row.author_id);
		for (const authorId of followed) {
			for (const postId of this.celebrities.get(authorId) ?? []) {
				if (postId < cursor && postId >= floor) authorOf.set(postId, createUserID(BigInt(authorId)));
			}
		}
		const sorted = [...authorOf.keys()]
			.filter((postId) => postId > home.unreadBelow)
			.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
		const {page, complete} = await this.takeVisible(check, sorted, authorOf, limit);
		if (!complete) this.cuts.pulled_author_budget++;
		this.countHomePage(now);
		let nextBefore: bigint | null = null;
		if (page.length === limit) {
			nextBefore = page.at(-1)!;
		} else if (complete && home.unreadBelow > 0n) {
			// Every candidate above unreadBelow was taken; the row at unreadBelow may be unjudged, so it is read again.
			nextBefore = home.unreadBelow + 1n;
		}
		return {posts: await this.loadPosts(page, check.posts), nextBefore};
	}

	/**
	 * One page of an author's posts, newest first. publicOnly (the public profile view) keeps the posts marked
	 * public, reading at most three raw pages to fill one (the comment list's pattern); when those end short with rows
	 * left, nextBefore is the last raw ID read, so an empty page with it is not the end. Otherwise nextBefore is null.
	 */
	async getAuthorPosts(
		authorId: UserID,
		options: {before?: bigint; limit: number; publicOnly?: boolean},
	): Promise<{posts: Array<FeedPostRow>; nextBefore: bigint | null}> {
		const {limit} = options;
		const {repository} = this.deps;
		if (!options.publicOnly) {
			const ids = await repository.listAuthorPostIds(authorId, {before: options.before, limit});
			return {posts: await this.loadPosts(ids), nextBefore: ids.length === limit ? ids.at(-1)! : null};
		}
		const posts: Array<FeedPostRow> = [];
		let before = options.before;
		for (let pages = 0; pages < AUTHOR_PUBLIC_PAGES; pages++) {
			const ids = await repository.listAuthorPostIds(authorId, {before, limit});
			for (const row of await this.loadPosts(ids)) {
				if (!isPublicFeedPost(row)) continue;
				posts.push(row);
				if (posts.length === limit) return {posts, nextBefore: row.post_id};
			}
			if (ids.length < limit) return {posts, nextBefore: null};
			before = ids.at(-1)!;
		}
		return {posts, nextBefore: before!};
	}

	async getPost(postId: bigint): Promise<FeedPostRow | null> {
		return this.deps.repository.getPost(postId);
	}

	/**
	 * A page's viewer-free part: what the Keşfet snapshot keeps in memory for every reader. like_count, comment_count,
	 * the raw poll votes and view_count (only while view counts are on) come from the KV counters, or the row when KV
	 * has none.
	 */
	async buildBaseResponses(rows: Array<FeedPostRow>, requestCache: RequestCache): Promise<Array<FeedPostBase>> {
		const [authors, counts] = await Promise.all([
			this.deps.userCacheService.getUserPartialResponses([...new Set(rows.map((row) => row.author_id))], requestCache),
			this.deps.interactionService.getPostCounts(rows),
		]);
		const inviteBases = feedInviteBases();
		const previews = rows.map((row) => mapFeedLinkPreview(row, this.deps.mediaService, inviteBases));
		return rows.map((row, index) => ({
			id: row.post_id.toString(),
			author: authors.get(row.author_id)!,
			content: row.content ?? null,
			attachments: (row.media ?? [])
				.filter((media) => !isStreamMedia(media))
				.map((media) => mapFeedMediaToResponse(row.author_id, media)),
			video: feedVideoOf(row),
			edited_at: row.edited_at?.toISOString() ?? null,
			like_count: counts[index]!.like_count,
			comment_count: counts[index]!.comment_count,
			public: isPublicFeedPost(row),
			poll:
				row.poll_options && row.poll_expires_at
					? {
							options: row.poll_options,
							expires_at: row.poll_expires_at.toISOString(),
							votes: counts[index]!.poll_votes ?? row.poll_options.map(() => 0),
						}
					: null,
			...(previews[index] ? {link_preview: previews[index]} : {}),
			...(counts[index]!.view_count !== null ? {view_count: counts[index]!.view_count} : {}),
		}));
	}

	/**
	 * Keşfet only (its one caller): liked, the viewer's vote and poll results, which stay hidden until the viewer votes,
	 * is the author or the poll ends, and author_following, from one read of the viewer's own follow partition for the
	 * page's other authors.
	 */
	async applyViewerState(viewerId: UserID, bases: Array<FeedPostBase>): Promise<Array<FeedPostResponse>> {
		const ids = bases.map((base) => BigInt(base.id));
		const pollIds = bases.filter((base) => base.poll !== null).map((base) => BigInt(base.id));
		const authorIds = [...new Set(bases.map((base) => base.author.id))]
			.filter((authorId) => authorId !== viewerId.toString())
			.map((authorId) => createUserID(BigInt(authorId)));
		const {interactionService, followRepository} = this.deps;
		const [states, followed, cutoffs] = await Promise.all([
			interactionService.getViewerStates(viewerId, ids, pollIds),
			followRepository.getFollowedAmong(viewerId, authorIds),
			this.deps.userCacheService.getContentHiddenSince(
				bases.map((base) => createUserID(BigInt(base.author.id))),
				createRequestCache(),
			),
		]);
		const visible = bases.filter((base) =>
			isFeedContentVisible(cutoffs, createUserID(BigInt(base.author.id)), BigInt(base.id)),
		);
		return withViewerState(viewerId, visible, states, interactionService.viewsEnabled(), followed);
	}

	/** The viewer's state needs only the row IDs, so it is read beside the base responses, not after them. */
	async toResponses(
		rows: Array<FeedPostRow>,
		requestCache: RequestCache,
		viewerId: UserID,
	): Promise<Array<FeedPostResponse>> {
		const pollIds = rows.filter((row) => row.poll_options && row.poll_expires_at).map((row) => row.post_id);
		const [bases, states, cutoffs] = await Promise.all([
			this.buildBaseResponses(rows, requestCache),
			this.deps.interactionService.getViewerStates(
				viewerId,
				rows.map((row) => row.post_id),
				pollIds,
			),
			this.deps.userCacheService.getContentHiddenSince(
				rows.map((row) => row.author_id),
				requestCache,
			),
		]);
		const visible = bases.filter((base) =>
			isFeedContentVisible(cutoffs, createUserID(BigInt(base.author.id)), BigInt(base.id)),
		);
		return withViewerState(viewerId, visible, states, this.deps.interactionService.viewsEnabled(), null);
	}

	private countHomePage(now: number): void {
		this.cuts.pages++;
		if (now - this.cutsLoggedAt < CUT_LOG_INTERVAL_MS) return;
		const {public_only_dropped, ...budgets} = this.cuts;
		if (budgets.read_budget + budgets.author_budget + budgets.pulled_author_budget + public_only_dropped > 0) {
			// public_only_dropped only when a row was dropped, so a budget-only line keeps its shape.
			Logger.info(public_only_dropped > 0 ? this.cuts : budgets, 'Feed home pages cut by a budget');
		}
		this.cuts = {...NO_CUTS};
		this.cutsLoggedAt = now;
	}

	private async refreshCelebritiesIfStale(): Promise<void> {
		if (Date.now() - this.refreshedAt < CELEBRITY_REFRESH_MS) return;
		this.refreshing ??= this.refreshCelebrities()
			.catch((error) => Logger.warn({error}, 'Refreshing the pulled feed authors failed; using the last lists'))
			.finally(() => {
				this.refreshing = null;
			});
		await this.refreshing;
	}

	// The reader's own posts in the window; feed:last:<reader> skips the read for readers who have not posted.
	private async ownPostIds(viewerId: UserID, cursor: bigint, limit: number, floor: bigint): Promise<Array<bigint>> {
		const last = await this.deps.repository.getLastPost(viewerId);
		if (last === null || last < floor) return [];
		const ids = await this.deps.repository.listAuthorPostIds(viewerId, {
			before: cursor === NO_CURSOR ? undefined : cursor,
			limit,
		});
		return ids.filter((postId) => postId >= floor);
	}

	/**
	 * Newest fanned-out post IDs below the cursor from authors the reader still follows and may see, walking the day
	 * partitions back to the window start.
	 * TEMPORARY: one day partition after another, so a reader whose followed accounts rarely post reads up to 31 small
	 * partitions for a page. Read the days in parallel batches, or keep a per-reader "last filled day" marker, once the
	 * home read p99 passes 50 ms. `unreadBelow` is 0 when the walk was complete, or the lowest ID it could not judge when
	 * it stopped at the page budget or the author check budget: the page then must not reach below it. The first author
	 * check asks only for the rows the page still needs (limit=1: one author); once one comes back short the rest go
	 * at least ACCESS_CHECK_CONCURRENCY at a time, so hidden authors are judged in parallel.
	 */
	private async readHome(
		check: AuthorCheck,
		followed: ReadonlySet<string>,
		cursor: bigint,
		limit: number,
		now: number,
	): Promise<{rows: Array<FeedHomeRow>; unreadBelow: bigint}> {
		const kept: Array<FeedHomeRow> = [];
		if (followed.size === 0) return {rows: kept, unreadBelow: 0n};
		const today = feedDayAt(now);
		const floorDay = today - HOME_WINDOW_DAYS;
		// A cursor past tomorrow holds no rows; clamping it keeps a request at HOME_WINDOW_DAYS + 2 day partitions.
		let day = cursor === NO_CURSOR ? today : Math.min(feedDay(cursor), today + 1);
		let before = cursor;
		let extraPages = 0;
		let checked = false;
		while (kept.length < limit && day >= floorDay) {
			const rows = await this.deps.repository.listHome(check.viewerId, day, before, HOME_PAGE_SIZE);
			const followedRows = rows.filter((row) => followed.has(row.author_id.toString()));
			for (let next = 0; kept.length < limit && next < followedRows.length; ) {
				const need = limit - kept.length;
				const chunk = followedRows.slice(next, next + (checked ? Math.max(need, ACCESS_CHECK_CONCURRENCY) : need));
				checked = true;
				await this.checkAuthors(
					check,
					chunk.map((row) => row.author_id),
				);
				const closed = await this.closedPosts(
					check,
					chunk.map((row) => [row.post_id, row.author_id]),
				);
				for (const row of chunk) {
					const visible = check.visible.get(row.author_id);
					if (visible === undefined) {
						this.cuts.author_budget++;
						return {rows: kept, unreadBelow: row.post_id};
					}
					if (visible && !closed.has(row.post_id)) kept.push(row);
				}
				next += chunk.length;
			}
			if (rows.length < HOME_PAGE_SIZE) {
				day--;
				before = NO_CURSOR;
			} else {
				before = rows.at(-1)!.post_id;
				if (++extraPages > HOME_EXTRA_PAGES) {
					this.cuts.read_budget++;
					return {rows: kept, unreadBelow: before};
				}
			}
		}
		return {rows: kept, unreadBelow: 0n};
	}

	/**
	 * The first `limit` candidates whose authors the reader may see, checking the authors a page's worth at a time.
	 * `complete` is false when the author check budget stopped it before an unjudged author.
	 * TEMPORARY: such a short page gives no nextBefore: continuing at that candidate could loop, since the next
	 * request's walk may spend the budget again before reaching it, so an empty one ends the feed early. Needs 100+
	 * followed hidden authors plus a pulled author. Path: judge the pulled candidates before the walk. Trigger:
	 * home pages cut here above 0.1 %.
	 */
	private async takeVisible(
		check: AuthorCheck,
		sorted: Array<bigint>,
		authorOf: ReadonlyMap<bigint, UserID>,
		limit: number,
	): Promise<{page: Array<bigint>; complete: boolean}> {
		const page: Array<bigint> = [];
		for (let next = 0; page.length < limit && next < sorted.length; ) {
			const chunk = sorted.slice(next, next + limit - page.length);
			await this.checkAuthors(
				check,
				chunk.map((postId) => authorOf.get(postId)!),
			);
			const closed = await this.closedPosts(
				check,
				chunk.map((postId) => [postId, authorOf.get(postId)!]),
			);
			for (const postId of chunk) {
				const visible = check.visible.get(authorOf.get(postId)!);
				if (visible === undefined) return {page, complete: false};
				if (visible && !closed.has(postId)) page.push(postId);
			}
			next += chunk.length;
		}
		return {page, complete: true};
	}

	/**
	 * Judges the authors not judged yet in this request, up to the budget. Disabled and deleted authors come from one
	 * users read (IN over the authors, uncached, so a ban hides posts at once); the profile access rule from a 60 s KV
	 * verdict per reader and author (AuthorAccess): '1' the full view, 'p' the public view (a standing stranger of
	 * a public author), '0' else. A cached verdict holds only while the author's level still allows it, read from the
	 * owner side record: 'p' while the author is public, '1' unless the author is "only me"; otherwise the
	 * author is hidden for this request and the verdict is left to expire. Under "friends and mutual follows" a '1' is
	 * judged again through the pair record (a KV read): a community bond no longer opens there and the verdict may
	 * predate the narrowing. A friendship, request or follow change drops both verdicts (the 'feed' pair hook). A 'p'
	 * author shows public posts only, while
	 * Keşfet is on for the reader (publicReach), their account flags are clean (the Keşfet author flags, from the same
	 * users read) and neither blocks the other (the reader's Keşfet block set, read once per request and only when such an
	 * author comes up: the block hook that drops the follows can fail and wait for its retry job). The home feed spends no
	 * daily stranger budget.
	 * TEMPORARY: a verdict miss runs the profile access rule: 1-3 point reads on the reader's partitions per author
	 * plus the reader's guild IDs and private channels once per request (requestCache); the author's partitions are not
	 * read (the 60 s owner side record), so a home page of 20 authors not seen in the last minute costs about 60 reads.
	 * Path: drop follows when access is lost (worker jobs on guild leave, unfriend and privacy change) and skip the check.
	 * Trigger: home access checks above 10 % of Cassandra reads, or home p99 above 50 ms. The users read: a per-author
	 * hidden bit in KV, written by the ban, disable and NCMEC paths (trigger: home pages above 20 % of users reads).
	 */
	private async checkAuthors(check: AuthorCheck, authorIds: Array<UserID>): Promise<void> {
		const {viewerId, access, visible} = check;
		const room = AUTHOR_CHECK_BUDGET + 1 - visible.size;
		const unjudged = [...new Set(authorIds)].filter((authorId) => !visible.has(authorId)).slice(0, room);
		if (unjudged.length === 0) return;
		for (const authorId of unjudged) visible.set(authorId, false);
		const shown = (await this.deps.userRepository.listUsers(unjudged)).filter((user) => !isHiddenFeedAuthor(user));
		const cached = await this.deps.repository.getAuthorAccess(
			viewerId,
			shown.map((user) => user.id),
		);
		const verdicts = new Map<UserID, AuthorAccess>();
		const unknown: Array<User> = [];
		const kept: Array<[UserID, AuthorAccess]> = [];
		shown.forEach((user, index) => {
			const verdict = cached[index];
			if (verdict == null) unknown.push(user);
			else if (verdict === '0') verdicts.set(user.id, verdict);
			else kept.push([user.id, verdict]);
		});
		const [fresh] = await Promise.all([
			mapWithConcurrency(unknown, ACCESS_CHECK_CONCURRENCY, async (user) => {
				const verdict = await authorAccess(check, user.id);
				verdicts.set(user.id, verdict);
				return [user.id, verdict] as [UserID, AuthorAccess];
			}),
			mapWithConcurrency(kept, ACCESS_CHECK_CONCURRENCY, async ([authorId, verdict]) => {
				const audience = await access.getProfileAudience(authorId);
				if (verdict === '1' && audience === 'close') {
					verdicts.set(authorId, await authorAccess(check, authorId));
				} else if (verdict === 'p' ? audience === 'everyone' : audience !== null && audience !== 'only_me') {
					verdicts.set(authorId, verdict);
				}
			}),
		]);
		await this.deps.repository.putAuthorAccess(viewerId, fresh);
		for (const user of shown) {
			if (verdicts.get(user.id) === '1') visible.set(user.id, true);
		}
		const publicOnly = check.publicReach
			? shown.filter((user) => verdicts.get(user.id) === 'p' && (user.flags & DISCOVER_HIDDEN_AUTHOR_FLAGS) === 0n)
			: [];
		if (publicOnly.length === 0) return;
		check.blocks ??= this.discover.getBlockSet(viewerId);
		const blocked = await this.discover.blockedAmong(
			viewerId,
			publicOnly.map((user) => user.id.toString()),
			check.blocks,
		);
		for (const user of publicOnly) {
			if (blocked.has(user.id.toString())) continue;
			visible.set(user.id, true);
			check.publicOnly.add(user.id);
		}
	}

	/**
	 * The candidates of public-only authors whose post is not public or is gone, read through the 60 s post cache once per
	 * request; the rows stay in `check.posts` for the page load. A public post Keşfet keeps out (hidden by reports, media
	 * its arms keep off) is noted as gone: those followers see what Keşfet would. Only the non-public ones count as
	 * public_only_dropped (a deleted post drops out for every author).
	 * TEMPORARY: the fan-out writes a non-public post into these followers' feed_home too, so it is read here
	 * and dropped. Path: the fan-out writes the post's public bit into the feed_home row (a column) and readHome filters
	 * before reading posts. Trigger: public_only_dropped / pages above 10 in the "Feed home pages cut by a budget" log, or
	 * home p99 above 50 ms.
	 */
	private async closedPosts(
		check: AuthorCheck,
		candidates: Array<[postId: bigint, authorId: UserID]>,
	): Promise<Set<bigint>> {
		const ofPublicOnly = candidates.filter(([, authorId]) => check.publicOnly.has(authorId)).map(([postId]) => postId);
		const unread = ofPublicOnly.filter((postId) => !check.posts.has(postId));
		if (unread.length > 0) {
			const rows = await this.deps.repository.getPosts(unread);
			const keptOut = await this.discover.keptOut([...rows.values()].filter((row) => isPublicFeedPost(row)));
			for (const postId of unread) {
				const row = rows.get(postId) ?? null;
				check.posts.set(postId, row && !keptOut.has(postId) ? row : null);
				if (row && !isPublicFeedPost(row)) this.cuts.public_only_dropped++;
			}
		}
		return new Set(
			ofPublicOnly.filter((postId) => {
				const row = check.posts.get(postId);
				return !row || !isPublicFeedPost(row);
			}),
		);
	}

	// `known`: rows this request already read (closedPosts), not read again.
	private async loadPosts(
		postIds: Array<bigint>,
		known: ReadonlyMap<bigint, FeedPostRow | null> = new Map(),
	): Promise<Array<FeedPostRow>> {
		const rows = await this.deps.repository.getPosts(postIds.filter((postId) => !known.has(postId)));
		return postIds.flatMap((postId) => {
			const row = known.has(postId) ? known.get(postId) : rows.get(postId);
			return row ? [row] : [];
		});
	}
}

function feedVideoOf(row: FeedPostRow): FeedVideoBase | null {
	const media = row.media?.find(isStreamMedia);
	return media ? feedVideoBaseOf(media) : null;
}

// '1' for the full view, 'p' for the public view (public posts only), '0' for anything else.
async function authorAccess(check: AuthorCheck, authorId: UserID): Promise<AuthorAccess> {
	const {access, viewerId, viewer, requestCache} = check;
	try {
		const {view} = await access.resolveProfileAccess({userId: viewerId, targetId: authorId, viewer, requestCache});
		return view === 'full' ? '1' : view === 'public' ? 'p' : '0';
	} catch (error) {
		if (error instanceof UnknownUserError) return '0';
		throw error;
	}
}
