// SPDX-License-Identifier: AGPL-3.0-or-later

import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {User} from '@app/features/user/models/User';
import {MAX_LOADED_MESSAGES} from '@fluxer/constants/src/LimitConstants';
import {
	FEED_NOTIFICATION_UNREAD_CAP,
	type FeedNotificationAckResponse,
	type FeedNotificationResponse,
	type FeedNotificationStateResponse,
	type FeedNotificationType,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {sortBySnowflakeDesc} from '@fluxer/snowflake/src/SnowflakeUtils';
import {makeAutoObservable} from 'mobx';

export const FEED_NOTIFICATION_PAGE_SIZE = 25;
export const FEED_NOTIFICATIONS_STORAGE_KEY = 'FeedNotifications';
// Same cap as a channel's loaded messages (200). Paging stops there; a pushed row drops the oldest one.
// TEMPORARY: rows past the 200th are not reachable; page by dropping the newest (FeedTimeline) if people ask for more.
export const MAX_LOADED_FEED_NOTIFICATIONS = MAX_LOADED_MESSAGES;

export interface FeedNotification {
	readonly id: string;
	readonly type: FeedNotificationType;
	readonly postId: string | null;
	readonly actors: ReadonlyArray<User>;
	readonly actorCount: number;
	readonly updatedAt: number;
}

// A newer server may send a type this build has no icon or text for; such rows are dropped, not shown broken.
const KNOWN_TYPES: Record<FeedNotificationType, true> = {
	post_like: true,
	post_comment: true,
	follow: true,
	comment_reply: true,
};

// A read to send: up to readAt (server times only), the unread sequence the session saw and its epoch.
export interface FeedNotificationRead {
	readAt: number;
	seq: number;
	epoch: number;
}

function toNotification(wire: FeedNotificationResponse): FeedNotification | null {
	if (!Object.hasOwn(KNOWN_TYPES, wire.type)) return null;
	return {
		id: wire.id,
		type: wire.type,
		postId: wire.post_id,
		actors: wire.actors.map((actor) => new User(actor)),
		actorCount: wire.actor_count,
		updatedAt: Date.parse(wire.updated_at),
	};
}

class FeedNotifications {
	notifications: ReadonlyArray<FeedNotification> = [];
	fetched = false;
	hasMore = true;
	isLoading = false;
	failed = false;
	// The read cursor and the account it belongs to, kept together: another account on this device starts from
	// nothing. The server's cursor (READY, acks) wins whenever it has one; until then, and against an older server, the device's.
	lastReadAt = 0;
	lastReadUserId: string | null = null;
	// Micup 2a.9b: the server's unread count (READY, then the rise of the unread sequence each push carries), or null when
	// this session counts on the device: the account's first READY had no state, or the server had no cursor yet while
	// this device kept one (FeedNotificationReady sends it).
	serverUnread: number | null = null;
	private unreadSeq = 0;
	// The epoch of unreadSeq: 0 until the account's unread state exists; a later one restarts the sequence from 0.
	private unreadEpoch = 0;
	// The newest server time the newest page vouches for: the list's Date header or its newest row, an unknown type
	// included. Sent on close as the read time, never kept as the cursor.
	private newestPageAt = 0;
	// The latest read taken in (the ack answer or FEED_NOTIFICATION_ACK), applied again after a READY counted before it.
	private lastAck: FeedNotificationAckResponse | null = null;
	// A read that could not be sent; the next close sends it again.
	private unsentRead: FeedNotificationRead | null = null;
	private viewCount = 0;
	private fetchGeneration = 0;
	// The oldest row of the last page, kept apart from the loaded rows since that row may have been dropped.
	private cursor: string | null = null;

	constructor() {
		makeAutoObservable<this, 'fetchGeneration'>(this, {fetchGeneration: false}, {autoBind: true});
		void makePersistent(this, FEED_NOTIFICATIONS_STORAGE_KEY, ['lastReadAt', 'lastReadUserId'], {
			onRehydrated: this.reset,
		});
	}

	// The server's count (READY and the unread sequence pushes carry), so what arrived while the app was closed counts too,
	// capped at 10 (the badge's 9+). A session counting on the device counts the rows loaded or pushed since it started.
	get unreadCount(): number {
		if (this.viewCount > 0) return 0;
		if (this.serverUnread !== null) return Math.min(this.serverUnread, FEED_NOTIFICATION_UNREAD_CAP);
		return this.notifications.filter(this.isUnread).length;
	}

	get canLoadMore(): boolean {
		return this.hasMore && this.notifications.length < MAX_LOADED_FEED_NOTIFICATIONS;
	}

	isUnread(notification: FeedNotification): boolean {
		return notification.updatedAt > this.lastReadAt;
	}

	captureSnapshotState(): FeedNotificationStateResponse {
		return {
			unread_count: this.serverUnread ?? this.notifications.filter(this.isUnread).length,
			unread_seq: this.unreadSeq,
			unread_epoch: this.unreadEpoch,
			last_read_at: this.lastReadAt > 0 ? new Date(this.lastReadAt).toISOString() : null,
		};
	}

	captureSnapshotAck(): FeedNotificationAckResponse | null {
		return this.lastAck ? {...this.lastAck} : null;
	}

	getCursor(): string | undefined {
		return this.cursor ?? undefined;
	}

	invalidatePendingFetch(): void {
		this.fetchGeneration++;
		this.isLoading = false;
	}

	reset(): void {
		this.notifications = [];
		this.fetched = false;
		this.hasMore = true;
		this.isLoading = false;
		this.failed = false;
		this.fetchGeneration++;
		this.cursor = null;
		this.newestPageAt = 0;
		this.serverUnread = null;
		this.unreadSeq = 0;
		this.unreadEpoch = 0;
		this.lastAck = null;
		this.unsentRead = null;
		this.viewCount = 0;
	}

	handleGatewayReady(state?: FeedNotificationStateResponse, userId?: string): void {
		this.notifications = [];
		this.fetched = false;
		this.hasMore = true;
		this.isLoading = false;
		this.failed = false;
		this.fetchGeneration++;
		this.cursor = null;
		this.newestPageAt = 0;
		if (userId !== undefined && userId !== this.lastReadUserId) {
			// A value saved before owners were kept (before this release) binds to the first account that connects.
			if (this.lastReadUserId !== null) this.lastReadAt = 0;
			this.lastReadUserId = userId;
			this.serverUnread = null;
			this.unreadSeq = 0;
			this.unreadEpoch = 0;
			this.lastAck = null;
			this.unsentRead = null;
		}
		// No state (an older server, a READY that could not read it in time): the account keeps its last server count, or
		// counts on the device if this is its first READY.
		if (!state) return;
		const deviceCursorOnly = state.last_read_at === null && this.lastReadAt > 0;
		this.serverUnread = deviceCursorOnly ? null : state.unread_count;
		// READY's base, not the higher of it and a push's: the next push brings what READY did not count.
		this.unreadSeq = state.unread_seq;
		this.unreadEpoch = state.unread_epoch;
		const readyCursor = state.last_read_at === null ? 0 : Date.parse(state.last_read_at);
		this.lastReadAt = Math.max(this.lastReadAt, readyCursor);
		// A read taken in before READY that READY's count does not have yet.
		if (this.lastAck && Date.parse(this.lastAck.last_read_at) > readyCursor) this.handleAck(this.lastAck);
	}

	// The server folds actions into one row per post, type and hour and pushes the row again under the same id.
	handleNotificationCreate(wire: FeedNotificationResponse, unreadSeq?: number, unreadEpoch = this.unreadEpoch): void {
		if (unreadSeq !== undefined && this.takeUnreadEpoch(unreadEpoch)) {
			// A push READY already counted, a repeated push or a late one carries no higher sequence and adds nothing; a row
			// no newer than the read cursor was read here already (a held push of a row the view showed): only the base
			// moves.
			if (this.serverUnread !== null && Date.parse(wire.updated_at) > this.lastReadAt) {
				this.serverUnread += Math.max(0, unreadSeq - this.unreadSeq);
			}
			// A session counting on the device keeps it too: its close sends the sequence it saw.
			this.unreadSeq = Math.max(this.unreadSeq, unreadSeq);
		}
		const notification = toNotification(wire);
		if (!notification) return;
		const index = this.notifications.findIndex((entry) => entry.id === notification.id);
		if (index !== -1) {
			const notifications = [...this.notifications];
			notifications[index] = notification;
			this.notifications = notifications;
			return;
		}
		const notifications = sortBySnowflakeDesc([notification, ...this.notifications]);
		if (notifications.length > MAX_LOADED_FEED_NOTIFICATIONS) this.hasMore = true;
		this.notifications = notifications.slice(0, MAX_LOADED_FEED_NOTIFICATIONS);
	}

	handleFetchPending(): number {
		this.isLoading = true;
		this.failed = false;
		this.fetchGeneration++;
		return this.fetchGeneration;
	}

	handleFetchSuccess(
		generation: number,
		page: ReadonlyArray<FeedNotificationResponse>,
		restart: boolean,
		serverTime?: number,
	): void {
		if (generation !== this.fetchGeneration) return;
		if (restart) this.newestPageAt = Math.max(serverTime ?? 0, ...page.map((wire) => Date.parse(wire.updated_at)));
		const loaded = restart ? [] : this.notifications;
		const seen = new Set(loaded.map((notification) => notification.id));
		const added = page
			.filter((wire) => !seen.has(wire.id))
			.map(toNotification)
			.filter((notification) => notification !== null);
		this.notifications = [...loaded, ...added].slice(0, MAX_LOADED_FEED_NOTIFICATIONS);
		// A short page is not the end: the server pages across time buckets, so only an empty page ends the list.
		this.hasMore = page.length > 0;
		this.cursor = page.at(-1)?.id ?? (restart ? null : this.cursor);
		this.fetched = true;
		this.isLoading = false;
	}

	handleFetchFailure(generation: number): void {
		if (generation !== this.fetchGeneration) return;
		this.isLoading = false;
		this.failed = true;
	}

	openView(): void {
		this.viewCount++;
	}

	// A read on any of the account's sessions (this one's ack answer or FEED_NOTIFICATION_ACK). What it covered is read;
	// what was pushed after the sequence it saw stays counted. Never raises the count; twice is once.
	handleAck(state: FeedNotificationAckResponse): void {
		if (!this.lastAck || Date.parse(state.last_read_at) >= Date.parse(this.lastAck.last_read_at)) this.lastAck = state;
		this.lastReadAt = Math.max(this.lastReadAt, Date.parse(state.last_read_at));
		if (!this.takeUnreadEpoch(state.unread_epoch)) return;
		if (this.serverUnread !== null) {
			this.serverUnread = Math.min(this.serverUnread, Math.max(0, this.unreadSeq - state.unread_seq));
		}
		this.unreadSeq = Math.max(this.unreadSeq, state.unread_seq);
	}

	// Whatever was on screen counts as read (server times, so a wrong device clock cannot hide or resurface a row); when
	// the newest page loaded, so does what it left out (deleted posts, blocked accounts, unknown types),
	// up to the server time the list vouches for. Returns the read to send, or null when the view showed nothing: an
	// empty or failed view clears nothing. A session counting on the device sends too. A read that could not
	// be sent goes again.
	closeView(): FeedNotificationRead | null {
		this.viewCount = Math.max(0, this.viewCount - 1);
		const previous = this.lastReadAt;
		for (const notification of this.notifications) {
			if (notification.updatedAt > this.lastReadAt) this.lastReadAt = notification.updatedAt;
		}
		const listed = this.fetched && !this.failed;
		const readAt = Math.max(this.lastReadAt, listed ? this.newestPageAt : 0);
		const unsent = this.unsentRead;
		this.unsentRead = null;
		// No server time vouches for a read (readAt 0): only a read that failed before goes.
		if (readAt === 0 || (this.lastReadAt === previous && !(listed && (this.serverUnread ?? 0) > 0))) return unsent;
		if (this.serverUnread !== null) this.serverUnread = 0;
		return {readAt: Math.max(readAt, unsent?.readAt ?? 0), seq: this.unreadSeq, epoch: this.unreadEpoch};
	}

	// The read could not be sent (offline, rate limited): the next close sends it, or a later read that covers it.
	handleReadFailure(read: FeedNotificationRead): void {
		if (read.readAt >= (this.unsentRead?.readAt ?? 0)) this.unsentRead = read;
	}

	// A later unread epoch: the account's unread state began again, its sequence from 0. An earlier one belongs to a
	// state gone since, whose sequence says nothing of this one. True when the epoch is the current one.
	private takeUnreadEpoch(epoch: number): boolean {
		if (epoch > this.unreadEpoch) {
			this.unreadEpoch = epoch;
			this.unreadSeq = 0;
		}
		return epoch === this.unreadEpoch;
	}
}

const feedNotifications = new FeedNotifications();
AccountScopedWork.registerCancellation(feedNotifications.invalidatePendingFetch);
export default feedNotifications;
