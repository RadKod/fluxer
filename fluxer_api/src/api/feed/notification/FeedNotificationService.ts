// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomUUID} from 'node:crypto';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import type {FeedNotificationRow} from '@app/api/database/types/FeedTypes';
import {isFeedContentVisible} from '@app/api/feed/FeedContentVisibility';
import type {FeedPostService} from '@app/api/feed/FeedPostService';
import {type FeedRepository, NO_CURSOR} from '@app/api/feed/FeedRepository';
import type {FeedNotificationRepository} from '@app/api/feed/notification/FeedNotificationRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {Logger} from '@app/api/Logger';
import {createRequestCache, type RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {Relationship} from '@app/api/models/Relationship';
import type {User} from '@app/api/models/User';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {RelationshipTypes, UserFlags} from '@fluxer/constants/src/UserConstants';
import {
	FEED_NOTIFICATION_UNREAD_CAP,
	type FeedNotificationAckResponse,
	type FeedNotificationCreateEvent,
	type FeedNotificationResponse,
	type FeedNotificationStateResponse,
	type FeedNotificationType,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {createSnowflakeFromTimestamp} from '@fluxer/snowflake/src/Snowflake';
import {makeBucket} from '@fluxer/snowflake/src/SnowflakeBuckets';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

const HOUR_MS = 3_600_000;
// The feed_notifications TTL.
const RETENTION_MS = 90 * 86_400_000;
const SAMPLED_ACTORS = 3;
// An aggregation key takes actions for one hour; its KV state (five small keys) outlives the hour so a late job still
// finds it. This TTL is the KV memory lever: with the feed lane's job latency measured, 1 h plus that latency suffices.
const STATE_TTL_SECONDS = 3 * 3600;
// The first action of a key queues its job this far ahead, so a burst folds into one row write.
const AGGREGATE_DELAY_MS = 10_000;
// Lets a later action queue again when a queued job was lost.
const QUEUED_TTL_SECONDS = 300;
const LOCK_TTL_SECONDS = 30;
// At most one FEED_NOTIFICATION_CREATE per recipient in this window.
const PUSH_INTERVAL_SECONDS = 60;
// The account's unread state is one hash: seq, the unread sequence (one increment per notification that becomes
// unread: its key's first row, or a row that moves after the last mark-read; READY, pushes and acks carry it and a client
// adds the rise between two values to its badge), acked ("<seq>:<cursor ms>", the last mark-read), ready (READY's cache)
// and epoch (when the hash began, ms; READY, pushes and acks carry it too, so a client whose base came from an expired
// hash starts again from 0 instead of waiting for the new sequence to pass it). One key, one TTL: the fields expire
// and are evicted together, so the cache never outlives the sequence it was written under. An
// increment, a mark-read or a READY miss renews the day.
const UNREAD_TTL_SECONDS = 24 * 3600;
// The two writes of the hash that read it first run as one script each, as UserEmailOwnershipRepository's do: a
// mark-read cannot land between a job's read of acked and its increment, and no increment leaves the hash without its
// TTL. The test double mirrors both (MockKVProvider). KEYS[1] is the account's hash.
// ARGV: the row's updated_at (ms), the key's counted mark ('' when none), now (ms), the TTL. Returns the new sequence, or
// nil when the action is no later than the last read's cursor (READY counts it read) or the key was counted
// since that read (its mark is above the read's sequence).
const UNREAD_INCREMENT_SCRIPT = `
local acked = redis.call('HGET', KEYS[1], 'acked')
local ackedSeq = 0
if acked then
	local sep = string.find(acked, ':', 1, true)
	ackedSeq = tonumber(string.sub(acked, 1, sep - 1))
	if tonumber(ARGV[1]) <= tonumber(string.sub(acked, sep + 1)) then
		return false
	end
end
if ARGV[2] ~= '' and tonumber(ARGV[2]) > ackedSeq then
	return false
end
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('HSETNX', KEYS[1], 'epoch', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return seq
`;
// ARGV: the sequence the session saw, its epoch, the cursor (ms), now (ms), the TTL. Reads up to what the session saw
// under the current epoch (none of it under another) and no further than the sequence (a notification counted after
// it, pushed later, stays unread), never back. Drops READY's cache, which holds the old cursor. Returns the
// read sequence and the epoch.
const UNREAD_ACK_SCRIPT = `
local state = redis.call('HMGET', KEYS[1], 'seq', 'acked', 'epoch')
local ackedSeq = 0
if state[2] then
	ackedSeq = tonumber(string.sub(state[2], 1, string.find(state[2], ':', 1, true) - 1))
end
local seen = tonumber(ARGV[1])
if (state[3] or '0') ~= ARGV[2] then
	seen = 0
end
ackedSeq = math.max(ackedSeq, math.min(seen, tonumber(state[1]) or 0))
redis.call('HSET', KEYS[1], 'acked', string.format('%d:%s', ackedSeq, ARGV[3]))
redis.call('HDEL', KEYS[1], 'ready')
redis.call('HSETNX', KEYS[1], 'epoch', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return {ackedSeq, redis.call('HGET', KEYS[1], 'epoch')}
`;
// READY answers from the hash's ready field ("<seq>:<cursor ms|empty>:<count>:<blocked accounts' fingerprint>") while it
// holds the current sequence, the cursor of the last read and the blocked accounts READY has now: nothing became unread,
// nothing was read and no account was blocked or unblocked since it was written (the "new notification" flag
// in the first release, kept as a cache so that losing it costs one read, never a false zero). A read or a block landing
// while READY counts cannot leave a stale count behind. It lives as long as the hash (UNREAD_TTL_SECONDS).
// READY never waits on, or fails for, the feed.
const READY_STATE_TIMEOUT_MS = 250;
// Failures are counted per process and logged 1 in this many, so a slow Cassandra in a reconnect storm (33 K READY/s)
// does not flood the logs.
const READY_FAILURE_LOG_EVERY = 1000;
const UNREAD_SCAN_ROWS = 20;
// A row's updated_at moves only within its key's hour, so a row whose ID is older than the cursor minus two hours is read.
const UNREAD_MARGIN_MS = 2 * HOUR_MS;

let readyStateFailures = 0;
// TEMPORARY: a page reads at most this many rows, so an inbox whose newest 500 rows all point at deleted posts or
// blocked accounts answers an empty page early; prune such rows on read if that shows up.
const PAGE_SCAN_LIMIT = 500;
const EXPORT_PAGE_SIZE = 500;
// Each comment or reply moves its row (its comment ID and time), even from an actor already in it; a repeated like or
// follow does not.
const REPEATED_ACTION_TYPES: ReadonlySet<FeedNotificationType> = new Set(['post_comment', 'comment_reply']);

/** One recipient, notification type, post (0 for follows) and hour: every action under it folds into one row. */
export interface FeedNotificationKey {
	recipientId: UserID;
	type: FeedNotificationType;
	postId: bigint;
	hour: number;
}

export interface FeedNotificationAction {
	recipientId: UserID;
	actorId: UserID;
	type: FeedNotificationType;
	postId: bigint | null;
	commentId?: bigint;
}

interface ActorSample {
	n: number;
	actorId: UserID;
	at: number;
	commentId: bigint;
}

interface FeedNotificationServiceDeps {
	repository: FeedNotificationRepository;
	feedRepository: FeedRepository;
	feedPostService: FeedPostService;
	gatewayService: IGatewayService;
	kvClient: IKVProvider;
	userCacheService: UserCacheService;
	userRepository: IUserRepository;
	snowflakeService: ISnowflakeService;
	workerService: IWorkerService<WorkerTaskName>;
}

// The feed's likes, comments, replies and follows aimed at a user. The request path records an action in KV under its
// aggregation key and raises the key's dirty flag (buffered counter pattern); the aggregateFeedNotification job on the feed lane
// folds the key into one feed_notifications row, whose ID the key keeps in KV, and pushes it to the recipient's sessions
// at most once a minute. actor_count comes from a KV counter and the row keeps the three newest actors. Blocked
// accounts and deleted posts are dropped on read, so no write fans out over a recipient's inbox.
export class FeedNotificationService {
	constructor(readonly deps: FeedNotificationServiceDeps) {}

	/** Never throws: a failed notification must not fail the like, comment or follow behind it. */
	async record(action: FeedNotificationAction): Promise<void> {
		const {recipientId, actorId, type} = action;
		if (actorId === recipientId) return;
		try {
			const at = Date.now();
			const key: FeedNotificationKey = {recipientId, type, postId: action.postId ?? 0n, hour: Math.floor(at / HOUR_MS)};
			const base = stateKey(key);
			const kv = this.deps.kvClient;
			const own = parseSamples(await kv.hgetall(`${base}:actors`)).find((sample) => sample.actorId === actorId);
			// TEMPORARY: a repeated like or follow is caught only while the account is among the three samples, so unliking
			// and liking again after three other accounts counts twice (bounded by the like rate limit). Exact: a per-key
			// HyperLogLog once the KV client has PFADD.
			if (own && !REPEATED_ACTION_TYPES.has(type)) return;
			const n = own?.n ?? (await kv.incr(`${base}:count`));
			await kv.hset(`${base}:actors`, String(n % SAMPLED_ACTORS), `${n}:${actorId}:${at}:${action.commentId ?? 0n}`);
			await kv
				.pipeline()
				.expire(`${base}:count`, STATE_TTL_SECONDS)
				.expire(`${base}:actors`, STATE_TTL_SECONDS)
				.setex(`${base}:dirty`, STATE_TTL_SECONDS, randomUUID())
				.exec();
			await this.queueAggregate(key, at);
		} catch (error) {
			Logger.warn(
				{error, recipientId: recipientId.toString(), actorId: actorId.toString(), type},
				'Recording a feed notification failed',
			);
		}
	}

	/** The aggregateFeedNotification job for one key. A second job of the same key leaves it to the one running. */
	async aggregate(key: FeedNotificationKey): Promise<void> {
		const kv = this.deps.kvClient;
		const base = stateKey(key);
		const token = randomUUID();
		if (!(await kv.acquireLock(`${base}:lock`, token, LOCK_TTL_SECONDS))) return;
		try {
			await this.aggregateLocked(key, base);
		} finally {
			await kv.releaseLock(`${base}:lock`, token);
		}
		// An action that came in while the job ran changed the dirty flag, so the flag survived; queue again for it.
		await kv.del(`${base}:queued`);
		if ((await kv.get(`${base}:dirty`)) !== null) {
			await this.queueAggregate(key);
		}
	}

	/** The delivery job: pushes the notification held back by the once-a-minute limit. */
	async deliverHeld(recipientId: UserID): Promise<void> {
		const kv = this.deps.kvClient;
		// Cleared first, so a push held back from here on queues its own delivery job.
		await kv.del(recipientKey(recipientId, 'delivery'));
		const held = await kv.get(recipientKey(recipientId, 'held'));
		if (held === null) return;
		// A push that took this minute first carried a newer notification; the next held one gets its own job.
		if (!(await kv.setnx(recipientKey(recipientId, 'pushed'), '1', PUSH_INTERVAL_SECONDS))) return;
		await kv.releaseLock(recipientKey(recipientId, 'held'), held);
		const row = await this.deps.repository.get(recipientId, BigInt(held));
		if (row) {
			await this.dispatch(row);
		}
	}

	/** One inbox page, newest first by notification ID; `before` is a notification ID. */
	async listNotifications(
		recipientId: UserID,
		options: {before?: bigint; limit: number},
		requestCache: RequestCache,
	): Promise<Array<FeedNotificationResponse>> {
		const {limit} = options;
		const oldest = oldestBucket();
		// A cursor from the future starts at the newest bucket instead of walking empty partitions down to it.
		const newest = makeBucket(null) + 1;
		let bucket = options.before === undefined ? newest : Math.min(makeBucket(options.before), newest);
		let before = options.before ?? NO_CURSOR;
		const blocked = await this.blockedIds(recipientId);
		const page: Array<FeedNotificationResponse> = [];
		let scanned = 0;
		while (page.length < limit && bucket >= oldest && scanned < PAGE_SCAN_LIMIT) {
			const rows = await this.deps.repository.list(recipientId, bucket, before, limit);
			scanned += rows.length;
			page.push(...(await this.toResponses(rows, requestCache, blocked)));
			if (rows.length < limit) {
				bucket--;
				before = NO_CURSOR;
			} else {
				before = rows.at(-1)!.notification_id;
			}
		}
		return page.slice(0, limit);
	}

	/** Account deletion (lifecycle lane, idempotent): every bucket partition the 90 day TTL can still hold. */
	async deleteUserNotifications(userId: UserID): Promise<void> {
		for (const bucket of retainedBuckets()) {
			await this.deps.repository.deleteBucket(userId, bucket);
		}
		await this.deps.repository.deleteReadState(userId);
		await this.deps.kvClient.del(unreadKey(userId));
	}

	/** The data export's notifications, newest first. */
	async exportUserNotifications(userId: UserID): Promise<Array<Record<string, unknown>>> {
		const exported: Array<Record<string, unknown>> = [];
		for (const bucket of retainedBuckets().reverse()) {
			let before = NO_CURSOR;
			for (;;) {
				const rows = await this.deps.repository.list(userId, bucket, before, EXPORT_PAGE_SIZE);
				exported.push(
					...rows.map((row) => ({
						id: row.notification_id.toString(),
						type: row.notification_type,
						post_id: row.post_id?.toString() ?? null,
						comment_id: row.comment_id?.toString() ?? null,
						actor_ids: (row.actor_ids ?? []).map(String),
						actor_count: row.actor_count,
						updated_at: row.updated_at.toISOString(),
					})),
				);
				if (rows.length < EXPORT_PAGE_SIZE) break;
				before = rows.at(-1)!.notification_id;
			}
		}
		return exported;
	}

	/** The data export's read cursor. */
	async exportUserReadState(userId: UserID): Promise<{last_read_at: string | null}> {
		return {last_read_at: (await this.deps.repository.getReadState(userId))?.toISOString() ?? null};
	}

	/** READY's feed inbox state; undefined (READY leaves the field out) for bots, with the feed off, on error or timeout. */
	async getReadyState(
		user: User,
		relationships: ReadonlyArray<Relationship>,
	): Promise<FeedNotificationStateResponse | undefined> {
		const signal = AbortSignal.timeout(READY_STATE_TIMEOUT_MS);
		try {
			if (user.isBot || !this.deps.feedPostService.isFeedEnabled(user)) return undefined;
			return await Promise.race([
				this.readUnreadState(user.id, relationships),
				new Promise<never>((_, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason), {once: true});
				}),
			]);
		} catch (error) {
			readyStateFailures++;
			if (readyStateFailures % READY_FAILURE_LOG_EVERY === 1) {
				Logger.warn(
					{error, userId: user.id.toString(), failures: readyStateFailures},
					'Reading the feed notification state failed; READY goes without it (1 in 1000 logged)',
				);
			}
			return undefined;
		}
	}

	/**
	 * Moves the read cursor to readAt, never back and never past the server time, reads the unread sequence up to what the
	 * session had seen under its epoch, and tells the account's own sessions. Read then write like Fluxer's read states:
	 * two devices marking read at once can keep the earlier of the two times.
	 */
	async markRead(
		userId: UserID,
		readAt: Date,
		seenSeq: number,
		seenEpoch: number,
	): Promise<FeedNotificationAckResponse> {
		const requested = new Date(Math.min(readAt.getTime(), Date.now()));
		const current = await this.deps.repository.getReadState(userId);
		const lastReadAt = current !== null && current.getTime() >= requested.getTime() ? current : requested;
		if (lastReadAt !== current) await this.deps.repository.upsertReadState(userId, lastReadAt);
		const {seq, epoch} = await unreadAck(
			this.deps.kvClient,
			unreadKey(userId),
			seenSeq,
			seenEpoch,
			lastReadAt.getTime(),
		);
		const state: FeedNotificationAckResponse = {
			last_read_at: lastReadAt.toISOString(),
			unread_seq: seq,
			unread_epoch: epoch,
		};
		await this.deps.gatewayService.dispatchPresence({userId, event: 'FEED_NOTIFICATION_ACK', data: state});
		return state;
	}

	private async readUnreadState(
		userId: UserID,
		relationships: ReadonlyArray<Relationship>,
	): Promise<FeedNotificationStateResponse> {
		const kv = this.deps.kvClient;
		const {seq, ready: cached, acked, epoch} = await kv.hgetall(unreadKey(userId));
		const unreadSeq = Number(seq ?? 0);
		// 0 before the hash exists: its sequence is 0, and whatever epoch it starts under is later.
		const unreadEpoch = Number(epoch ?? 0);
		const blocked = blockedSet(relationships);
		const blockedKey = blockedFingerprint(blocked);
		if (cached !== undefined) {
			const [cachedSeq, readAtMs, count, cachedBlocked] = cached.split(':');
			// A read writes its cursor into acked: one other than the count's means a read landed after the count read the
			// cursor. The fingerprint changes with a block and an unblock alike.
			const ackedAt = acked?.split(':')[1];
			if (
				Number(cachedSeq) === unreadSeq &&
				cachedBlocked === blockedKey &&
				(ackedAt === undefined || ackedAt === readAtMs)
			) {
				const lastReadAt = readAtMs ? new Date(Number(readAtMs)).toISOString() : null;
				return {
					last_read_at: lastReadAt,
					unread_count: Number(count),
					unread_seq: unreadSeq,
					unread_epoch: unreadEpoch,
				};
			}
		}
		const bucket = makeBucket(null);
		const [cursor, rows] = await Promise.all([
			this.deps.repository.getReadState(userId),
			this.deps.repository.list(userId, bucket, NO_CURSOR, UNREAD_SCAN_ROWS),
		]);
		// never further back than the bucket before this one (20 days); that bucket only when it can hold an unread row.
		const oldest =
			cursor === null ? bucket - 1 : makeBucket(createSnowflakeFromTimestamp(cursor.getTime() - UNREAD_MARGIN_MS));
		if (rows.length < UNREAD_SCAN_ROWS && oldest < bucket) {
			rows.push(...(await this.deps.repository.list(userId, bucket - 1, NO_CURSOR, UNREAD_SCAN_ROWS - rows.length)));
		}
		// a deleted post's row still counts here (READY reads no posts) until the inbox is opened.
		const unread = rows.filter(
			(row) =>
				(cursor === null || row.updated_at.getTime() > cursor.getTime()) &&
				(row.actor_ids ?? []).some((actorId) => !blocked.has(actorId)),
		).length;
		const unreadCount = Math.min(unread, FEED_NOTIFICATION_UNREAD_CAP);
		// Written under the sequence read before the rows: a notification that came in meanwhile raised it, so this cache no
		// longer matches and the next READY reads again. Same hash, same TTL as the sequence.
		await kv
			.pipeline()
			.hset(unreadKey(userId), 'ready', `${unreadSeq}:${cursor?.getTime() ?? ''}:${unreadCount}:${blockedKey}`)
			.expire(unreadKey(userId), UNREAD_TTL_SECONDS)
			.exec();
		return {
			last_read_at: cursor?.toISOString() ?? null,
			unread_count: unreadCount,
			unread_seq: unreadSeq,
			unread_epoch: unreadEpoch,
		};
	}

	private async aggregateLocked(key: FeedNotificationKey, base: string): Promise<void> {
		const {kvClient: kv, repository} = this.deps;
		const dirty = await kv.get(`${base}:dirty`);
		if (dirty === null) return;
		const [recipient, count, rawSamples] = await Promise.all([
			this.deps.userRepository.findUnique(key.recipientId),
			kv.get(`${base}:count`),
			kv.hgetall(`${base}:actors`),
		]);
		const samples = parseSamples(rawSamples).sort((a, b) => b.at - a.at || b.n - a.n);
		// feature_feed at 0 stops the feed's jobs, and a deleted account gets no more rows.
		const deliverable =
			recipient !== null &&
			(recipient.flags & UserFlags.DELETED) === 0n &&
			this.deps.feedPostService.isFeedEnabled(recipient);
		if (deliverable && samples.length > 0) {
			const latest = samples[0]!;
			const notificationId = await this.notificationId(base);
			const row: FeedNotificationRow = {
				user_id: key.recipientId,
				bucket: makeBucket(notificationId),
				notification_id: notificationId,
				notification_type: key.type,
				post_id: key.type === 'follow' ? null : key.postId,
				comment_id: REPEATED_ACTION_TYPES.has(key.type) ? latest.commentId : null,
				actor_ids: samples.map((sample) => sample.actorId),
				actor_count: Math.max(Number(count ?? 0), samples.length),
				updated_at: new Date(latest.at),
			};
			await repository.upsert(row);
			await this.countUnread(key.recipientId, base, row.updated_at);
			await this.push(row);
		}
		await kv.releaseLock(`${base}:dirty`, dirty);
	}

	/** The key's row ID: made on the key's first job and kept in KV, so later jobs rewrite the same row. */
	private async notificationId(base: string): Promise<bigint> {
		const kv = this.deps.kvClient;
		const stored = await kv.getex(`${base}:id`, STATE_TTL_SECONDS);
		if (stored !== null) return BigInt(stored);
		const notificationId = await this.deps.snowflakeService.generate();
		await kv.setex(`${base}:id`, STATE_TTL_SECONDS, notificationId.toString());
		return notificationId;
	}

	/** Counts the key once per read: its first row, and again when it moves after the recipient's last mark-read. */
	private async countUnread(recipientId: UserID, base: string, updatedAt: Date): Promise<void> {
		const kv = this.deps.kvClient;
		// The key's mark sits in another slot than the account's hash, so it is read first and written after the script.
		const counted = await kv.get(`${base}:counted`);
		const seq = await unreadIncrement(kv, unreadKey(recipientId), updatedAt.getTime(), counted);
		if (seq !== null) await kv.setex(`${base}:counted`, STATE_TTL_SECONDS, String(seq));
	}

	private async push(row: FeedNotificationRow): Promise<void> {
		const kv = this.deps.kvClient;
		const recipientId = row.user_id;
		if (await kv.setnx(recipientKey(recipientId, 'pushed'), '1', PUSH_INTERVAL_SECONDS)) {
			await this.dispatch(row);
			return;
		}
		// Inside the minute the newest change waits for the delivery job at its end (one job per recipient).
		await kv.setex(recipientKey(recipientId, 'held'), STATE_TTL_SECONDS, row.notification_id.toString());
		if (!(await kv.setnx(recipientKey(recipientId, 'delivery'), '1', PUSH_INTERVAL_SECONDS * 2))) return;
		const waitSeconds = Math.max(0, await kv.ttl(recipientKey(recipientId, 'pushed'))) + 1;
		await this.deps.workerService.addJob(
			'aggregateFeedNotification',
			{recipientId: recipientId.toString(), deliver: true},
			{runAt: new Date(Date.now() + waitSeconds * 1000), skipLedger: true},
		);
	}

	private async dispatch(row: FeedNotificationRow): Promise<void> {
		const requestCache = createRequestCache();
		try {
			const [response] = await this.toResponses([row], requestCache, await this.blockedIds(row.user_id));
			if (!response) return;
			const {seq, epoch} = await this.deps.kvClient.hgetall(unreadKey(row.user_id));
			const data: FeedNotificationCreateEvent = {
				...response,
				unread_seq: Number(seq ?? 0),
				unread_epoch: Number(epoch ?? 0),
			};
			await this.deps.gatewayService.dispatchPresence({userId: row.user_id, event: 'FEED_NOTIFICATION_CREATE', data});
		} finally {
			requestCache.clear();
		}
	}

	private async queueAggregate(key: FeedNotificationKey, at = Date.now()): Promise<void> {
		const kv = this.deps.kvClient;
		const queued = `${stateKey(key)}:queued`;
		if (!(await kv.setnx(queued, '1', QUEUED_TTL_SECONDS))) return;
		try {
			await this.deps.workerService.addJob(
				'aggregateFeedNotification',
				{recipientId: key.recipientId.toString(), type: key.type, postId: key.postId.toString(), hour: key.hour},
				{runAt: new Date(at + AGGREGATE_DELAY_MS), skipLedger: true},
			);
		} catch (error) {
			await kv.del(queued);
			throw error;
		}
	}

	private async blockedIds(userId: UserID): Promise<Set<UserID>> {
		return blockedSet(await this.deps.userRepository.listRelationships(userId));
	}

	/** Drops notifications of deleted posts and the actors the recipient blocks (a row left with no actor goes too). */
	private async toResponses(
		rows: Array<FeedNotificationRow>,
		requestCache: RequestCache,
		blocked: ReadonlySet<UserID>,
	): Promise<Array<FeedNotificationResponse>> {
		if (rows.length === 0) return [];
		const postIds = [...new Set(rows.flatMap((row) => (row.post_id == null ? [] : [row.post_id])))];
		const actorIds = [...new Set(rows.flatMap((row) => row.actor_ids ?? []))].filter((id) => !blocked.has(id));
		const contentActorIds = rows.flatMap((row) => (row.comment_id == null ? [] : (row.actor_ids?.slice(0, 1) ?? [])));
		const parentAuthorIds = rows.flatMap((row) =>
			row.notification_type === 'comment_reply' && row.comment_id != null ? [row.user_id] : [],
		);
		const postsLookup = this.deps.feedRepository.getPosts(postIds);
		const [posts, users, cutoffs] = await Promise.all([
			postsLookup,
			this.deps.userCacheService.getUserPartialResponses(actorIds, requestCache),
			postsLookup.then((posts) =>
				this.deps.userCacheService.getContentHiddenSince(
					[...contentActorIds, ...parentAuthorIds, ...Array.from(posts.values(), (post) => post.author_id)],
					requestCache,
				),
			),
		]);
		return rows.flatMap((row) => {
			if (row.post_id != null) {
				const post = posts.get(row.post_id);
				if (!post || !isFeedContentVisible(cutoffs, post.author_id, post.post_id)) return [];
			}
			if (row.comment_id != null) {
				const latestActor = row.actor_ids?.[0];
				if (latestActor === undefined) return [];
				if (row.notification_type === 'comment_reply') {
					// Reply rows retain the parent ID, so a reply author's cutoff cannot be checked per reply.
					if (!isFeedContentVisible(cutoffs, row.user_id, row.comment_id)) return [];
					if (!cutoffs.has(latestActor) || cutoffs.get(latestActor) !== null) return [];
				} else if (!isFeedContentVisible(cutoffs, latestActor, row.comment_id)) return [];
			}
			const sampled = row.actor_ids ?? [];
			const actors = sampled.flatMap((id) => (blocked.has(id) ? [] : (users.get(id) ?? [])));
			if (actors.length === 0) return [];
			return [
				{
					id: row.notification_id.toString(),
					type: row.notification_type as FeedNotificationType,
					post_id: row.post_id?.toString() ?? null,
					comment_id: row.comment_id?.toString() ?? null,
					actors,
					actor_count: Math.max(actors.length, row.actor_count - (sampled.length - actors.length)),
					updated_at: row.updated_at.toISOString(),
				},
			];
		});
	}
}

// Hash tagged per key: the key's state keys share a slot, so their pipeline works on a KV cluster.
function stateKey(key: FeedNotificationKey): string {
	return `feed:notif:{${key.recipientId}:${key.type}:${key.postId}:${key.hour}}`;
}

function recipientKey(recipientId: UserID, name: 'pushed' | 'held' | 'delivery'): string {
	return `feed:notif:${name}:${recipientId}`;
}

// The account's unread hash (seq, acked, ready, epoch): one key, so it needs no hash tag on a KV cluster.
function unreadKey(userId: UserID): string {
	return `feed:notif:unread:${userId}`;
}

// KVClient and the test double both run scripts (UserEmailOwnershipRepository's ScriptableKVProvider).
interface ScriptableKVProvider extends IKVProvider {
	evalScript(command: string, script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
}

/** UNREAD_INCREMENT_SCRIPT: the new unread sequence, or null when the action is read or the key already counted. */
export async function unreadIncrement(
	kv: IKVProvider,
	key: string,
	updatedAtMs: number,
	counted: string | null,
): Promise<number | null> {
	const seq = await (kv as ScriptableKVProvider).evalScript(
		'feedUnreadIncrement',
		UNREAD_INCREMENT_SCRIPT,
		1,
		key,
		updatedAtMs,
		counted ?? '',
		Date.now(),
		UNREAD_TTL_SECONDS,
	);
	return seq === null ? null : Number(seq);
}

/** UNREAD_ACK_SCRIPT: the sequence the read covers and the hash's epoch. */
export async function unreadAck(
	kv: IKVProvider,
	key: string,
	seenSeq: number,
	seenEpoch: number,
	cursorMs: number,
): Promise<{seq: number; epoch: number}> {
	const [seq, epoch] = (await (kv as ScriptableKVProvider).evalScript(
		'feedUnreadAck',
		UNREAD_ACK_SCRIPT,
		1,
		key,
		seenSeq,
		seenEpoch,
		cursorMs,
		Date.now(),
		UNREAD_TTL_SECONDS,
	)) as [unknown, unknown];
	return {seq: Number(seq), epoch: Number(epoch)};
}

function blockedSet(relationships: ReadonlyArray<Relationship>): Set<UserID> {
	return new Set(
		relationships.filter((entry) => entry.type === RelationshipTypes.BLOCKED).map((entry) => entry.targetUserId),
	);
}

// Empty for no blocked account (most accounts), so the cache field grows only for those that block.
function blockedFingerprint(blocked: ReadonlySet<UserID>): string {
	if (blocked.size === 0) return '';
	return createHash('sha1')
		.update([...blocked].map(String).sort().join(','))
		.digest('base64url')
		.slice(0, 8);
}

function parseSamples(raw: Record<string, string>): Array<ActorSample> {
	return Object.values(raw).map((value) => {
		const [n, actorId, at, commentId] = value.split(':');
		return {n: Number(n), actorId: createUserID(BigInt(actorId!)), at: Number(at), commentId: BigInt(commentId!)};
	});
}

function oldestBucket(): number {
	return makeBucket(createSnowflakeFromTimestamp(Date.now() - RETENTION_MS));
}

/** Every bucket a notification can still sit in, oldest first (one past the current one for clock skew). */
function retainedBuckets(): Array<number> {
	const first = oldestBucket();
	return Array.from({length: makeBucket(null) + 2 - first}, (_, index) => first + index);
}
