// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import FeedTimeline from '@app/features/feed/state/FeedTimeline';
import FeedNotifications, {FEED_NOTIFICATION_PAGE_SIZE} from '@app/features/inbox/state/FeedNotifications';
import {AccountScopedWork, type AccountScopedWorkTicket} from '@app/features/platform/state/AccountScopedWork';
import {getAppStorageScope} from '@app/features/platform/state/PersistentStorage';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import type {
	FeedNotificationAckResponse,
	FeedNotificationListResponse,
	FeedPostResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

const logger = new Logger('FeedNotificationCommands');

async function fetchPage(restart: boolean): Promise<void> {
	const before = restart ? undefined : FeedNotifications.getCursor();
	const generation = FeedNotifications.handleFetchPending();
	try {
		const response = await http.get<FeedNotificationListResponse>(Endpoints.FEED_NOTIFICATIONS, {
			query: before ? {limit: FEED_NOTIFICATION_PAGE_SIZE, before} : {limit: FEED_NOTIFICATION_PAGE_SIZE},
		});
		// The list's server time: what the newest page vouches for on close, whatever the device clock says.
		const listedAt = Date.parse(response.headers.date ?? '');
		FeedNotifications.handleFetchSuccess(
			generation,
			response.body ?? [],
			restart,
			Number.isNaN(listedAt) ? undefined : listedAt,
		);
	} catch (error) {
		logger.warn('Failed to load feed notifications:', error);
		FeedNotifications.handleFetchFailure(generation);
	}
}

// Each open of the activity tab starts from the newest row: pushes are capped at one a minute per account, so a
// loaded row can lag behind the server.
export function refresh(): Promise<void> {
	return fetchPage(true);
}

export async function loadMore(): Promise<void> {
	const {fetched, isLoading, failed, canLoadMore} = FeedNotifications;
	if (!fetched || isLoading || failed || !canLoadMore) return;
	await fetchPage(false);
}

export function retry(): Promise<void> {
	return fetchPage(!FeedNotifications.fetched);
}

// Micup 2a.9b: closing the activity view marks what it showed read on the server, so other devices and READY agree.
export async function markRead(): Promise<void> {
	const read = FeedNotifications.closeView();
	if (read) await sendReadCursor(read.readAt, read.seq, read.epoch);
}

export async function sendReadCursor(readAt: number, seenSeq: number, seenEpoch: number): Promise<void> {
	// An answer or a failure that comes after another account signed in is not that account's.
	const account = FeedNotifications.lastReadUserId;
	const accountKey = getAppStorageScope();
	const keepRead = (): void => {
		if (getAppStorageScope() === accountKey && FeedNotifications.lastReadUserId === account) {
			FeedNotifications.handleReadFailure({readAt, seq: seenSeq, epoch: seenEpoch});
		}
	};
	let ticket: AccountScopedWorkTicket | undefined;
	let unregisterCancellation: (() => void) | undefined;
	try {
		ticket = AccountScopedWork.begin();
		unregisterCancellation = AccountScopedWork.registerCancellation(keepRead);
		const response = await http.post<FeedNotificationAckResponse>(Endpoints.FEED_NOTIFICATIONS_ACK, {
			body: {read_at: new Date(readAt).toISOString(), unread_seq: seenSeq, unread_epoch: seenEpoch},
			signal: ticket.signal,
		});
		if (
			!ticket.isStale &&
			response.body &&
			getAppStorageScope() === accountKey &&
			FeedNotifications.lastReadUserId === account
		)
			FeedNotifications.handleAck(response.body);
	} catch (error) {
		if (ticket?.isStale) return;
		// The server cursor stays where it was (offline, rate limited); the store keeps the read and the next close of the
		// view sends it again.
		logger.warn('Failed to mark feed notifications read:', error);
		keepRead();
	} finally {
		unregisterCancellation?.();
		ticket?.dispose();
	}
}

// A notification opens its post in a timeline of its own, so the post card's likes and comments work as in the feed.
export function feedPostTimelineKey(postId: string): string {
	return `post:${postId}`;
}

export async function loadPost(postId: string, showComments: boolean): Promise<void> {
	const key = feedPostTimelineKey(postId);
	FeedTimeline.handleFetchPending(key);
	try {
		const response = await http.get<FeedPostResponse>(Endpoints.FEED_POST(postId));
		FeedTimeline.handleFetchSuccess(key, response.body ? [response.body] : [], true);
	} catch (error) {
		logger.warn(`Failed to load post ${postId}:`, error);
		FeedTimeline.handleFetchFailure(key, 'error');
		return;
	}
	if (showComments && FeedTimeline.getTimeline(key)?.posts.length) {
		FeedTimeline.openThread(postId);
		await FeedCommands.loadComments(postId);
	}
}
