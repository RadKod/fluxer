// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import {
	BatchBuilder,
	deleteOneOrMany,
	fetchMany,
	fetchManyInChunks,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db, type DbOp} from '@app/api/database/CassandraTypes';
import type {FeedVideoRow} from '@app/api/database/types/FeedTypes';
import {FeedVideos, FeedVideosByAuthor, FeedVideosPending} from '@app/api/feed/FeedTables';
import {MS_PER_HOUR, MS_PER_MINUTE} from '@fluxer/date_utils/src/DateConstants';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

export const PENDING_SHARDS = 64;
const DAY_SECONDS = 86_400;
const WEBHOOK_CLAIM_SECONDS = 60;
const VIDEO_LOCK_SECONDS = 60;
const SCAN_CLAIM_SECONDS = 300;
const TAG_WAIT_SECONDS = 31 * 60;
const EVIDENCE_LOCK_SECONDS = 600;
const ATTEMPTS_SECONDS = 30 * DAY_SECONDS;
const REPORTED_SECONDS = 30 * DAY_SECONDS;
// A report's evidence key before the report is filed: a refused one keeps nothing.
const REPORT_PENDING_SECONDS = 300;
const GONE_SECONDS = 2 * 3600;
const RECONCILE_LOCK_SECONDS = 600;
const RECONCILE_CURSOR_SECONDS = 7 * DAY_SECONDS;
// A clean scan waiting for its post: another holder has the video lock (its retry comes in 30 s) or feature_feed_video
// holds it back (its retry comes in 15 min and renews it).
const CLEAN_SECONDS = 30 * 60;
// A queued scan's wait plus this: past it, a reconcile checkpoint may take the scan as lost.
const SCAN_QUEUED_GRACE_SECONDS = 600;
// A due minute outlives its run time by the JOBS stream's 7 days, so a stopped cron loses no more than a NAK would.
const DUE_KEEP_SECONDS = 7 * DAY_SECONDS;
const DUE_LOCK_SECONDS = 300;
const DUE_LOCK_KEY = 'feed:video:due:lock';
const DUE_CURSOR_KEY = 'feed:video:due:cursor';
const STUCK_KEY = 'feed:video:stuck';
const GONE_HALT_KEY = 'feed:video:gone:halt';
const RECONCILE_LOCK_KEY = 'feed:video:reconcile';
const RECONCILE_CURSOR_KEY = 'feed:video:reconcile:cursor';

const hookKey = (guid: string, status: number) => `feed:video:hook:${guid}:${status}`;
const lockKey = (guid: string) => `feed:video:lock:${guid}`;
const scanKey = (guid: string) => `feed:video:scan:${guid}`;
const tagWaitKey = (phase: string) => `feed:video:tagwait:${phase}`;
const reportedKey = (guid: string) => `feed:video:reported:${guid}`;
const evidenceLockKey = (guid: string) => `feed:video:evidence:${guid}`;
const evidenceAttemptsKey = (guid: string) => `feed:video:evidence_attempts:${guid}`;
const deleteAttemptsKey = (guid: string) => `feed:video:delete_attempts:${guid}`;
const cleanKey = (guid: string) => `feed:video:clean:${guid}`;
const scanQueuedKey = (guid: string) => `feed:video:scan_queued:${guid}`;
const dueKey = (minute: number) => `feed:video:due:${minute}`;
const goneKey = (hour: number) => `feed:video:gone:${hour}`;

/** Unix hours: the partition hour of feed_videos_pending, for a creation snowflake or for now. */
export function pendingHourAt(nowMs: number): number {
	return Math.floor(nowMs / MS_PER_HOUR);
}

/** Unix minutes: the bucket of a job due at `ms`. */
export function dueMinuteAt(ms: number): number {
	return Math.floor(ms / MS_PER_MINUTE);
}

export function pendingHour(createdId: bigint): number {
	return pendingHourAt(snowflakeToDate(createdId).getTime());
}

/** The first two GUID bytes modulo 64. */
export function pendingShard(guid: string): number {
	return Number.parseInt(guid.slice(0, 4), 16) % PENDING_SHARDS;
}

const FETCH_VIDEO_CQL = FeedVideos.selectCql({where: FeedVideos.where.eq('video_guid'), limit: 1});
const FETCH_VIDEOS_CQL = FeedVideos.selectCql({where: FeedVideos.where.in('video_guid', 'video_guids')});

function authorVideosQuery(limit: number) {
	return FeedVideosByAuthor.select({
		columns: ['video_guid'],
		where: FeedVideosByAuthor.where.eq('author_id'),
		orderBy: {col: 'created_id', direction: 'DESC'},
		limit,
	});
}

function pendingQuery(limit: number) {
	return FeedVideosPending.select({
		columns: ['video_guid'],
		where: [
			FeedVideosPending.where.eq('hour'),
			FeedVideosPending.where.eq('shard'),
			FeedVideosPending.where.gt('video_guid', 'after'),
		],
		orderBy: {col: 'video_guid', direction: 'ASC'},
		limit,
	});
}

type FeedVideoPatch = Partial<Omit<FeedVideoRow, 'video_guid' | 'updated_at'>>;

/**
 * feed_videos, its author and pending indexes, and the video KV keys. Rows are written by
 * FeedVideoService only, and every state change after create runs under lockVideo: Cassandra's UPDATE is an
 * upsert, so an update that did not re-read its row under the lock could bring back a deleted video.
 */
export class FeedVideoRepository {
	constructor(private readonly kv: IKVProvider) {}

	/** The video row, the author's processing list entry and the pending index row in one logged batch. */
	async create(row: FeedVideoRow): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(FeedVideos.upsertAll(row));
		batch.addPrepared(
			FeedVideosByAuthor.upsertAll({author_id: row.author_id, created_id: row.created_id, video_guid: row.video_guid}),
		);
		batch.addPrepared(
			FeedVideosPending.upsertAll({
				hour: pendingHour(row.created_id),
				shard: pendingShard(row.video_guid),
				video_guid: row.video_guid,
			}),
		);
		await batch.execute();
	}

	async get(guid: string): Promise<FeedVideoRow | null> {
		return fetchOne<FeedVideoRow>(FETCH_VIDEO_CQL, {video_guid: guid});
	}

	/** Only under lockVideo, after re-reading the row (K9a). */
	async update(guid: string, patch: FeedVideoPatch): Promise<void> {
		const ops: Partial<Record<keyof FeedVideoRow, DbOp<unknown>>> = {updated_at: Db.set(new Date())};
		for (const [column, value] of Object.entries(patch)) {
			if (value !== undefined) ops[column as keyof FeedVideoPatch] = Db.set(value);
		}
		await upsertOne(FeedVideos.patchByPk({video_guid: guid}, ops as Parameters<typeof FeedVideos.patchByPk>[1]));
	}

	/** The author's listed videos, newest first (the list is bounded by the daily post cap). */
	async listByAuthor(authorId: UserID, limit: number): Promise<Array<FeedVideoRow>> {
		const index = await fetchMany<{video_guid: string}>(authorVideosQuery(limit).bind({author_id: authorId}));
		if (index.length === 0) return [];
		const rows = await fetchManyInChunks<FeedVideoRow, string>(
			FETCH_VIDEOS_CQL,
			index.map((entry) => entry.video_guid),
			(chunk) => ({video_guids: chunk}),
		);
		const byGuid = new Map(rows.map((row) => [row.video_guid, row]));
		return index.flatMap((entry) => byGuid.get(entry.video_guid) ?? []);
	}

	/** The video row and both index rows. Only under lockVideo, so no update can bring the row back. */
	async delete(row: FeedVideoRow): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(FeedVideos.deleteByPk({video_guid: row.video_guid}));
		batch.addPrepared(FeedVideosByAuthor.deleteByPk({author_id: row.author_id, created_id: row.created_id}));
		batch.addPrepared(this.pendingDelete(row));
		await batch.execute();
	}

	/** Drops only the pending index row: the video left reconciliation. */
	async finishPending(row: Pick<FeedVideoRow, 'video_guid' | 'created_id'>): Promise<void> {
		await deleteOneOrMany(this.pendingDelete(row));
	}

	async deleteAuthorIndex(row: Pick<FeedVideoRow, 'author_id' | 'created_id'>): Promise<void> {
		await deleteOneOrMany(FeedVideosByAuthor.deleteByPk({author_id: row.author_id, created_id: row.created_id}));
	}

	/** One page of a pending partition's GUIDs in order, after `after` (null = from the start). */
	async listPending(hour: number, shard: number, after: string | null, limit: number): Promise<Array<string>> {
		const rows = await fetchMany<{video_guid: string}>(pendingQuery(limit).bind({hour, shard, after: after ?? ''}));
		return rows.map((row) => row.video_guid);
	}

	/** One webhook (GUID, status) is processed once a minute; Bunny's signed body carries no timestamp to check. */
	claimWebhook(guid: string, status: number): Promise<boolean> {
		return this.kv.setnx(hookKey(guid, status), '1', WEBHOOK_CLAIM_SECONDS);
	}

	async releaseWebhook(guid: string, status: number): Promise<void> {
		await this.kv.del(hookKey(guid, status));
	}

	/** The token that must release the lock, or null when another holder has it. */
	lockVideo(guid: string): Promise<string | null> {
		return this.takeLock(lockKey(guid), VIDEO_LOCK_SECONDS);
	}

	async unlockVideo(guid: string, token: string): Promise<void> {
		await this.kv.releaseLock(lockKey(guid), token);
	}

	claimScan(guid: string): Promise<boolean> {
		return this.kv.setnx(scanKey(guid), '1', SCAN_CLAIM_SECONDS);
	}

	/** One tagging wait per scan of a video: `phase` is the GUID and the scan's start. */
	claimTagWait(phase: string): Promise<boolean> {
		return this.kv.setnx(tagWaitKey(phase), '1', TAG_WAIT_SECONDS);
	}

	lockEvidence(guid: string): Promise<string | null> {
		return this.takeLock(evidenceLockKey(guid), EVIDENCE_LOCK_SECONDS);
	}

	async unlockEvidence(guid: string, token: string): Promise<void> {
		await this.kv.releaseLock(evidenceLockKey(guid), token);
	}

	/** Counts a failed evidence copy; the count lives 30 days from the latest failure. */
	countEvidenceAttempt(guid: string): Promise<number> {
		return this.countAttempt(evidenceAttemptsKey(guid));
	}

	/** Counts a failed Bunny delete; the count lives 30 days from the latest failure. */
	countDeleteAttempt(guid: string): Promise<number> {
		return this.countAttempt(deleteAttemptsKey(guid));
	}

	/** Counts a published video Bunny lost in this Unix hour; the count lives 2 hours. */
	countGone(hour: number): Promise<number> {
		return this.countAttempt(goneKey(hour), GONE_SECONDS);
	}

	/**
	 * Halts removing the posts of gone videos until an operator deletes the key (no TTL). The hour's count stays: a check beside the halting one counts on from it and halts too, instead of starting at 1 and removing.
	 */
	async haltGone(): Promise<void> {
		await this.kv.set(GONE_HALT_KEY, '1');
	}

	async isGoneHalted(): Promise<boolean> {
		return (await this.kv.get(GONE_HALT_KEY)) !== null;
	}

	/** A video whose delete or evidence copy failed 8 times; the set has no TTL and lists it until it succeeds. */
	async markStuck(guid: string): Promise<void> {
		await this.kv.sadd(STUCK_KEY, guid);
	}

	async clearStuck(guid: string): Promise<void> {
		await this.kv.srem(STUCK_KEY, guid);
	}

	countStuck(): Promise<number> {
		return this.kv.scard(STUCK_KEY);
	}

	/**
	 * A reported video keeps its evidence key 30 days, so a later delete copies the evidence first. A `pending` report
	 * sets it for 5 minutes, and only when no key is there: it never shortens the key of a filed one.
	 */
	async markReported(guid: string, evidenceKey: string, pending = false): Promise<void> {
		if (pending) await this.kv.setnx(reportedKey(guid), evidenceKey, REPORT_PENDING_SECONDS);
		else await this.kv.setex(reportedKey(guid), REPORTED_SECONDS, evidenceKey);
	}

	getReported(guid: string): Promise<string | null> {
		return this.kv.get(reportedKey(guid));
	}

	/** A clean scan of this upload (its dateUploaded and originalHash) that could not post yet. */
	async markClean(guid: string, upload: string): Promise<void> {
		await this.kv.setex(cleanKey(guid), CLEAN_SECONDS, upload);
	}

	/** Another 30 minutes for a clean scan's mark while its post is held; nothing when there is none. */
	async keepClean(guid: string): Promise<void> {
		await this.kv.expire(cleanKey(guid), CLEAN_SECONDS);
	}

	getClean(guid: string): Promise<string | null> {
		return this.kv.get(cleanKey(guid));
	}

	/** A scan of the video is queued to run in `delayMs`, so a reconcile checkpoint starts no second chain. */
	async markScanQueued(guid: string, delayMs: number): Promise<void> {
		await this.kv.setex(scanQueuedKey(guid), Math.ceil(delayMs / 1000) + SCAN_QUEUED_GRACE_SECONDS, '1');
	}

	async isScanQueued(guid: string): Promise<boolean> {
		return (await this.kv.get(scanQueuedKey(guid))) !== null;
	}

	/** A job due later than a minute from now waits in its minute's sorted set, scored by its run time. */
	async addDue(job: string, runAtMs: number): Promise<void> {
		const key = dueKey(dueMinuteAt(runAtMs));
		await this.kv.zadd(key, runAtMs, job);
		await this.kv.expire(key, Math.max(0, Math.ceil((runAtMs - Date.now()) / 1000)) + DUE_KEEP_SECONDS);
	}

	/** Up to `limit` jobs of one due minute, earliest first. */
	listDue(minute: number, limit: number): Promise<Array<string>> {
		return this.kv.zrangebyscore(dueKey(minute), '-inf', '+inf', 'LIMIT', 0, limit);
	}

	async removeDue(minute: number, jobs: Array<string>): Promise<void> {
		await this.kv.zrem(dueKey(minute), ...jobs);
	}

	/** The last due minute the cron has emptied, or null before its first run. */
	async getDueCursor(): Promise<number | null> {
		const raw = await this.kv.get(DUE_CURSOR_KEY);
		return raw === null ? null : Number(raw);
	}

	// No TTL: a cron stopped for days resumes from here (the minutes themselves expire after 7 days).
	async setDueCursor(minute: number): Promise<void> {
		await this.kv.set(DUE_CURSOR_KEY, String(minute));
	}

	lockDue(): Promise<string | null> {
		return this.takeLock(DUE_LOCK_KEY, DUE_LOCK_SECONDS);
	}

	async unlockDue(token: string): Promise<void> {
		await this.kv.releaseLock(DUE_LOCK_KEY, token);
	}

	/** The last hour the reconcile cron queued, or null. */
	async getReconcileCursor(): Promise<number | null> {
		const raw = await this.kv.get(RECONCILE_CURSOR_KEY);
		return raw === null ? null : Number(raw);
	}

	async setReconcileCursor(hour: number): Promise<void> {
		await this.kv.setex(RECONCILE_CURSOR_KEY, RECONCILE_CURSOR_SECONDS, String(hour));
	}

	lockReconcile(): Promise<string | null> {
		return this.takeLock(RECONCILE_LOCK_KEY, RECONCILE_LOCK_SECONDS);
	}

	async unlockReconcile(token: string): Promise<void> {
		await this.kv.releaseLock(RECONCILE_LOCK_KEY, token);
	}

	private pendingDelete(row: Pick<FeedVideoRow, 'video_guid' | 'created_id'>) {
		return FeedVideosPending.deleteByPk({
			hour: pendingHour(row.created_id),
			shard: pendingShard(row.video_guid),
			video_guid: row.video_guid,
		});
	}

	private async takeLock(key: string, ttlSeconds: number): Promise<string | null> {
		const token = randomUUID();
		return (await this.kv.acquireLock(key, token, ttlSeconds)) ? token : null;
	}

	private async countAttempt(key: string, ttlSeconds = ATTEMPTS_SECONDS): Promise<number> {
		const count = await this.kv.incr(key);
		await this.kv.expire(key, ttlSeconds);
		return count;
	}
}
