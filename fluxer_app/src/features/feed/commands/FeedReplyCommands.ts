// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {type FeedOutcome, outcomeOf} from '@app/features/feed/commands/FeedCommands';
import FeedTimeline, {FEED_PAGE_SIZE, type FeedComment} from '@app/features/feed/state/FeedTimeline';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {FeedCommentListResponse, FeedCommentResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

const logger = new Logger('FeedReplyCommands');

// Replies are one level deep: every reply route takes a top-level comment id, and a reply to a reply goes to the same
// comment. A 404 there means the comment (or its post) is gone, and its replies went with it; the code tells which.
function postGone(error: unknown): boolean {
	return failureCode(error) === APIErrorCodes.UNKNOWN_FEED_POST;
}

function handleCommentGone(postId: string, commentId: string, error: unknown): void {
	if (postGone(error)) FeedTimeline.handlePostRemoved(postId);
	else FeedTimeline.handleCommentRemoved(postId, commentId);
}

export async function loadReplies(postId: string, commentId: string): Promise<void> {
	const thread = FeedTimeline.getReplies(postId, commentId);
	if (!thread || thread.isLoading || !thread.hasMore || thread.failure) return;
	const before = FeedTimeline.getRepliesCursor(postId, commentId);
	FeedTimeline.handleRepliesPending(postId, commentId);
	try {
		const response = await http.get<FeedCommentListResponse>(Endpoints.FEED_COMMENT_REPLIES(postId, commentId), {
			query: before ? {limit: FEED_PAGE_SIZE, before} : {limit: FEED_PAGE_SIZE},
		});
		FeedTimeline.handleRepliesSuccess(postId, commentId, response.body ?? [], response.headers['x-next-before']);
	} catch (error) {
		logger.warn(`Failed to load replies of comment ${commentId}:`, error);
		const outcome = outcomeOf(error);
		if (outcome === 'gone') {
			handleCommentGone(postId, commentId, error);
			return;
		}
		FeedTimeline.handleRepliesFailure(postId, commentId, outcome === 'forbidden' ? 'forbidden' : 'error');
	}
}

// A comment without replies has nothing to load; replies already open stay as they are.
export function openReplies(postId: string, comment: FeedComment): Promise<void> {
	if (FeedTimeline.getReplies(postId, comment.id)) return Promise.resolve();
	FeedTimeline.openReplies(postId, comment.id);
	if (comment.replyCount === 0) {
		FeedTimeline.handleRepliesSuccess(postId, comment.id, []);
		return Promise.resolve();
	}
	return loadReplies(postId, comment.id);
}

export function retryReplies(postId: string, commentId: string): Promise<void> {
	FeedTimeline.handleRepliesRetry(postId, commentId);
	return loadReplies(postId, commentId);
}

export async function createReply(postId: string, commentId: string, content: string): Promise<FeedOutcome> {
	const text = content.trim();
	if (text.length === 0) return 'invalid';
	try {
		const response = await http.post<FeedCommentResponse>(Endpoints.FEED_COMMENT_REPLIES(postId, commentId), {
			body: {content: text},
		});
		// The route names the comment the reply belongs to.
		if (response.body) FeedTimeline.handleReplyCreated({...response.body, parent_id: commentId});
		return 'ok';
	} catch (error) {
		logger.warn(`Failed to reply to comment ${commentId}:`, error);
		const outcome = outcomeOf(error);
		if (outcome === 'gone') handleCommentGone(postId, commentId, error);
		return outcome;
	}
}

// The reply author and the post author may delete a reply; the server enforces it.
export async function deleteReply(postId: string, commentId: string, replyId: string): Promise<FeedOutcome> {
	try {
		await http.delete(Endpoints.FEED_COMMENT_REPLY(postId, commentId, replyId));
	} catch (error) {
		const outcome = outcomeOf(error);
		if (outcome !== 'gone') {
			logger.warn(`Failed to delete reply ${replyId}:`, error);
			return outcome;
		}
		if (postGone(error)) {
			FeedTimeline.handlePostRemoved(postId);
			return 'ok';
		}
	}
	FeedTimeline.handleReplyRemoved(postId, commentId, replyId);
	return 'ok';
}

// Throws on failure so the report modal can say so, like FeedCommands.reportComment.
export async function reportReply(postId: string, commentId: string, replyId: string, category: string): Promise<void> {
	await http.post(Endpoints.REPORT_FEED_COMMENT, {
		body: {post_id: postId, comment_id: replyId, parent_comment_id: commentId, category},
	});
}
