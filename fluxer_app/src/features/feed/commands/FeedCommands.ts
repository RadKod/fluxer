// SPDX-License-Identifier: AGPL-3.0-or-later

import * as AnalyticsCommands from '@app/features/analytics/commands/AnalyticsCommands';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import FeedTimeline, {
	DISCOVER_PAGE_SIZE,
	DISCOVER_TIMELINE,
	FEED_PAGE_SIZE,
	HOME_TIMELINE,
} from '@app/features/feed/state/FeedTimeline';
import {FEED_MAX_IMAGE_BYTES, validateFeedImages} from '@app/features/feed/utils/FeedUtils';
import {http} from '@app/features/platform/transport/RestTransport';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {
	FeedCommentListResponse,
	FeedCommentResponse,
	FeedPostListResponse,
	FeedPostResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {PresignedAttachmentUploadResponse} from '@fluxer/schema/src/domains/message/AttachmentUploadSchemas';

const logger = new Logger('FeedCommands');

// Empty pages with X-Next-Before in a row that the list follows by itself, and the wait before each. The home route
// allows 20 requests per 10 s and every 429 counts against the IP (shared by many phones behind CGNAT), so the chain
// stays well under it; past the limit the list shows a button instead.
const AUTO_CONTINUE_LIMIT = 5;
const AUTO_CONTINUE_DELAY_MS = 600;

// 'gone': the post or comment was deleted, or the server hides it (block). 'invalid': refused before any request, or a
// new post the server refused as malformed (400).
export type FeedOutcome = 'ok' | 'gone' | 'forbidden' | 'failed' | 'invalid';

export function outcomeOf(error: unknown): FeedOutcome {
	const status = error instanceof HttpError ? error.status : null;
	if (status === 404) return 'gone';
	if (status === 403) return 'forbidden';
	return 'failed';
}

// Keys are HOME_TIMELINE, DISCOVER_TIMELINE or userTimelineKey(userId).
function timelineEndpoint(key: string): string {
	if (key === DISCOVER_TIMELINE) return Endpoints.FEED_DISCOVER;
	return key === HOME_TIMELINE ? Endpoints.FEED_HOME : Endpoints.USER_FEED_POSTS(key.slice('user:'.length));
}

function pageQuery(before: string | undefined): Record<string, string | number> {
	return before ? {limit: FEED_PAGE_SIZE, before} : {limit: FEED_PAGE_SIZE};
}

function timelineQuery(key: string, cursor: string | undefined): Record<string, string | number> {
	if (key !== DISCOVER_TIMELINE) return pageQuery(cursor);
	return cursor ? {limit: DISCOVER_PAGE_SIZE, cursor} : {limit: DISCOVER_PAGE_SIZE};
}

async function fetchTimelinePage(key: string, restart: boolean, autoContinued = 0): Promise<void> {
	const before = restart ? undefined : FeedTimeline.getCursor(key);
	const session = FeedTimeline.getSession();
	FeedTimeline.handleFetchPending(key);
	try {
		const response = await http.get<FeedPostListResponse>(timelineEndpoint(key), {query: timelineQuery(key, before)});
		if (session !== FeedTimeline.getSession()) return;
		const page = response.body ?? [];
		const nextBefore = response.headers[key === DISCOVER_TIMELINE ? 'x-next-cursor' : 'x-next-before'];
		const added = FeedTimeline.handleFetchSuccess(key, page, restart, nextBefore);
		// A page that adds nothing (empty, or on Discover only posts already shown) renders nothing that would scroll the
		// list to its next page, so ask for it here.
		if (added === 0 && nextBefore !== undefined) await continueAfterEmptyPage(key, nextBefore, autoContinued);
	} catch (error) {
		logger.warn(`Failed to load feed timeline ${key}:`, error);
		if (session !== FeedTimeline.getSession()) return;
		// 403: the feed is off for this account; 404: the user is gone or hidden. Either way paging stops.
		FeedTimeline.handleFetchFailure(key, outcomeOf(error) === 'failed' ? 'error' : 'forbidden');
	}
}

// Not loading while it waits, so "new posts" still works; a refresh in the meantime moves the cursor and ends the chain.
async function continueAfterEmptyPage(key: string, nextBefore: string, autoContinued: number): Promise<void> {
	if (autoContinued >= AUTO_CONTINUE_LIMIT) {
		FeedTimeline.handleFetchFailure(key, 'paused');
		return;
	}
	const session = FeedTimeline.getSession();
	await new Promise((resolve) => setTimeout(resolve, AUTO_CONTINUE_DELAY_MS));
	const timeline = FeedTimeline.getTimeline(key);
	if (session !== FeedTimeline.getSession() || !timeline || timeline.isLoading || timeline.failure) return;
	if (FeedTimeline.getCursor(key) !== nextBefore) return;
	await fetchTimelinePage(key, false, autoContinued + 1);
}

export async function loadNextPage(key: string): Promise<void> {
	const timeline = FeedTimeline.getTimeline(key);
	if (!timeline || timeline.isLoading || !timeline.hasMore || timeline.failure) return;
	await fetchTimelinePage(key, false);
}

// Pull-only refresh behind the "new posts" button: new posts are never pushed and the client does not poll.
export async function refresh(key: string): Promise<void> {
	const timeline = FeedTimeline.getTimeline(key);
	if (!timeline || timeline.isLoading) return;
	await fetchTimelinePage(key, true);
}

export function retry(key: string): Promise<void> {
	FeedTimeline.handleRetry(key);
	return loadNextPage(key);
}

const pendingLikes = new Set<string>();

// Optimistic: the post flips at once and flips back if the server refuses. A click while one is in flight is ignored.
export async function setLiked(postId: string, liked: boolean): Promise<FeedOutcome> {
	if (pendingLikes.has(postId) || !FeedTimeline.handleLike(postId, liked)) return 'ok';
	pendingLikes.add(postId);
	try {
		if (liked) {
			await http.put(Endpoints.FEED_POST_LIKE(postId));
			AnalyticsCommands.track('feed_like');
		} else {
			await http.delete(Endpoints.FEED_POST_LIKE(postId));
		}
		return 'ok';
	} catch (error) {
		logger.warn(`Failed to ${liked ? 'like' : 'unlike'} post ${postId}:`, error);
		FeedTimeline.handleLike(postId, !liked);
		const outcome = outcomeOf(error);
		if (outcome === 'gone') FeedTimeline.handlePostRemoved(postId);
		return outcome;
	} finally {
		pendingLikes.delete(postId);
	}
}

async function uploadMedia(files: ReadonlyArray<File>) {
	const response = await http.post<PresignedAttachmentUploadResponse>(Endpoints.FEED_ATTACHMENTS, {
		body: {
			attachments: files.map((file, index) => ({
				id: index,
				filename: file.name,
				file_size: file.size,
				content_type: file.type,
			})),
		},
	});
	const plans = response.body?.attachments ?? [];
	return Promise.all(
		files.map(async (file, index) => {
			const plan = plans.find((entry) => String(entry.id) === String(index));
			// The feed plans every image as one presigned PUT; it has no multipart completion step.
			if (plan?.upload_mode !== 'singlepart') {
				throw new Error(`No single upload URL for feed media ${index}`);
			}
			await http.put(plan.upload_url, {body: file, headers: {'Content-Type': plan.content_type}});
			return {
				id: index,
				filename: plan.filename,
				upload_filename: plan.upload_filename,
				file_size: plan.file_size,
				content_type: plan.content_type,
			};
		}),
	);
}

export interface FeedPostOptions {
	poll: {options: Array<string>; durationHours: number} | null;
}

// Up to four images, and a poll only with text as its question and no images; a video goes through
// FeedVideoCommands.postVideo. The server checks again (and the poll options); this only spares requests that would fail.
function isPostable(text: string, files: ReadonlyArray<File>, poll: FeedPostOptions['poll']): boolean {
	if (poll) return text.length > 0 && files.length === 0;
	return (
		validateFeedImages([], files, FEED_MAX_IMAGE_BYTES).rejection === null && (text.length > 0 || files.length > 0)
	);
}

// No `public` field: the server sets the public bit from the author's profile visibility.
export async function createPost(
	content: string,
	files: ReadonlyArray<File>,
	options: FeedPostOptions = {poll: null},
): Promise<FeedOutcome> {
	const text = content.trim();
	if (!isPostable(text, files, options.poll)) return 'invalid';
	try {
		const body: {
			content?: string;
			poll?: {options: Array<string>; duration_hours: number};
			attachments?: Awaited<ReturnType<typeof uploadMedia>>;
		} = {};
		if (text.length > 0) body.content = text;
		if (options.poll) body.poll = {options: options.poll.options, duration_hours: options.poll.durationHours};
		if (files.length > 0) body.attachments = await uploadMedia(files);
		const response = await http.post<FeedPostResponse>(Endpoints.FEED_POSTS, {body});
		if (response.body) FeedTimeline.handlePostCreated(response.body);
		AnalyticsCommands.track('feed_post_create');
		return 'ok';
	} catch (error) {
		logger.warn('Failed to create feed post:', error);
		// 400: the server refused the post as malformed, for example poll options that repeat once it strips hidden
		// characters; trying again would not help.
		if (error instanceof HttpError && error.status === 400) return 'invalid';
		return outcomeOf(error);
	}
}

// The server's current copy of a post (with fresh signed video URLs) replaces it wherever it is shown. Gives the copy,
// or null when there is none; a post that is gone (404) leaves every list.
export async function reloadPost(postId: string): Promise<FeedPostResponse | null> {
	try {
		const response = await http.get<FeedPostResponse>(Endpoints.FEED_POST(postId));
		if (!response.body) return null;
		FeedTimeline.handlePostUpdated(response.body);
		return response.body;
	} catch (error) {
		logger.warn(`Failed to reload post ${postId}:`, error);
		if (outcomeOf(error) === 'gone') FeedTimeline.handlePostRemoved(postId);
		return null;
	}
}

// Not optimistic: the answer is the post with the results, which replaces it everywhere. 409 means this account
// already voted (another tab) or the poll ended; the post as the server has it now shows which, so it is no failure.
export async function votePoll(postId: string, option: number): Promise<FeedOutcome> {
	try {
		const response = await http
			.put<FeedPostResponse>(Endpoints.FEED_POST_POLL_VOTE(postId), {body: {option}})
			.catch((error: unknown) => {
				if (error instanceof HttpError && error.status === 409) {
					return http.get<FeedPostResponse>(Endpoints.FEED_POST(postId));
				}
				throw error;
			});
		if (response.body) FeedTimeline.handlePostUpdated(response.body);
		return 'ok';
	} catch (error) {
		logger.warn(`Failed to vote in the poll of post ${postId}:`, error);
		const outcome = outcomeOf(error);
		if (outcome === 'gone') FeedTimeline.handlePostRemoved(postId);
		return outcome;
	}
}

// Only the author sees the delete action; the server enforces it.
export async function deletePost(postId: string): Promise<FeedOutcome> {
	try {
		await http.delete(Endpoints.FEED_POST(postId));
	} catch (error) {
		const outcome = outcomeOf(error);
		if (outcome !== 'gone') {
			logger.warn(`Failed to delete post ${postId}:`, error);
			return outcome;
		}
	}
	FeedTimeline.handlePostRemoved(postId);
	return 'ok';
}

export async function loadComments(postId: string): Promise<void> {
	const thread = FeedTimeline.getThread(postId);
	if (!thread || thread.isLoading || !thread.hasMore || thread.failure) return;
	const before = FeedTimeline.getThreadCursor(postId);
	FeedTimeline.handleThreadPending(postId);
	try {
		const response = await http.get<FeedCommentListResponse>(Endpoints.FEED_POST_COMMENTS(postId), {
			query: pageQuery(before),
		});
		FeedTimeline.handleThreadSuccess(postId, response.body ?? [], response.headers['x-next-before']);
	} catch (error) {
		logger.warn(`Failed to load comments of post ${postId}:`, error);
		const outcome = outcomeOf(error);
		if (outcome === 'gone') {
			FeedTimeline.handlePostRemoved(postId);
			return;
		}
		FeedTimeline.handleThreadFailure(postId, outcome === 'forbidden' ? 'forbidden' : 'error');
	}
}

export function retryComments(postId: string): Promise<void> {
	FeedTimeline.handleThreadRetry(postId);
	return loadComments(postId);
}

export function restartComments(postId: string): Promise<void> {
	if (FeedTimeline.getThread(postId)?.isLoading) return Promise.resolve();
	FeedTimeline.handleThreadRestart(postId);
	return loadComments(postId);
}

export async function createComment(postId: string, content: string): Promise<FeedOutcome> {
	const text = content.trim();
	if (text.length === 0) return 'invalid';
	try {
		const response = await http.post<FeedCommentResponse>(Endpoints.FEED_POST_COMMENTS(postId), {
			body: {content: text},
		});
		if (response.body) FeedTimeline.handleCommentCreated(response.body);
		AnalyticsCommands.track('feed_comment_create');
		return 'ok';
	} catch (error) {
		logger.warn(`Failed to comment on post ${postId}:`, error);
		const outcome = outcomeOf(error);
		if (outcome === 'gone') FeedTimeline.handlePostRemoved(postId);
		return outcome;
	}
}

// The comment author and the post author may delete a comment; the server enforces it.
export async function deleteComment(postId: string, commentId: string): Promise<FeedOutcome> {
	try {
		await http.delete(Endpoints.FEED_POST_COMMENT(postId, commentId));
	} catch (error) {
		const outcome = outcomeOf(error);
		if (outcome !== 'gone') {
			logger.warn(`Failed to delete comment ${commentId}:`, error);
			return outcome;
		}
		// The comment went with its post.
		if (failureCode(error) === APIErrorCodes.UNKNOWN_FEED_POST) {
			FeedTimeline.handlePostRemoved(postId);
			return 'ok';
		}
	}
	FeedTimeline.handleCommentRemoved(postId, commentId);
	return 'ok';
}

// Throws on failure so the report modal can say so, like IARCommands.
export async function reportPost(postId: string, category: string): Promise<void> {
	await http.post(Endpoints.REPORT_FEED_POST, {body: {post_id: postId, category}});
}

export async function reportComment(postId: string, commentId: string, category: string): Promise<void> {
	await http.post(Endpoints.REPORT_FEED_COMMENT, {body: {post_id: postId, comment_id: commentId, category}});
}
