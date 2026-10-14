// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';

import {User} from '@app/features/user/models/User';
import {MAX_LOADED_MESSAGES} from '@fluxer/constants/src/LimitConstants';
import type {
	FeedCommentResponse,
	FeedLinkPreviewResponse,
	FeedPostResponse,
	FeedVideoResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {MessageAttachment} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {makeAutoObservable} from 'mobx';

export const FEED_PAGE_SIZE = 25;
// A timeline or comment thread holds at most as many items as a channel keeps loaded messages (200). Paging further
// back drops the newest items from the top, so a long scroll never grows memory; "new posts" starts over from the top.
export const MAX_LOADED_FEED_POSTS = MAX_LOADED_MESSAGES;
export const HOME_TIMELINE = 'home';
// Pages by the server's X-Next-Cursor (snapshot version.offset), never by post id; ends on a page without one.
export const DISCOVER_TIMELINE = 'discover';
export const DISCOVER_PAGE_SIZE = 20;
// The signed video URLs in a post live 2 to 3 h after it was loaded (longer for a video over 90 min; FeedVideoUrls on
// the server); a list older than an hour loads again before it is shown, so its posters and videos still load.
export const FEED_TIMELINE_STALE_MS = 3_600_000;

export function userTimelineKey(userId: string): string {
	return `user:${userId}`;
}

// 'paused': FeedCommands stopped asking for pages by itself after empty pages; the list offers to go on (retry).
export type FeedFailure = 'forbidden' | 'error' | 'paused';

// votes stays null until the viewer votes, is the author or the poll ends; the server never sends them before.
export interface FeedPoll {
	readonly options: ReadonlyArray<string>;
	readonly expiresAt: string;
	readonly votes: ReadonlyArray<number> | null;
	readonly voted: number | null;
}

export interface FeedPost {
	readonly id: string;
	readonly author: User;
	readonly content: string | null;
	readonly attachments: ReadonlyArray<MessageAttachment>;
	readonly editedAt: string | null;
	readonly likeCount: number;
	readonly commentCount: number;
	readonly liked: boolean;
	readonly isPublic: boolean;
	readonly poll: FeedPoll | null;
	readonly linkPreview: FeedLinkPreviewResponse | null;
	readonly video: FeedVideoResponse | null;
	// Both null while view counts are off on the server (it sends neither); the token is what POST /feed/views takes.
	readonly viewCount: number | null;
	readonly viewToken: string | null;
	// Micup akis-takip: whether the viewer follows the author — only on Discover posts; null elsewhere and from older servers.
	readonly authorFollowing: boolean | null;
}

export interface FeedComment {
	readonly id: string;
	readonly postId: string;
	readonly author: User;
	readonly content: string;
	// null on a top-level comment; replies are one level deep, so a reply's parent is always a top-level comment.
	readonly parentId: string | null;
	readonly replyCount: number;
}

interface PagedList {
	readonly droppedCount: number;
	readonly hasMore: boolean;
	readonly isLoading: boolean;
	readonly failure: FeedFailure | null;
}

export interface FeedTimelineState extends PagedList {
	readonly posts: ReadonlyArray<FeedPost>;
	readonly fetchedAt: number | null;
	// The server's X-Next-Before of the last page: where the next page starts when the page stopped at its read budget.
	// On the discover timeline it holds X-Next-Cursor, the only cursor there.
	readonly nextBefore?: string;
}

export interface FeedCommentThread extends PagedList {
	readonly nextBefore?: string;
	readonly comments: ReadonlyArray<FeedComment>;
}

const EMPTY_LIST: PagedList = {droppedCount: 0, hasMore: true, isLoading: false, failure: null};

function toPost(wire: FeedPostResponse): FeedPost {
	return {
		id: wire.id,
		author: new User(wire.author),
		content: wire.content,
		// Same wire shape as message attachments (2a.0 contract), so the message attachment components render it.
		attachments: wire.attachments as ReadonlyArray<MessageAttachment>,
		editedAt: wire.edited_at,
		likeCount: wire.like_count,
		commentCount: wire.comment_count,
		liked: wire.liked,
		// Servers before public posts, polls and previews leave these out; the one previewed link comes from the server.
		isPublic: wire.public ?? false,
		poll: wire.poll
			? {options: wire.poll.options, expiresAt: wire.poll.expires_at, votes: wire.poll.votes, voted: wire.poll.voted}
			: null,
		linkPreview: wire.link_preview ?? null,
		video: wire.video ?? null,
		viewCount: wire.view_count ?? null,
		viewToken: wire.view_token ?? null,
		authorFollowing: wire.author_following ?? null,
	};
}

function toComment(wire: FeedCommentResponse): FeedComment {
	return {
		id: wire.id,
		postId: wire.post_id,
		author: new User(wire.author),
		content: wire.content,
		// Servers before replies leave both out.
		parentId: wire.parent_id ?? null,
		replyCount: wire.reply_count ?? 0,
	};
}

function replyThreadKey(postId: string, commentId: string): string {
	return `${postId}:${commentId}`;
}

// Appends an older page below the loaded items, skipping ids already shown, and drops the newest items past the cap.
function appendPage<T extends {id: string}>(
	items: ReadonlyArray<T>,
	page: ReadonlyArray<T>,
): {items: ReadonlyArray<T>; dropped: number} {
	const seen = new Set(items.map((item) => item.id));
	const merged = [...items, ...page.filter((item) => !seen.has(item.id))];
	const dropped = Math.max(0, merged.length - MAX_LOADED_FEED_POSTS);
	return {items: dropped > 0 ? merged.slice(dropped) : merged, dropped};
}

class FeedTimeline {
	timelines: Record<string, FeedTimelineState> = {};
	threads: Record<string, FeedCommentThread> = {};
	// Keyed by replyThreadKey; the replies of one comment, newest first like the comments.
	replyThreads: Record<string, FeedCommentThread> = {};
	// Surfaces can show the same timeline at once (your posts in the feed page and in your profile), so it lives until
	// the last one closes it.
	private openCounts = new Map<string, number>();
	// Opened once by hold() and never closed: the feed page's lists, kept for the way back from a post page.
	private heldKeys = new Set<string>();
	// Bumped on READY, so a page requested in the previous session (maybe another account) is dropped.
	private session = 0;

	constructor() {
		makeAutoObservable<this, 'openCounts' | 'heldKeys' | 'session'>(
			this,
			{openCounts: false, heldKeys: false, session: false},
			{autoBind: true},
		);
	}

	reset(): void {
		this.session += 1;
		this.timelines = {};
		this.threads = {};
		this.replyThreads = {};
		this.openCounts.clear();
		this.heldKeys.clear();
	}

	// Nothing loaded in the previous session stays; open views keep their place and load again from the top.
	handleGatewayReady(): void {
		this.session += 1;
		this.threads = {};
		this.replyThreads = {};
		this.timelines = Object.fromEntries(
			Object.keys(this.timelines).map((key) => [key, {...EMPTY_LIST, posts: [], fetchedAt: null}]),
		);
	}

	getSession(): number {
		return this.session;
	}

	open(key: string): void {
		this.openCounts.set(key, (this.openCounts.get(key) ?? 0) + 1);
		if (!this.timelines[key]) {
			this.timelines = {...this.timelines, [key]: {...EMPTY_LIST, posts: [], fetchedAt: null}};
		}
	}

	// TEMPORARY: a held timeline (at most 200 posts) stays until the page reloads; the feed page holds three at most.
	hold(key: string): void {
		if (this.heldKeys.has(key)) return;
		this.heldKeys.add(key);
		this.open(key);
	}

	isStale(key: string): boolean {
		const fetchedAt = this.timelines[key]?.fetchedAt;
		return fetchedAt == null || Date.now() - fetchedAt > FEED_TIMELINE_STALE_MS;
	}

	close(key: string): void {
		const openCount = (this.openCounts.get(key) ?? 0) - 1;
		if (openCount > 0) {
			this.openCounts.set(key, openCount);
			return;
		}
		this.openCounts.delete(key);
		const {[key]: _, ...remaining} = this.timelines;
		this.timelines = remaining;
		this.pruneThreads();
	}

	getTimeline(key: string): FeedTimelineState | null {
		return this.timelines[key] ?? null;
	}

	getPost(postId: string): FeedPost | null {
		for (const timeline of Object.values(this.timelines)) {
			const post = timeline.posts.find((entry) => entry.id === postId);
			if (post) return post;
		}
		return null;
	}

	getCursor(key: string): string | undefined {
		const timeline = this.timelines[key];
		if (key === DISCOVER_TIMELINE) return timeline?.nextBefore;
		return timeline?.nextBefore ?? timeline?.posts.at(-1)?.id;
	}

	handleFetchPending(key: string): void {
		this.patchTimeline(key, {isLoading: true, failure: null});
	}

	// An empty page ends the list unless the server gave nextBefore; discover ends on any page without a cursor.
	// Returns how many posts the page added: a discover page can repeat only posts already shown.
	handleFetchSuccess(
		key: string,
		page: ReadonlyArray<FeedPostResponse>,
		restart: boolean,
		nextBefore?: string,
	): number {
		const timeline = this.timelines[key];
		if (!timeline) return 0;
		const posts = page.map(toPost);
		const hasMore = key === DISCOVER_TIMELINE ? nextBefore !== undefined : posts.length > 0 || nextBefore !== undefined;
		if (restart) {
			this.patchTimeline(key, {
				posts,
				droppedCount: 0,
				hasMore,
				isLoading: false,
				fetchedAt: Date.now(),
				nextBefore,
			});
			this.pruneThreads();
			return posts.length;
		}
		if (posts.length === 0) {
			this.patchTimeline(key, {isLoading: false, hasMore, nextBefore});
			return 0;
		}
		const {items, dropped} = appendPage(timeline.posts, posts);
		this.patchTimeline(key, {
			posts: items,
			droppedCount: timeline.droppedCount + dropped,
			hasMore,
			isLoading: false,
			fetchedAt: timeline.fetchedAt ?? Date.now(),
			nextBefore,
		});
		if (dropped > 0) this.pruneThreads();
		return items.length + dropped - timeline.posts.length;
	}

	handleFetchFailure(key: string, failure: FeedFailure): void {
		this.patchTimeline(key, {isLoading: false, failure, hasMore: failure !== 'forbidden'});
	}

	handleRetry(key: string): void {
		this.patchTimeline(key, {failure: null});
	}

	// Your new post goes on top of your home feed and of your own posts list, where either is open.
	handlePostCreated(wire: FeedPostResponse): void {
		const post = toPost(wire);
		for (const key of [HOME_TIMELINE, userTimelineKey(post.author.id)]) {
			const timeline = this.timelines[key];
			if (!timeline || timeline.posts.some((entry) => entry.id === post.id)) continue;
			this.patchTimeline(key, {posts: [post, ...timeline.posts]});
		}
	}

	// The server's current copy (after a vote) replaces the post wherever it is shown; it is never added anywhere. The
	// copy has no author_following (Discover pages only), so the follow state shown stays.
	handlePostUpdated(wire: FeedPostResponse): void {
		const post = toPost(wire);
		this.updatePost(post.id, (shown) =>
			post.authorFollowing === null ? {...post, authorFollowing: shown.authorFollowing} : post,
		);
	}

	handlePostRemoved(postId: string): void {
		for (const [key, timeline] of Object.entries(this.timelines)) {
			if (timeline.posts.some((entry) => entry.id === postId)) {
				this.patchTimeline(key, {posts: timeline.posts.filter((entry) => entry.id !== postId)});
			}
		}
		this.closeThread(postId);
	}

	// Idempotent, so an optimistic like and its rollback each flip a post once. Returns whether anything changed.
	handleLike(postId: string, liked: boolean): boolean {
		return this.updatePost(postId, (post) =>
			post.liked === liked ? null : {liked, likeCount: Math.max(0, post.likeCount + (liked ? 1 : -1))},
		);
	}

	/** Idempotent: flips every loaded post of `authorId` that carries a follow state; returns whether any changed. */
	handleAuthorFollowing(authorId: string, following: boolean): boolean {
		const flips = (post: FeedPost) => post.author.id === authorId && post.authorFollowing === !following;
		let changed = false;
		for (const [key, timeline] of Object.entries(this.timelines)) {
			if (!timeline.posts.some(flips)) continue;
			changed = true;
			this.patchTimeline(key, {
				posts: timeline.posts.map((post) => (flips(post) ? {...post, authorFollowing: following} : post)),
			});
		}
		return changed;
	}

	handleCommentCountShift(postId: string, delta: number): void {
		this.updatePost(postId, (post) => ({commentCount: Math.max(0, post.commentCount + delta)}));
	}

	openThread(postId: string): void {
		if (!this.threads[postId]) {
			this.threads = {...this.threads, [postId]: {...EMPTY_LIST, comments: []}};
		}
	}

	// The reply threads under the comments go with them.
	closeThread(postId: string): void {
		this.keepReplyThreads((key) => !key.startsWith(`${postId}:`));
		if (!this.threads[postId]) return;
		const {[postId]: _, ...remaining} = this.threads;
		this.threads = remaining;
	}

	getThread(postId: string): FeedCommentThread | null {
		return this.threads[postId] ?? null;
	}

	getThreadCursor(postId: string): string | undefined {
		return this.threads[postId]?.nextBefore ?? this.threads[postId]?.comments.at(-1)?.id;
	}

	handleThreadPending(postId: string): void {
		this.patchThread(postId, {isLoading: true, failure: null});
	}

	handleThreadSuccess(postId: string, page: ReadonlyArray<FeedCommentResponse>, nextBefore?: string): void {
		const thread = this.threads[postId];
		if (!thread) return;
		if (page.length === 0) {
			this.patchThread(postId, {isLoading: false, hasMore: nextBefore !== undefined, nextBefore});
			return;
		}
		const {items, dropped} = appendPage(thread.comments, page.map(toComment));
		this.patchThread(postId, {
			comments: items,
			droppedCount: thread.droppedCount + dropped,
			isLoading: false,
			nextBefore,
		});
	}

	handleThreadFailure(postId: string, failure: FeedFailure): void {
		this.patchThread(postId, {isLoading: false, failure, hasMore: failure !== 'forbidden'});
	}

	handleThreadRetry(postId: string): void {
		this.patchThread(postId, {failure: null});
	}

	handleThreadRestart(postId: string): void {
		if (this.threads[postId]) {
			this.threads = {...this.threads, [postId]: {...EMPTY_LIST, comments: []}};
		}
	}

	handleCommentCreated(wire: FeedCommentResponse): void {
		const thread = this.threads[wire.post_id];
		if (thread && !thread.comments.some((comment) => comment.id === wire.id)) {
			this.patchThread(wire.post_id, {comments: [toComment(wire), ...thread.comments]});
		}
		this.handleCommentCountShift(wire.post_id, 1);
	}

	// The server drops the replies with the comment, so the post loses 1 + the replies it counted.
	handleCommentRemoved(postId: string, commentId: string): void {
		const thread = this.threads[postId];
		const replyCount = thread?.comments.find((comment) => comment.id === commentId)?.replyCount ?? 0;
		if (thread) {
			this.patchThread(postId, {comments: thread.comments.filter((comment) => comment.id !== commentId)});
		}
		this.closeReplies(postId, commentId);
		this.handleCommentCountShift(postId, -(1 + replyCount));
	}

	openReplies(postId: string, commentId: string): void {
		const key = replyThreadKey(postId, commentId);
		if (!this.replyThreads[key]) {
			this.replyThreads = {...this.replyThreads, [key]: {...EMPTY_LIST, comments: []}};
		}
	}

	closeReplies(postId: string, commentId: string): void {
		const key = replyThreadKey(postId, commentId);
		this.keepReplyThreads((entry) => entry !== key);
	}

	getReplies(postId: string, commentId: string): FeedCommentThread | null {
		return this.replyThreads[replyThreadKey(postId, commentId)] ?? null;
	}

	getRepliesCursor(postId: string, commentId: string): string | undefined {
		const thread = this.getReplies(postId, commentId);
		return thread?.nextBefore ?? thread?.comments.at(-1)?.id;
	}

	handleRepliesPending(postId: string, commentId: string): void {
		this.patchReplies(postId, commentId, {isLoading: true, failure: null});
	}

	handleRepliesSuccess(
		postId: string,
		commentId: string,
		page: ReadonlyArray<FeedCommentResponse>,
		nextBefore?: string,
	): void {
		const thread = this.getReplies(postId, commentId);
		if (!thread) return;
		if (page.length === 0) {
			this.patchReplies(postId, commentId, {isLoading: false, hasMore: nextBefore !== undefined, nextBefore});
			return;
		}
		const {items, dropped} = appendPage(thread.comments, page.map(toComment));
		this.patchReplies(postId, commentId, {
			comments: items,
			droppedCount: thread.droppedCount + dropped,
			isLoading: false,
			nextBefore,
		});
	}

	handleRepliesFailure(postId: string, commentId: string, failure: FeedFailure): void {
		this.patchReplies(postId, commentId, {isLoading: false, failure, hasMore: failure !== 'forbidden'});
	}

	handleRepliesRetry(postId: string, commentId: string): void {
		this.patchReplies(postId, commentId, {failure: null});
	}

	// A reply counts on its comment and in the post's comment_count, as the server counts it.
	handleReplyCreated(wire: FeedCommentResponse): void {
		const commentId = wire.parent_id;
		if (!commentId) return;
		const thread = this.getReplies(wire.post_id, commentId);
		if (thread?.comments.some((reply) => reply.id === wire.id)) return;
		if (thread) this.patchReplies(wire.post_id, commentId, {comments: [toComment(wire), ...thread.comments]});
		this.shiftReplyCount(wire.post_id, commentId, 1);
		this.handleCommentCountShift(wire.post_id, 1);
	}

	// Counted down only for a reply it shows, so a second removal (a double click, a 404) takes nothing more.
	handleReplyRemoved(postId: string, commentId: string, replyId: string): void {
		const thread = this.getReplies(postId, commentId);
		if (!thread?.comments.some((reply) => reply.id === replyId)) return;
		this.patchReplies(postId, commentId, {comments: thread.comments.filter((reply) => reply.id !== replyId)});
		this.shiftReplyCount(postId, commentId, -1);
		this.handleCommentCountShift(postId, -1);
	}

	private updatePost(postId: string, change: (post: FeedPost) => Partial<FeedPost> | null): boolean {
		let changed = false;
		for (const [key, timeline] of Object.entries(this.timelines)) {
			const index = timeline.posts.findIndex((entry) => entry.id === postId);
			if (index === -1) continue;
			const updates = change(timeline.posts[index]!);
			if (!updates) continue;
			changed = true;
			const posts = [...timeline.posts];
			posts[index] = {...posts[index]!, ...updates};
			this.patchTimeline(key, {posts});
		}
		return changed;
	}

	private shiftReplyCount(postId: string, commentId: string, delta: number): void {
		const thread = this.threads[postId];
		if (!thread?.comments.some((comment) => comment.id === commentId)) return;
		this.patchThread(postId, {
			comments: thread.comments.map((comment) =>
				comment.id === commentId ? {...comment, replyCount: Math.max(0, comment.replyCount + delta)} : comment,
			),
		});
	}

	// Comment and reply threads live only while a loaded post shows them.
	private pruneThreads(): void {
		const shown = new Set(Object.values(this.timelines).flatMap((timeline) => timeline.posts.map((post) => post.id)));
		const kept = Object.entries(this.threads).filter(([postId]) => shown.has(postId));
		if (kept.length !== Object.keys(this.threads).length) {
			this.threads = Object.fromEntries(kept);
		}
		this.keepReplyThreads((key) => shown.has(key.slice(0, key.indexOf(':'))));
	}

	private keepReplyThreads(keep: (key: string) => boolean): void {
		const kept = Object.entries(this.replyThreads).filter(([key]) => keep(key));
		if (kept.length !== Object.keys(this.replyThreads).length) {
			this.replyThreads = Object.fromEntries(kept);
		}
	}

	private patchTimeline(key: string, changes: Partial<FeedTimelineState>): void {
		const timeline = this.timelines[key];
		if (timeline) this.timelines = {...this.timelines, [key]: {...timeline, ...changes}};
	}

	private patchThread(postId: string, changes: Partial<FeedCommentThread>): void {
		const thread = this.threads[postId];
		if (thread) this.threads = {...this.threads, [postId]: {...thread, ...changes}};
	}

	private patchReplies(postId: string, commentId: string, changes: Partial<FeedCommentThread>): void {
		const key = replyThreadKey(postId, commentId);
		const thread = this.replyThreads[key];
		if (thread) this.replyThreads = {...this.replyThreads, [key]: {...thread, ...changes}};
	}
}

const feedTimeline = new FeedTimeline();
ResettableStates.register(feedTimeline, feedTimeline.reset);
AccountScopedWork.registerCancellation(() => feedTimeline.reset());

export default feedTimeline;
