// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {deleteOneOrMany, fetchMany, fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {FeedNotificationReadStateRow, FeedNotificationRow} from '@app/api/database/types/FeedTypes';
import {NO_CURSOR} from '@app/api/feed/FeedRepository';
import {FeedNotificationReadStates, FeedNotifications} from '@app/api/feed/FeedTables';
import {makeBucket} from '@fluxer/snowflake/src/SnowflakeBuckets';

const FETCH_NOTIFICATION_CQL = FeedNotifications.selectCql({
	where: [
		FeedNotifications.where.eq('user_id'),
		FeedNotifications.where.eq('bucket'),
		FeedNotifications.where.eq('notification_id'),
	],
	limit: 1,
});

const FETCH_READ_STATE_CQL = FeedNotificationReadStates.selectCql({
	where: FeedNotificationReadStates.where.eq('user_id'),
	limit: 1,
});

function inboxQuery(limit: number) {
	return FeedNotifications.select({
		where: [
			FeedNotifications.where.eq('user_id'),
			FeedNotifications.where.eq('bucket'),
			FeedNotifications.where.lt('notification_id', 'before'),
		],
		orderBy: {col: 'notification_id', direction: 'DESC'},
		limit,
	});
}

// feed_notifications: a partition per recipient and ten day bucket of notification_id; rows expire after 90 days.
export class FeedNotificationRepository {
	/** The whole row; the aggregation job rewrites a folded notification under the same ID. */
	async upsert(row: FeedNotificationRow): Promise<void> {
		await upsertOne(FeedNotifications.upsertAll(row));
	}

	async get(userId: UserID, notificationId: bigint): Promise<FeedNotificationRow | null> {
		return fetchOne<FeedNotificationRow>(FETCH_NOTIFICATION_CQL, {
			user_id: userId,
			bucket: makeBucket(notificationId),
			notification_id: notificationId,
		});
	}

	/** One page of one bucket below `before`, newest first. */
	async list(userId: UserID, bucket: number, before = NO_CURSOR, limit: number): Promise<Array<FeedNotificationRow>> {
		return fetchMany<FeedNotificationRow>(inboxQuery(limit).bind({user_id: userId, bucket, before}));
	}

	async deleteBucket(userId: UserID, bucket: number): Promise<void> {
		await deleteOneOrMany(FeedNotifications.deletePartition({user_id: userId, bucket}));
	}

	/** The account's read cursor, or null before its first mark-read (or 90 days after its last). */
	async getReadState(userId: UserID): Promise<Date | null> {
		return (
			(await fetchOne<FeedNotificationReadStateRow>(FETCH_READ_STATE_CQL, {user_id: userId}))?.last_read_at ?? null
		);
	}

	async upsertReadState(userId: UserID, lastReadAt: Date): Promise<void> {
		await upsertOne(FeedNotificationReadStates.upsertAll({user_id: userId, last_read_at: lastReadAt}));
	}

	async deleteReadState(userId: UserID): Promise<void> {
		await deleteOneOrMany(FeedNotificationReadStates.deleteByPk({user_id: userId}));
	}
}
