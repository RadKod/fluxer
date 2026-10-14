// SPDX-License-Identifier: AGPL-3.0-or-later

import * as AnalyticsCommands from '@app/features/analytics/commands/AnalyticsCommands';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import Authentication from '@app/features/auth/state/Authentication';
import FollowLists, {FOLLOW_LIST_PAGE_SIZE, type FollowList} from '@app/features/follow/state/FollowLists';
import {applyFollowChange, shiftFollowCount} from '@app/features/follow/utils/FollowProfileUtils';
import {http} from '@app/features/platform/transport/RestTransport';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import {blockIfAccountLimited, handleAccountLimitedError} from '@app/features/user/utils/AccountLimitUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {FollowListResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';

const logger = new Logger('FollowCommands');

export type FollowOutcome = 'ok' | 'forbidden' | 'account_limited' | 'verify_email' | 'limit' | 'failed';

function httpStatus(error: unknown): number | null {
	return error instanceof HttpError ? error.status : null;
}

function failureOutcome(error: unknown): FollowOutcome {
	if (handleAccountLimitedError(error)) return 'account_limited';
	if (failureCode(error) === APIErrorCodes.EMAIL_VERIFICATION_REQUIRED) return 'verify_email';
	const status = httpStatus(error);
	if (status === 403) return 'forbidden';
	if (status === 400) return 'limit';
	return 'failed';
}

async function setFollowing(userId: string, following: boolean, postId?: string): Promise<FollowOutcome> {
	if (blockIfAccountLimited()) return 'account_limited';
	const changed = applyFollowChange(userId, following);
	try {
		if (following) {
			// Micup akis-takip: from a Discover post, its id lets the server allow a stranger's follow.
			await (postId
				? http.put(Endpoints.USER_FOLLOW(userId), {body: {post_id: postId}})
				: http.put(Endpoints.USER_FOLLOW(userId)));
			AnalyticsCommands.track('follow');
		} else {
			await http.delete(Endpoints.USER_FOLLOW(userId));
		}
		return 'ok';
	} catch (error) {
		logger.warn(`Failed to ${following ? 'follow' : 'unfollow'} user ${userId}:`, error);
		if (changed) applyFollowChange(userId, !following);
		return failureOutcome(error);
	}
}

export function follow(userId: string, options?: {postId?: string}): Promise<FollowOutcome> {
	return setFollowing(userId, true, options?.postId);
}

export function unfollow(userId: string): Promise<FollowOutcome> {
	return setFollowing(userId, false);
}

export async function removeFollower(userId: string): Promise<boolean> {
	if (blockIfAccountLimited()) return false;
	try {
		await http.delete(Endpoints.USER_FOLLOWER(userId));
	} catch (error) {
		if (handleAccountLimitedError(error)) return false;
		logger.warn(`Failed to remove follower ${userId}:`, error);
		return false;
	}
	const currentUserId = Authentication.currentUserId;
	if (currentUserId) {
		FollowLists.handleFollowerRemoved(currentUserId, userId);
		shiftFollowCount(currentUserId, 'follower_count', -1);
	}
	return true;
}

function pageRequest(list: FollowList, cursor: string | undefined): [string, Record<string, string | number>] {
	const query: Record<string, string | number> = {limit: FOLLOW_LIST_PAGE_SIZE};
	// Followers come newest follow first (before = follow id); following comes by ascending user id (after = user id).
	if (list.kind === 'followers') {
		if (cursor) query.before = cursor;
		return [Endpoints.USER_FOLLOWERS(list.userId), query];
	}
	if (cursor) query.after = cursor;
	return [Endpoints.USER_FOLLOWING(list.userId), query];
}

export async function loadNextPage(listId: string): Promise<void> {
	const list = FollowLists.getList(listId);
	if (!list || list.isLoading || !list.hasMore || list.failure) return;
	const [endpoint, query] = pageRequest(list, FollowLists.getCursor(listId));
	FollowLists.handleFetchPending(listId);
	try {
		const response = await http.get<FollowListResponse>(endpoint, {query});
		FollowLists.handleFetchSuccess(listId, response.body ?? []);
	} catch (error) {
		logger.warn(`Failed to load ${list.kind} of user ${list.userId}:`, error);
		FollowLists.handleFetchFailure(listId, httpStatus(error) === 403 ? 'forbidden' : 'error');
	}
}

export function retry(listId: string): Promise<void> {
	FollowLists.handleRetry(listId);
	return loadNextPage(listId);
}

export function restart(listId: string): Promise<void> {
	if (FollowLists.getList(listId)?.isLoading) return Promise.resolve();
	FollowLists.handleRestart(listId);
	return loadNextPage(listId);
}
