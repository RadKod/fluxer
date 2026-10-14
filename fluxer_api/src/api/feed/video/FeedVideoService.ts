// SPDX-License-Identifier: AGPL-3.0-or-later

import {once} from 'node:events';
import {PassThrough} from 'node:stream';
import type {UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {
	type FeedMedia,
	FeedPostFlags,
	type FeedPostRow,
	type FeedVideoRow,
	type FeedVideoState,
} from '@app/api/database/types/FeedTypes';
import {dailyLimitError, scanFeedText} from '@app/api/feed/FeedPostService';
import {type FeedRepository, feedDay} from '@app/api/feed/FeedRepository';
import {isHiddenFeedAuthor} from '@app/api/feed/FeedTimelineService';
import {
	type BunnyStorageEntry,
	type BunnyStreamClient,
	BunnyStreamError,
	type BunnyVideo,
} from '@app/api/feed/video/BunnyStreamClient';
import {
	dueMinuteAt,
	type FeedVideoRepository,
	PENDING_SHARDS,
	pendingHourAt,
} from '@app/api/feed/video/FeedVideoRepository';
import {
	displaySize,
	FEED_VIDEO_EVIDENCE_MAX_BYTES,
	type FeedVideoScanner,
	isAdultCategory,
	parseMasterPlaylist,
	parseMediaPlaylist,
	TAGGING_GRACE_MS,
} from '@app/api/feed/video/FeedVideoScanner';
import {
	type FeedStreamSettings,
	feedStreamEvidenceKey,
	isStreamMedia,
	signTusUpload,
	verifyWebhookSignature,
} from '@app/api/feed/video/FeedVideoUrls';
import type {IPurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {User} from '@app/api/models/User';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import {isContentHidden} from '@app/api/user/UserHelpers';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import {MS_PER_HOUR as HOUR_MS, MS_PER_MINUTE as MINUTE_MS} from '@fluxer/date_utils/src/DateConstants';
import {BadGatewayError} from '@fluxer/errors/src/domains/core/BadGatewayError';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {UnauthorizedError} from '@fluxer/errors/src/domains/core/UnauthorizedError';
import {DEFAULT_FREE_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import {
	FEED_VIDEO_MAX_BYTES,
	type FeedVideoCreateRequest,
	FeedVideoWebhookBody,
} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import type {
	FeedPendingVideoListResponse,
	FeedPendingVideoState,
	FeedVideoUploadResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {createSnowflakeFromTimestamp, snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import {z} from 'zod';

const FEED_VIDEO_JOBS = [
	'processFeedVideoWebhook',
	'scanFeedVideo',
	'deleteFeedVideo',
	'keepFeedVideoEvidence',
	'reconcileFeedVideoBucket',
] as const;
export type FeedVideoJobName = (typeof FEED_VIDEO_JOBS)[number];

type ReconcileBucket = {hour: number; shard: number; checkpoint: 1 | 9 | 72; after?: string; guid?: string};

export interface FeedVideoPublisher {
	publishPost(author: User, post: FeedPostRow, postedToday: number): Promise<void>;
	removePost(post: FeedPostRow, o: {priority?: boolean}): Promise<void>;
}

export type FeedVideoDmKey = 'feed.video_failed' | 'feed.video_too_large' | 'feed.video_rejected' | 'feed.video_gone';

export interface FeedVideoWorker {
	addJob(
		task: FeedVideoJobName,
		payload: Record<string, unknown>,
		o?: {jobKey?: string; runAt?: Date},
	): Promise<unknown>;
}

export interface FeedVideoServiceDeps {
	repository: FeedVideoRepository;
	client: BunnyStreamClient;
	scanner: FeedVideoScanner;
	settings: () => FeedStreamSettings;
	posts: FeedVideoPublisher;
	feedRepository: Pick<FeedRepository, 'countPostsToday' | 'addPostToday' | 'getPost'>;
	worker: FeedVideoWorker;
	snowflake: Pick<ISnowflakeService, 'generate'>;
	limits: Pick<LimitConfigService, 'getConfigSnapshot'>;
	users: Pick<IUserRepository, 'findUnique'>;
	storage: Pick<IStorageService, 'getObjectMetadata' | 'uploadObject'>;
	purgeQueue: IPurgeQueue;
	notifyAuthor: (authorId: UserID, key: FeedVideoDmKey) => Promise<void>;
}

const UPLOAD_SIGNATURE_SECONDS = 2 * 3600;
const RESIGN_WINDOW_MS = 6 * HOUR_MS;
const MAX_IN_FLIGHT = 3;
// A video still on its way past the 72 h checkpoint was missed by it (a failed bucket job, a stopped cron).
const STALE_IN_FLIGHT_MS = 73 * HOUR_MS;
// The author index holds in-flight videos plus those published in the last 9 (or 72) hours: at most the daily post
// cap for 3 days. TEMPORARY: one read of 500; an admin cap above ~160 posts a day needs paging here.
const AUTHOR_READ_LIMIT = 500;
const PENDING_LIST_LIMIT = 20;
const LOCK_RETRY_MS = 30_000;
const EVIDENCE_BUSY_RETRY_MS = MINUTE_MS;
const RECHECK_MS = 15 * MINUTE_MS;
const HELD_RETRY_MS = 15 * MINUTE_MS;
const MAX_RECHECKS = 8;
const SCAN_DELAYS_MINUTES = [1, 5, 15, 60, 180, 360];
const RETRY_DELAYS_MINUTES = [1, 5, 15, 60, 180, 360, 360, 360];
const DAILY_RETRY_MINUTES = 1440;
const STUCK_AFTER = 8;
// Bunny's webhook statuses are 0-10; any other number is acknowledged and ignored.
const MAX_WEBHOOK_STATUS = 10;
const STATUS_UPLOADED = 1;
const STATUS_FINISHED = 4;
const STATUS_ERROR = 5;
const STATUS_UPLOAD_FAILED = 6;
const CHECKPOINTS = [1, 9, 72] as const;
const RECONCILE_DEFAULT_HOURS = 24;
const RECONCILE_MAX_HOURS = 96;
const RECONCILE_QUEUE_CONCURRENCY = 16;
const BUCKET_PAGE = 500;
const BUCKET_PAGES = 4;
const BUCKET_CONCURRENCY = 8;
// A scan queued by reconciliation retries at the 6 h end of the schedule.
const RECONCILE_SCAN_ATTEMPT = 5;
const MASTER_PLAYLIST_MAX_BYTES = 64 * 1024;
const MEDIA_PLAYLIST_MAX_BYTES = 1024 * 1024;
const MP4_PATTERN = /^play_(\d{3,4})p\.mp4$/;
const MP4_PREFERRED = 720;
const IN_FLIGHT: ReadonlySet<FeedVideoState> = new Set(['uploading', 'processing', 'scanning']);
// a job due later than this waits in a KV minute bucket, not as a NAKed message holding a max_ack_pending slot.
const NAK_MAX_MS = MINUTE_MS;
const DUE_PAGE = 500;
const DUE_MAX_PER_RUN = 5_000;
const DUE_QUEUE_CONCURRENCY = 16;
// The minute buckets live 7 days past their minute; an older cursor skips what has expired.
const DUE_MAX_CATCH_UP_MINUTES = 7 * 24 * 60;
// Read again next run: a writer whose clock runs behind can still add to a minute just emptied.
const DUE_SKEW_MINUTES = 2;
// posts removed an hour because Bunny lost their video; more is taken for a misconfiguration and halts these
// removals until an operator lifts it. TEMPORARY: one fixed number for the whole instance; path: a share of the
// hour's checkpoint reads; trigger: a halt while Bunny reports no incident and the configuration is right.
const GONE_MAX_PER_HOUR = 20;
const BUSY = Symbol('busy');

const notFound = () => new NotFoundError({code: APIErrorCodes.NOT_FOUND});
const conflict = () => new ConflictError({code: APIErrorCodes.CONFLICT});

/** One upload of a Bunny video: a re-upload changes its dateUploaded and originalHash. */
function uploadOf(upload: {dateUploaded?: string | null; originalHash?: string | null}): string {
	return `${upload.dateUploaded ?? ''}|${upload.originalHash ?? ''}`;
}

function rowUpload(row: FeedVideoRow): string {
	return uploadOf({dateUploaded: row.uploaded_at, originalHash: row.original_hash});
}

function retryDelayMs(attempts: number): number {
	return (RETRY_DELAYS_MINUTES[attempts - 1] ?? DAILY_RETRY_MINUTES) * MINUTE_MS;
}

function inMs(delayMs: number): Date {
	return new Date(Date.now() + delayMs);
}

function listed(files: Array<BunnyStorageEntry> | null, name: string): BunnyStorageEntry | undefined {
	return files?.find((file) => file.name === name && !file.isDirectory);
}

/** play_720p.mp4, else the largest MP4 below it, else none (Bunny's MP4 fallback may be off). */
function pickMp4(files: Array<BunnyStorageEntry>): string | null {
	let best: {name: string; height: number} | null = null;
	for (const file of files) {
		const height = Number(MP4_PATTERN.exec(file.name)?.[1] ?? Number.NaN);
		if (file.isDirectory || !(height <= MP4_PREFERRED) || (best && best.height >= height)) continue;
		best = {name: file.name, height};
	}
	return best?.name ?? null;
}

const DueJobSchema = z.object({
	task: z.enum(FEED_VIDEO_JOBS),
	payload: z.record(z.string(), z.unknown()),
	runAt: z.number(),
	jobKey: z.string().optional(),
});
type DueJob = z.infer<typeof DueJobSchema>;

function parseDueJob(raw: string): DueJob | null {
	try {
		return DueJobSchema.parse(JSON.parse(raw));
	} catch {
		return null;
	}
}

/**
 * the video lane's worker. A job due within a minute goes to JetStream, whose runner NAKs it until then; a later
 * one (scan retries up to 6 h, delete and evidence retries up to a day) waits in a KV bucket of its due minute and
 * drainDueJobs hands it over, so waiting jobs never hold the lane's max_ack_pending slots. TEMPORARY: one sorted set per
 * minute drained by one cron job, at most 5 000 jobs a run; path: shard each minute (`feed:video:due:<minute>:<n>`)
 * with one drain job per shard; trigger: "Feed video due jobs are behind" in the logs.
 */
export function deferLongWaits(worker: FeedVideoWorker, repository: FeedVideoRepository): FeedVideoWorker {
	return {
		addJob: async (task, payload, o) => {
			const runAt = o?.runAt?.getTime();
			if (runAt === undefined || runAt - Date.now() <= NAK_MAX_MS) return worker.addJob(task, payload, o);
			const job: DueJob = {task, payload, runAt, ...(o?.jobKey ? {jobKey: o.jobKey} : {})};
			await repository.addDue(JSON.stringify(job), runAt);
			return undefined;
		},
	};
}

/**
 * The minute cron: hands the jobs of every due minute since its cursor to the queue with their own run time
 * and job key, then drops them, under one lock and at most 5 000 a run. A crash between the two queues a job again
 * under the same key, which JetStream drops within its 2 min duplicate window. `worker` is the queue itself, never
 * the deferLongWaits wrapper. Its first run (no cursor) reads the whole 7 days the minutes live, and a member that is
 * no job of this lane is dropped with an error, so neither a late start nor one broken member holds jobs back;
 * a failing queue fails the run and the next one reads the same minutes. Returns the number taken off the minutes.
 */
export async function drainDueJobs(
	repository: FeedVideoRepository,
	worker: FeedVideoWorker,
	nowMs = Date.now(),
): Promise<number> {
	const token = await repository.lockDue();
	if (token === null) return 0;
	try {
		const nowMinute = dueMinuteAt(nowMs);
		const cursor = (await repository.getDueCursor()) ?? nowMinute - DUE_MAX_CATCH_UP_MINUTES;
		let moved = 0;
		for (let minute = Math.max(cursor, nowMinute - DUE_MAX_CATCH_UP_MINUTES) + 1; minute <= nowMinute; minute++) {
			for (;;) {
				const jobs = await repository.listDue(minute, Math.min(DUE_PAGE, DUE_MAX_PER_RUN - moved));
				if (jobs.length === 0) break;
				await mapWithConcurrency(jobs, DUE_QUEUE_CONCURRENCY, async (raw) => {
					const job = parseDueJob(raw);
					if (!job) {
						Logger.error({minute, job: raw.slice(0, 200)}, 'Dropping a malformed feed video due job');
						return;
					}
					await worker.addJob(job.task, job.payload, {
						runAt: new Date(job.runAt),
						...(job.jobKey ? {jobKey: job.jobKey} : {}),
					});
				});
				await repository.removeDue(minute, jobs);
				moved += jobs.length;
				if (moved >= DUE_MAX_PER_RUN) {
					Logger.warn({minute, behind: nowMinute - minute}, 'Feed video due jobs are behind');
					await repository.setDueCursor(minute - 1);
					return moved;
				}
			}
		}
		await repository.setDueCursor(Math.max(cursor, nowMinute - DUE_SKEW_MINUTES));
		return moved;
	} finally {
		await repository.unlockDue(token);
	}
}

type ScanOutcome =
	| {kind: 'wait' | 'gone' | 'inconclusive'}
	| {kind: 'layout' | 'nsfw' | 'clean'; video: BunnyVideo; files: Array<BunnyStorageEntry>};

/**
 * The feed video state machine: a Bunny Stream video waits in feed_videos, is scanned when Bunny finishes it
 * and becomes a post only when the scan is clean, so no read path can show it before. Every decision re-reads Bunny,
 * and every change of a feed_videos row happens under the video lock after re-reading the row, so a cancel, a
 * failure and a publish cannot overwrite each other or bring a deleted row back. Bunny calls, frame scans and
 * evidence copies run outside the lock. Jobs never fail for Bunny: they reschedule themselves.
 */
export class FeedVideoService {
	constructor(private readonly deps: FeedVideoServiceDeps) {}

	isEnabledFor(user: User): boolean {
		return this.deps.settings().enabled && this.resolveLimit(user, 'feature_feed_video') !== 0;
	}

	/** A new upload: the text is checked, at most 3 videos in flight, one post of the day is used up front. */
	async start(user: User, input: FeedVideoCreateRequest): Promise<FeedVideoUploadResponse> {
		const {repository, feedRepository, client} = this.deps;
		if (!this.isEnabledFor(user)) throw new FeatureTemporarilyDisabledError();
		const content = input.content ?? null;
		scanFeedText(user.id, content);
		// GEÇİCİ (#12): the in-flight count reads the author's index (a handful of rows) and two concurrent starts can
		// both pass it; FEED_VIDEO_CREATE (3/min) bounds that to 5. Path: a KV INCR/DECR counter kept on every exit
		// from in flight, capped by a TTL. Trigger: the start route p99 over 200 ms or an author seen with more than 3
		// videos in flight.
		const videos = await this.failStale(await repository.listByAuthor(user.id, AUTHOR_READ_LIMIT));
		if (videos.filter((video) => IN_FLIGHT.has(video.state)).length >= MAX_IN_FLIGHT) {
			throw new RateLimitError({
				retryAfter: 60,
				limit: MAX_IN_FLIGHT,
				resetTime: inMs(MINUTE_MS),
				scope: 'user',
			});
		}
		const createdId = await this.deps.snowflake.generate();
		const day = feedDay(createdId);
		const maxPerDay = this.resolveLimit(user, 'max_feed_posts_per_day');
		if ((await feedRepository.countPostsToday(user.id, day)) >= maxPerDay) throw dailyLimitError(maxPerDay, day);
		let guid: string;
		try {
			({guid} = await client.createVideo(createdId.toString()));
		} catch (error) {
			if (error instanceof BunnyStreamError) throw new BadGatewayError();
			throw error;
		}
		try {
			if ((await feedRepository.addPostToday(user.id, day)) > maxPerDay) throw dailyLimitError(maxPerDay, day);
			await repository.create({
				video_guid: guid,
				author_id: user.id,
				created_id: createdId,
				state: 'uploading',
				content,
				flags: input.public ? FeedPostFlags.PUBLIC : 0,
				content_type: input.content_type,
				declared_size: BigInt(input.file_size),
				post_id: null,
				uploaded_at: null,
				original_hash: null,
				width: null,
				height: null,
				duration: null,
				mp4_file: null,
				scan_started_at: null,
				updated_at: new Date(),
			});
		} catch (error) {
			await client
				.deleteVideo(guid)
				.catch((deleteError) =>
					Logger.warn({guid, error: deleteError}, 'Deleting an unused feed video from Bunny failed'),
				);
			throw error;
		}
		return this.ticket(guid);
	}

	/** A fresh TUS signature for the author's own upload, only within 6 h of its start (every signature ends by 8 h). */
	async resign(user: User, guid: string): Promise<FeedVideoUploadResponse> {
		if (!this.isEnabledFor(user)) throw new FeatureTemporarilyDisabledError();
		const allowed = await this.locked(
			guid,
			async (row) =>
				row !== null &&
				row.author_id === user.id &&
				row.state === 'uploading' &&
				Date.now() - snowflakeToDate(row.created_id).getTime() < RESIGN_WINDOW_MS,
		);
		if (allowed === BUSY) throw conflict();
		if (!allowed) throw notFound();
		return this.ticket(guid);
	}

	/** The author gives up a video that is not a post yet. */
	async cancel(user: User, guid: string): Promise<void> {
		const row = await this.locked(guid, async (current) => {
			if (!current || current.author_id !== user.id || !IN_FLIGHT.has(current.state)) return null;
			await this.markDeleting(current);
			return current;
		});
		if (row === BUSY) throw conflict();
		if (!row) throw notFound();
		await this.afterDeleting(row, null);
	}

	/** The author's videos on their way, newest first; published ones only for the first hour. */
	async listPending(user: User): Promise<FeedPendingVideoListResponse> {
		const rows = await this.failStale(await this.deps.repository.listByAuthor(user.id, PENDING_LIST_LIMIT));
		const now = Date.now();
		return rows
			.filter(
				(row) =>
					IN_FLIGHT.has(row.state) ||
					(row.state === 'published' &&
						row.post_id != null &&
						!isContentHidden(user, row.post_id) &&
						now - snowflakeToDate(row.post_id).getTime() < HOUR_MS),
			)
			.map((row) => ({
				id: row.video_guid,
				state: row.state as FeedPendingVideoState,
				created_at: snowflakeToDate(row.created_id).toISOString(),
				post_id: row.post_id?.toString() ?? null,
			}));
	}

	/**
	 * Bunny's webhook (its body already capped at 4 KiB by the controller): nothing reaches the queue without a v1
	 * HMAC-SHA256 signature of the raw body. One job per (GUID, status) a minute; a failed hand-off releases the claim
	 * so Bunny's retry is not dropped.
	 */
	async acceptWebhook(
		rawBody: string,
		headers: {signature?: string; version?: string; algorithm?: string},
	): Promise<void> {
		const settings = this.deps.settings();
		if (!settings.enabled) throw new ServiceUnavailableError();
		if (
			headers.version !== 'v1' ||
			headers.algorithm !== 'hmac-sha256' ||
			!headers.signature ||
			!verifyWebhookSignature(settings.readOnlyApiKey, rawBody, headers.signature)
		) {
			throw new UnauthorizedError();
		}
		let body: FeedVideoWebhookBody;
		try {
			body = FeedVideoWebhookBody.parse(JSON.parse(rawBody));
		} catch {
			// Signed by Bunny but not the shape we know: a 4xx would have Bunny retry it without end.
			Logger.warn({bytes: rawBody.length}, 'Ignoring a signed Bunny webhook of an unknown shape');
			return;
		}
		if (body.VideoLibraryId !== settings.libraryId || body.Status < 0 || body.Status > MAX_WEBHOOK_STATUS) return;
		const guid = body.VideoGuid;
		if (!(await this.deps.repository.claimWebhook(guid, body.Status))) return;
		try {
			await this.deps.worker.addJob('processFeedVideoWebhook', {guid}, {jobKey: `${guid}:${body.Status}`});
		} catch (error) {
			await this.deps.repository.releaseWebhook(guid, body.Status);
			throw error;
		}
	}

	/** One processFeedVideoWebhook job: re-reads Bunny and moves the video on. */
	async handleWebhook(guid: string, o: {recheck?: number} = {}): Promise<void> {
		const recheck = o.recheck ?? 0;
		const row = await this.deps.repository.get(guid);
		if (!row || row.state === 'deleting') return;
		const video = await this.deps.client.getVideo(guid);
		if (!(await this.advance(row, video, recheck))) {
			await this.deps.worker.addJob('processFeedVideoWebhook', {guid, recheck}, {runAt: inMs(LOCK_RETRY_MS)});
		}
	}

	/**
	 * One scanFeedVideo job. Never throws for Bunny or the media proxy: an inconclusive scan reschedules itself (1, 5,
	 * 15 min, 1, 3, 6 h) and stays unpublished until the 72 h checkpoint fails it.
	 */
	async scan(guid: string, attempt: number): Promise<void> {
		const {repository} = this.deps;
		const row = await repository.get(guid);
		if (row?.state !== 'scanning') return;
		// One scan body per attempt of one scanning phase. The claim is not released (the repository has no release),
		// so it is keyed by attempt: a retry 30 s or 1 min later is a new attempt and runs, a second delivery of the same
		// one does not; a re-upload scanned again starts a new phase.
		if (!(await repository.claimScan(`${guid}:${row.scan_started_at?.getTime() ?? 0}:${attempt}`))) return;
		// The one read of the author, before any Bunny call, decides the post too: a deleted or disabled
		// author's video goes quietly; feature_feed or feature_feed_video at 0 holds it, a held one costing a
		// user read and the renewal of a clean scan's mark in 15 min, so its frames are not read again after 30 min.
		const author = await this.deps.users.findUnique(row.author_id);
		if (!author || isHiddenFeedAuthor(author)) return this.failFromScan(row, attempt, null);
		if (this.holdsPost(author)) {
			// A failed renewal costs at most a second frame scan, never the chain.
			await repository
				.keepClean(guid)
				.catch((error) => Logger.warn({guid, error}, 'Renewing a held feed video clean mark failed'));
			return this.retryScan(row, attempt, HELD_RETRY_MS);
		}
		const retryDelay = (SCAN_DELAYS_MINUTES[Math.min(attempt, SCAN_DELAYS_MINUTES.length - 1)] ?? 0) * MINUTE_MS;
		let outcome: ScanOutcome;
		try {
			outcome = await this.runScan(row, attempt);
		} catch (error) {
			Logger.warn({guid, attempt, error}, 'Feed video scan failed');
			outcome = {kind: 'inconclusive'};
		}
		switch (outcome.kind) {
			case 'wait':
				return;
			case 'inconclusive':
				return this.retryScan(row, attempt + 1, retryDelay);
			case 'gone':
			case 'layout':
				return this.failFromScan(row, attempt, 'feed.video_failed');
			case 'nsfw':
				return this.failFromScan(row, attempt, 'feed.video_rejected');
			case 'clean':
				try {
					return await this.publish(row, author, attempt, outcome.video, outcome.files, retryDelay);
				} catch (error) {
					Logger.warn({guid, attempt, error}, 'Publishing a feed video failed');
					return this.retryScan(row, attempt + 1, retryDelay);
				}
		}
	}

	/**
	 * One deleteFeedVideo job (post removed, video failed or cancelled). A reported video's evidence is kept first;
	 * a failed copy or Bunny delete retries 1, 5, 15 min, 1, 3, 6, 6, 6 h and then once a day without end, listed in
	 * feed:video:stuck from the 8th failure. The row goes last, under the lock.
	 */
	async deleteVideo(guid: string, o: {priority?: boolean; evidence?: string}): Promise<void> {
		const {repository} = this.deps;
		const payload = {guid, ...(o.priority ? {priority: true} : {}), ...(o.evidence ? {evidence: o.evidence} : {})};
		// a removal's evidence is recorded first, so a plain delete queued meanwhile (a reconcile checkpoint) copies it
		// too instead of deleting the video before its evidence exists.
		if (o.evidence) await repository.markReported(guid, o.evidence);
		const marked = await this.locked(guid, async (row) => {
			if (row && row.state !== 'deleting') await repository.update(guid, {state: 'deleting', content: null});
			return true;
		});
		if (marked === BUSY) return this.requeueDelete(payload, LOCK_RETRY_MS);
		const evidence = o.evidence ?? (await repository.getReported(guid));
		if (evidence) {
			const attempts = await this.copyEvidence(guid, evidence);
			if (attempts < 0) return this.requeueDelete(payload, EVIDENCE_BUSY_RETRY_MS);
			if (attempts > 0) {
				return this.requeueDelete(payload, retryDelayMs(attempts), `feed-video-delete:${guid}:e${attempts}`);
			}
		}
		try {
			await this.deps.client.deleteVideo(guid);
		} catch (error) {
			const attempts = await repository.countDeleteAttempt(guid);
			await this.noteFailure(guid, attempts, error, 'Feed video delete still failing');
			return this.requeueDelete(payload, retryDelayMs(attempts), `feed-video-delete:${guid}:d${attempts}`);
		}
		await this.deps.purgeQueue
			.addUrls([`https://${this.deps.settings().cdnHostname}/${guid}/`], {priority: o.priority === true})
			.catch((error) => Logger.warn({guid, error}, 'Queueing a feed video cache purge failed'));
		await repository.clearStuck(guid);
		const removed = await this.locked(guid, async (row) => {
			if (row) await repository.delete(row);
			return true;
		});
		if (removed === BUSY) await this.requeueDelete(payload, LOCK_RETRY_MS);
	}

	/** One keepFeedVideoEvidence job (a report): copies the evidence, rescheduling itself until it is kept. */
	async keepEvidence(guid: string, evidenceKey: string): Promise<'kept' | 'retry'> {
		const attempts = await this.copyEvidence(guid, evidenceKey);
		if (attempts === 0) return 'kept';
		await this.deps.worker.addJob(
			'keepFeedVideoEvidence',
			{guid, evidenceKey},
			attempts < 0
				? {runAt: inMs(EVIDENCE_BUSY_RETRY_MS)}
				: {runAt: inMs(retryDelayMs(attempts)), jobKey: `feed-video-evidence:${guid}:${attempts}`},
		);
		return 'retry';
	}

	/**
	 * Before a report is filed: the post's videos keep their evidence key, so any later delete, a plain one that won the
	 * job key included, copies the evidence first. The key lasts 5 minutes until keepReportedEvidence (`pending`),
	 * then 30 days. A priority removal records its key in FeedPostService.removePost.
	 */
	async markReported(post: FeedPostRow, o: {pending?: boolean} = {}): Promise<void> {
		for (const media of post.media ?? []) {
			if (isStreamMedia(media)) {
				await this.deps.repository.markReported(
					media.stream_video_id!,
					feedStreamEvidenceKey(post.author_id, media),
					o.pending === true,
				);
			}
		}
	}

	/** Once the report is filed (not for a refused one, up to 2 GiB each): the key is kept 30 days, the copy starts. */
	async keepReportedEvidence(post: FeedPostRow): Promise<void> {
		await this.markReported(post);
		for (const media of post.media ?? []) {
			if (!isStreamMedia(media)) continue;
			const guid = media.stream_video_id!;
			const evidenceKey = feedStreamEvidenceKey(post.author_id, media);
			await this.deps.worker.addJob(
				'keepFeedVideoEvidence',
				{guid, evidenceKey},
				{jobKey: `feed-video-evidence:${guid}`},
			);
		}
	}

	/** Account deletion: every video that is not a post yet goes, without a DM (published ones go with the posts). */
	async deleteUserVideos(userId: UserID): Promise<void> {
		let busy = false;
		for (const row of await this.deps.repository.listByAuthor(userId, AUTHOR_READ_LIMIT)) {
			if (IN_FLIGHT.has(row.state) && !(await this.fail(row.video_guid, null))) busy = true;
		}
		if (busy) throw new Error('A feed video of the deleted account is locked; the deletion retries');
	}

	/**
	 * The hourly cron: queues one reconcileFeedVideoBucket job per hour since the cursor (at most 96, the pending TTL),
	 * shard and checkpoint (1, 9, 72 h). Returns the number of jobs.
	 */
	async enqueueReconcile(nowMs = Date.now()): Promise<number> {
		const {repository} = this.deps;
		const token = await repository.lockReconcile();
		if (token === null) return 0;
		try {
			const nowHour = pendingHourAt(nowMs);
			const cursor = await repository.getReconcileCursor();
			if (cursor !== null && nowHour - cursor > RECONCILE_DEFAULT_HOURS) {
				Logger.warn({hours: nowHour - cursor}, 'Feed video reconcile is catching up');
			}
			const from = Math.max(cursor ?? nowHour - RECONCILE_DEFAULT_HOURS, nowHour - RECONCILE_MAX_HOURS) + 1;
			const buckets: Array<{hour: number; shard: number; checkpoint: number}> = [];
			for (let hour = from; hour <= nowHour; hour++) {
				for (const checkpoint of CHECKPOINTS) {
					for (let shard = 0; shard < PENDING_SHARDS; shard++) {
						buckets.push({hour: hour - checkpoint, shard, checkpoint});
					}
				}
			}
			await mapWithConcurrency(buckets, RECONCILE_QUEUE_CONCURRENCY, (bucket) =>
				this.deps.worker.addJob('reconcileFeedVideoBucket', bucket, {
					jobKey: `feed-video-rc:${bucket.hour}:${bucket.shard}:${bucket.checkpoint}`,
				}),
			);
			await repository.setReconcileCursor(nowHour);
			Logger.info(
				{queued: buckets.length, stuck: await repository.countStuck(), goneHalted: await repository.isGoneHalted()},
				'Feed video reconcile queued',
			);
			return buckets.length;
		} finally {
			await repository.unlockReconcile(token);
		}
	}

	/**
	 * One reconcileFeedVideoBucket job: up to 4 pages of 500 pending videos of one (hour, shard) at one checkpoint.
	 * 1 h: re-read what is processing or scanning. 9 h: an upload that never finished fails; a published video gets its
	 * one last upload read from Bunny and leaves both indexes. 72 h: everything unpublished fails; a video published after
	 * 9 h gets its last read. TEMPORARY: 64 fixed shards; path: 256 from new hours; trigger: a bucket job over 60 s
	 * or re-queued more than 5 times, or tombstone warnings on feed_videos_pending. A video that fails here retries on a
	 * job of its own (`guid`), so it neither fails the bucket's other videos nor re-reads them.
	 */
	async reconcileBucket(p: ReconcileBucket): Promise<void> {
		if (p.guid) return this.reconcileVideo(p.guid, p.hour, p.checkpoint);
		let after = p.after ?? null;
		for (let page = 0; page < BUCKET_PAGES; page++) {
			const guids = await this.deps.repository.listPending(p.hour, p.shard, after, BUCKET_PAGE);
			await mapWithConcurrency(guids, BUCKET_CONCURRENCY, async (guid) => {
				try {
					await this.reconcileVideo(guid, p.hour, p.checkpoint);
				} catch (error) {
					Logger.warn({guid, checkpoint: p.checkpoint, error}, 'Reconciling a feed video failed');
					await this.deps.worker.addJob(
						'reconcileFeedVideoBucket',
						{hour: p.hour, shard: p.shard, checkpoint: p.checkpoint, guid},
						{runAt: inMs(LOCK_RETRY_MS), jobKey: `feed-video-rc:${p.hour}:${p.shard}:${p.checkpoint}:${guid}`},
					);
				}
			});
			after = guids.length < BUCKET_PAGE ? null : guids.at(-1)!;
			if (after === null) break;
		}
		if (after !== null) {
			await this.deps.worker.addJob(
				'reconcileFeedVideoBucket',
				{hour: p.hour, shard: p.shard, checkpoint: p.checkpoint, after},
				{jobKey: `feed-video-rc:${p.hour}:${p.shard}:${p.checkpoint}:${after}`},
			);
		}
	}

	private async reconcileVideo(guid: string, hour: number, checkpoint: 1 | 9 | 72): Promise<void> {
		const {repository, client} = this.deps;
		const row = await repository.get(guid);
		if (!row) {
			// The partition hour gives back the pending row's key without the video row.
			await repository.finishPending({video_guid: guid, created_id: createSnowflakeFromTimestamp(hour * HOUR_MS)});
			return;
		}
		// Still pending while deleting: its delete job was never queued (or a removed post's is still retrying).
		if (row.state === 'deleting') return this.queueDelete(guid);
		if (row.state === 'published') {
			if (checkpoint === 1) return;
			await this.checkPublished(row, await client.getVideo(guid), MAX_RECHECKS);
			await repository.finishPending(row);
			await repository.deleteAuthorIndex(row);
			return;
		}
		if (checkpoint === 72) {
			if (!(await this.fail(guid, 'feed.video_failed'))) throw new Error('Feed video lock is taken');
			return;
		}
		if (row.state === 'scanning') {
			// Only a lost scan is queued again: a second chain beside a queued one would scan every attempt twice.
			if (await repository.isScanQueued(guid)) return;
			await this.queueScan(guid, RECONCILE_SCAN_ATTEMPT, {jobKey: `scan:${guid}:rc${checkpoint}`});
			return;
		}
		if (!(await this.advance(row, await client.getVideo(guid), MAX_RECHECKS))) {
			throw new Error('Feed video lock is taken');
		}
		if (checkpoint === 9 && (await repository.get(guid))?.state === 'uploading') {
			if (!(await this.fail(guid, 'feed.video_failed'))) throw new Error('Feed video lock is taken');
		}
	}

	/**
	 * Moves an uploading or processing video on from what Bunny says, and sends one re-uploaded while it is scanned
	 * back to uploading, so the new upload passes the size check too; false when the video lock was taken.
	 */
	private async advance(row: FeedVideoRow, video: BunnyVideo | null, recheck: number): Promise<boolean> {
		const {repository, client} = this.deps;
		const guid = row.video_guid;
		if (row.state === 'published') {
			await this.checkPublished(row, video, recheck);
			return true;
		}
		let state = row.state;
		if (state === 'scanning') {
			if (video === null || uploadOf(video) === rowUpload(row)) return true;
			const reset = await this.locked(guid, async (current) => {
				if (current?.state !== 'scanning' || uploadOf(video) === rowUpload(current)) return false;
				await repository.update(guid, {state: 'uploading'});
				return true;
			});
			if (reset === BUSY) return false;
			if (!reset) return true;
			state = 'uploading';
		}
		if (state !== 'uploading' && state !== 'processing') return true;
		if (video === null || video.status === STATUS_ERROR || video.status === STATUS_UPLOAD_FAILED) {
			return this.fail(guid, 'feed.video_failed');
		}
		let files: Array<BunnyStorageEntry> | null = null;
		if (state === 'uploading') {
			if (video.status < STATUS_UPLOADED) return true;
			// the one exact size check, while Bunny may still list the original (KeepOriginalFiles is off).
			files = await client.listFiles(guid);
			const original = listed(files, 'original');
			const moved = await this.locked(guid, async (current) => {
				if (current?.state !== 'uploading') return 'stale';
				if (original && original.length > FEED_VIDEO_MAX_BYTES) {
					await this.markDeleting(current);
					return 'too_large';
				}
				if (!original) Logger.warn({guid}, 'Feed video original was not listed at the first webhook');
				await repository.update(guid, {
					state: 'processing',
					...(original ? {declared_size: BigInt(original.length)} : {}),
				});
				return 'processing';
			});
			if (moved === BUSY) return false;
			if (moved === 'too_large') await this.afterDeleting(row, 'feed.video_too_large');
			if (moved !== 'processing') return true;
		}
		if (video.status !== STATUS_FINISHED) return true;
		files ??= await client.listFiles(guid);
		if (!listed(files, 'playlist.m3u8')) {
			// Finished but not listed yet: read again in 15 minutes.
			if (recheck < MAX_RECHECKS) await this.queueRecheck(guid, recheck + 1);
			return true;
		}
		const scanStartedAt = new Date();
		const scanning = await this.locked(guid, async (current) => {
			if (current?.state !== 'processing') return false;
			// The upload being scanned: a webhook that finds another one while scanning starts over.
			await repository.update(guid, {
				state: 'scanning',
				scan_started_at: scanStartedAt,
				uploaded_at: video.dateUploaded,
				original_hash: video.originalHash,
			});
			return true;
		});
		if (scanning === BUSY) return false;
		// A lost hand-off here leaves the video scanning; the 1 h and 9 h checkpoints queue its scan again. Keyed by the
		// scan start, so the first scan of a re-upload is not a duplicate of the earlier upload's (Yeni-3).
		if (scanning) await this.queueScan(guid, 0, {jobKey: `scan:${guid}:${scanStartedAt.getTime()}:0`});
		return true;
	}

	/**
	 * a published video whose upload changed or that Bunny tags adult loses its post (no hidden middle state). A
	 * video Bunny no longer has takes its post too, as an unplayable post would stay forever; its author is told. That
	 * removal cannot be undone, so the API's 404 needs an empty storage listing as well, and past 20 in an hour such
	 * removals halt until an operator deletes feed:video:gone:halt, each kept post logging an error: a library ID, key
	 * or zone pointed elsewhere answers 404 for every video. The halt keeps the hour's count: a halt
	 * deleted within its hour comes back at the hour's next gone video, unless feed:video:gone:<hour> goes with it.
	 */
	private async checkPublished(row: FeedVideoRow, video: BunnyVideo | null, recheck: number): Promise<void> {
		if (video === null) {
			const guid = row.video_guid;
			if ((await this.deps.client.listFiles(guid))?.length) {
				Logger.warn(
					{guid},
					'Bunny Stream does not find a published feed video its storage still lists; keeping the post',
				);
				return;
			}
			const post = row.post_id != null ? await this.deps.feedRepository.getPost(row.post_id) : null;
			if (!post) return;
			const {repository} = this.deps;
			if (await repository.isGoneHalted()) {
				Logger.error({guid}, 'Removing the posts of feed videos gone from Bunny is halted; keeping the post');
				return;
			}
			const hour = pendingHourAt(Date.now());
			const gone = await repository.countGone(hour);
			if (gone > GONE_MAX_PER_HOUR) {
				await repository.haltGone();
				Logger.error(
					{guid, gone},
					'Too many published feed videos are gone from Bunny this hour; removing their posts is halted until feed:video:gone:halt is deleted',
				);
				return;
			}
			// A check running beside this one may have halted after the first read; read it again last.
			if (await repository.isGoneHalted()) {
				Logger.error({guid}, 'Removing the posts of feed videos gone from Bunny is halted; keeping the post');
				return;
			}
			Logger.warn({guid}, 'The Bunny video of a published feed post is gone; removing the post');
			await this.deps.posts.removePost(post, {});
			await this.notify(row.author_id, 'feed.video_gone');
			return;
		}
		if (uploadOf(video) !== rowUpload(row) || isAdultCategory(video.category)) {
			const post = row.post_id != null ? await this.deps.feedRepository.getPost(row.post_id) : null;
			if (!post) return;
			// The priority removal records the evidence key itself.
			await this.deps.posts.removePost(post, {priority: true});
			await this.notify(row.author_id, 'feed.video_rejected');
			return;
		}
		if (video.status !== STATUS_FINISHED && recheck < MAX_RECHECKS)
			await this.queueRecheck(row.video_guid, recheck + 1);
	}

	private async runScan(row: FeedVideoRow, attempt: number): Promise<ScanOutcome> {
		const {client, repository, scanner} = this.deps;
		const guid = row.video_guid;
		const video = await client.getVideo(guid);
		if (video === null) return {kind: 'gone'};
		const files = await client.listFiles(guid);
		// the HLS playlist is what the post plays; no original, no MP4 needed.
		if (video.status !== STATUS_FINISHED || !files || !listed(files, 'playlist.m3u8')) return {kind: 'inconclusive'};
		const category = video.category?.toLowerCase() ?? '';
		const taggingPending = category === '' || category === 'untagged';
		const scanStart = (row.scan_started_at ?? row.updated_at).getTime();
		const taggingDeadline = scanStart + TAGGING_GRACE_MS;
		if (taggingPending && Date.now() < taggingDeadline) {
			// Content Tagging has not answered yet: no frame is read before its 30 minutes are up. The wait runs as the
			// next attempt, so this attempt's scan claim (5 min) cannot swallow it; claim and key are per scan (Yeni-3).
			const phase = `${guid}:${scanStart}`;
			if (await repository.claimTagWait(phase)) {
				await this.queueScan(guid, attempt + 1, {runAt: new Date(taggingDeadline), jobKey: `scan:${phase}:tag`});
			}
			return {kind: 'wait'};
		}
		// A clean scan of this very upload that found the lock taken posts without reading its frames again.
		if (!isAdultCategory(video.category) && (await repository.getClean(guid)) === uploadOf(video)) {
			return {kind: 'clean', video, files};
		}
		const result = await scanner.scan(video, files, {taggingPending});
		return result.verdict === 'inconclusive' ? {kind: 'inconclusive'} : {kind: result.verdict, video, files};
	}

	/**
	 * Publishes a clean video under the lock, only while its row is still scanning and Bunny still holds the upload
	 * that was scanned; the post ID is written first. The author is the scan's read, its flags checked again as
	 * they are now: feature_feed or feature_feed_video at 0 holds the post back.
	 */
	private async publish(
		scanned: FeedVideoRow,
		author: User,
		attempt: number,
		video: BunnyVideo,
		files: Array<BunnyStorageEntry>,
		retryDelay: number,
	): Promise<void> {
		const {repository, feedRepository, posts, client} = this.deps;
		const guid = scanned.video_guid;
		const current = await client.getVideo(guid);
		if (current === null || uploadOf(current) !== uploadOf(video)) {
			return this.retryScan(scanned, attempt + 1, retryDelay);
		}
		if (isAdultCategory(current.category)) return this.failFromScan(scanned, attempt, 'feed.video_rejected');
		const outcome = await this.locked(guid, async (row) => {
			// A cancel, a failure or a delete won the race: nothing is published and the row is not written again.
			if (row?.state !== 'scanning') return 'gone';
			if (this.holdsPost(author)) return 'held';
			let postId = row.post_id;
			if (postId == null) {
				postId = await this.deps.snowflake.generate();
				await repository.update(guid, {post_id: postId});
			}
			const display = displaySize(video);
			const duration = Math.round(video.length);
			const mp4File = pickMp4(files);
			if (!(await feedRepository.getPost(postId))) {
				// no original is kept; the media names the evidence file, the HLS rendition joined into MPEG-TS.
				const media: FeedMedia = {
					attachment_id: row.created_id,
					filename: 'evidence.ts',
					size: row.declared_size,
					description: null,
					width: display.width,
					height: display.height,
					content_type: 'video/mp2t',
					content_hash: null,
					placeholder: null,
					flags: 0,
					nsfw: false,
					duration,
					stream_video_id: guid,
					stream_mp4_file: mp4File,
				};
				const post: FeedPostRow = {
					post_id: postId,
					author_id: row.author_id,
					content: row.content,
					media: [media],
					edited_at: null,
					flags: row.flags,
					like_count: 0,
					comment_count: 0,
				};
				await posts.publishPost(author, post, await feedRepository.countPostsToday(author.id, feedDay(postId)));
			}
			// The pending and author index rows stay until the 9 h (or 72 h) checkpoint's last upload read.
			await repository.update(guid, {
				state: 'published',
				content: null,
				uploaded_at: video.dateUploaded,
				original_hash: video.originalHash,
				mp4_file: mp4File,
				width: display.width,
				height: display.height,
				duration,
			});
			return 'published';
		});
		if (outcome === 'held') {
			// the flag holds the post, not the scan: the same attempt in 15 min, without reading the frames again.
			await repository.markClean(guid, uploadOf(video));
			return this.retryScan(scanned, attempt, HELD_RETRY_MS);
		}
		if (outcome === BUSY) {
			await repository.markClean(guid, uploadOf(video));
			return this.retryScan(scanned, attempt + 1, LOCK_RETRY_MS);
		}
	}

	private async failFromScan(row: FeedVideoRow, attempt: number, key: FeedVideoDmKey | null): Promise<void> {
		if (!(await this.fail(row.video_guid, key))) await this.retryScan(row, attempt + 1, LOCK_RETRY_MS);
	}

	/** An unpublished video goes: deleting under the lock, its indexes dropped, then the delete job and the DM. */
	private async fail(guid: string, key: FeedVideoDmKey | null): Promise<boolean> {
		const row = await this.locked(guid, async (current) => {
			if (!current || !IN_FLIGHT.has(current.state)) return null;
			await this.markDeleting(current);
			return current;
		});
		if (row === BUSY) return false;
		if (row) await this.afterDeleting(row, key);
		return true;
	}

	// Under the lock. The text goes with the state, so a stuck delete keeps no post text.
	private async markDeleting(row: FeedVideoRow): Promise<void> {
		await this.deps.repository.update(row.video_guid, {state: 'deleting', content: null});
	}

	// After the lock. The index rows go only once the delete job is queued: a failed hand-off leaves the pending row,
	// and the next reconcile checkpoint queues the delete again.
	private async afterDeleting(row: FeedVideoRow, key: FeedVideoDmKey | null): Promise<void> {
		if (key) await this.notify(row.author_id, key);
		await this.queueDelete(row.video_guid);
		await this.deps.repository.finishPending(row);
		await this.deps.repository.deleteAuthorIndex(row);
	}

	private async queueDelete(guid: string): Promise<void> {
		await this.deps.worker.addJob('deleteFeedVideo', {guid}, {jobKey: `feed-video-delete:${guid}`});
	}

	private async requeueDelete(payload: Record<string, unknown>, delayMs: number, jobKey?: string): Promise<void> {
		await this.deps.worker.addJob('deleteFeedVideo', payload, {runAt: inMs(delayMs), ...(jobKey ? {jobKey} : {})});
	}

	// Keyed by the scan start like the first scan, so a re-upload's retry is no duplicate of the earlier upload's.
	private async retryScan(row: FeedVideoRow, attempt: number, delayMs: number): Promise<void> {
		const guid = row.video_guid;
		await this.queueScan(guid, attempt, {
			runAt: inMs(delayMs),
			jobKey: `scan:${guid}:${row.scan_started_at?.getTime() ?? 0}:${attempt}`,
		});
	}

	// Every scan job goes through here, so reconciliation knows one is on its way.
	private async queueScan(guid: string, attempt: number, o: {runAt?: Date; jobKey: string}): Promise<void> {
		await this.deps.worker.addJob('scanFeedVideo', {guid, attempt}, o);
		await this.deps.repository.markScanQueued(guid, o.runAt ? o.runAt.getTime() - Date.now() : 0);
	}

	/** fails the author's videos still in flight past the 72 h checkpoint and returns the rest. */
	private async failStale(rows: Array<FeedVideoRow>): Promise<Array<FeedVideoRow>> {
		const fresh: Array<FeedVideoRow> = [];
		for (const row of rows) {
			if (!IN_FLIGHT.has(row.state) || Date.now() - snowflakeToDate(row.created_id).getTime() <= STALE_IN_FLIGHT_MS) {
				fresh.push(row);
				continue;
			}
			Logger.warn({guid: row.video_guid}, 'Failing a feed video the reconcile checkpoints missed');
			await this.fail(row.video_guid, 'feed.video_failed');
		}
		return fresh;
	}

	private async queueRecheck(guid: string, recheck: number): Promise<void> {
		await this.deps.worker.addJob(
			'processFeedVideoWebhook',
			{guid, recheck},
			{runAt: inMs(RECHECK_MS), jobKey: `${guid}:recheck:${recheck}`},
		);
	}

	// A DM that cannot be queued is logged, never retried: the video's state has already moved on.
	private async notify(authorId: UserID, key: FeedVideoDmKey): Promise<void> {
		await this.deps
			.notifyAuthor(authorId, key)
			.catch((error) => Logger.warn({authorId: authorId.toString(), key, error}, 'Queueing a feed video DM failed'));
	}

	private async noteFailure(guid: string, attempts: number, error: unknown, stillFailing: string): Promise<void> {
		if (attempts === STUCK_AFTER) {
			await this.deps.repository.markStuck(guid);
			Logger.error({guid, attempts, error}, 'Feed video is stuck: retrying once a day');
		} else if (attempts > STUCK_AFTER) {
			Logger.warn({guid, attempts}, stillFailing);
		}
	}

	/**
	 * Joins the HLS segments of the largest rendition within 2 GiB, in playlist order, into one MPEG-TS object in the
	 * reports bucket. Returns 0 when the evidence is kept, -1 when another job holds the evidence lock and
	 * the failure count otherwise. The copy is one sequential stream: the worker extends the job's ack deadline while
	 * it runs (WorkerRunner.startAckHeartbeat), so ackWait bounds only a crashed worker's redelivery; a copy past the
	 * 10 min evidence lock may overlap a retry, which writes the same bytes to the same key. TEMPORARY: path: a
	 * resumable multipart copy (listParts as the cursor) on its own evidence lane; trigger: evidence jobs over 5 min or
	 * feed:video:stuck not empty.
	 */
	private async copyEvidence(guid: string, key: string): Promise<number> {
		const {repository, storage} = this.deps;
		const token = await repository.lockEvidence(guid);
		if (token === null) return -1;
		try {
			const bucket = Config.s3.buckets.reports;
			if (await storage.getObjectMetadata(bucket, key)) return 0;
			await this.joinSegments(guid, bucket, key);
			return 0;
		} catch (error) {
			const attempts = await repository.countEvidenceAttempt(guid);
			Logger.warn({guid, attempts, error}, 'Copying feed video evidence failed');
			await this.noteFailure(guid, attempts, error, 'Feed video evidence copy still failing');
			return attempts;
		} finally {
			await repository.unlockEvidence(guid, token);
		}
	}

	private async joinSegments(guid: string, bucket: string, key: string): Promise<void> {
		const {client, storage} = this.deps;
		const master = await client.readFile(guid, 'playlist.m3u8', MASTER_PLAYLIST_MAX_BYTES);
		if (!master) throw new Error('The HLS playlist is missing');
		const variants = parseMasterPlaylist(master.toString('utf8')).sort((a, b) => b.pixels - a.pixels);
		let chosen: {path: string; sizes: Map<string, number>} | null = null;
		for (const variant of variants) {
			const listing = await client.listFiles(guid, variant.path);
			if (!listing) throw new Error('An HLS rendition is missing');
			const sizes = new Map(
				listing
					.filter((file) => !file.isDirectory && file.name.endsWith('.ts'))
					.map((file) => [file.name, file.length]),
			);
			chosen = {path: variant.path, sizes};
			if ([...sizes.values()].reduce((sum, size) => sum + size, 0) <= FEED_VIDEO_EVIDENCE_MAX_BYTES) break;
			if (variant === variants.at(-1))
				Logger.warn({guid}, 'Every feed video rendition is over 2 GiB; keeping the smallest');
		}
		const media = await client.readFile(guid, `${chosen!.path}/video.m3u8`, MEDIA_PLAYLIST_MAX_BYTES);
		if (!media) throw new Error('The HLS rendition playlist is missing');
		const segments = parseMediaPlaylist(media.toString('utf8'));
		const body = new PassThrough();
		const upload = storage.uploadObject({bucket, key, body, contentType: 'video/mp2t'}).catch((error: unknown) => {
			body.destroy(error as Error);
			throw error;
		});
		await Promise.all([upload, this.pumpSegments(guid, chosen!, segments, body)]);
	}

	// One segment at a time, in playlist order; a missing, failed or short segment fails the whole copy.
	private async pumpSegments(
		guid: string,
		rendition: {path: string; sizes: Map<string, number>},
		segments: Array<string>,
		body: PassThrough,
	): Promise<void> {
		try {
			for (const segment of segments) {
				const file = await this.deps.client.streamFile(guid, `${rendition.path}/${segment}`);
				if (!file) throw new Error('An HLS segment is missing');
				let bytes = 0;
				for await (const chunk of file.body) {
					bytes += chunk.byteLength;
					if (!body.write(chunk)) await once(body, 'drain');
				}
				const expected = rendition.sizes.get(segment);
				if (expected !== undefined && bytes !== expected) throw new Error('An HLS segment was cut short');
			}
			body.end();
		} catch (error) {
			body.destroy(error as Error);
			throw error;
		}
	}

	private ticket(guid: string): FeedVideoUploadResponse {
		const settings = this.deps.settings();
		const expires = Math.floor(Date.now() / 1000) + UPLOAD_SIGNATURE_SECONDS;
		return {
			id: guid,
			library_id: String(settings.libraryId),
			upload: {endpoint: settings.tusEndpoint, signature: signTusUpload(settings, guid, expires), expires},
		};
	}

	/** Runs `fn` with the row re-read under the video lock (K9a); BUSY when another holder has it. */
	private async locked<T>(guid: string, fn: (row: FeedVideoRow | null) => Promise<T>): Promise<T | typeof BUSY> {
		const {repository} = this.deps;
		const token = await repository.lockVideo(guid);
		if (token === null) return BUSY;
		try {
			return await fn(await repository.get(guid));
		} finally {
			await repository.unlockVideo(guid, token);
		}
	}

	/** The feed's kill switch or the video flag at 0 holds a video on its way; neither deletes it (ORTA-2). */
	private holdsPost(author: User): boolean {
		return this.resolveLimit(author, 'feature_feed') === 0 || this.resolveLimit(author, 'feature_feed_video') === 0;
	}

	private resolveLimit(user: User, key: LimitKey): number {
		return resolveLimitSafe(
			this.deps.limits.getConfigSnapshot(),
			createLimitMatchContext({user}),
			key,
			DEFAULT_FREE_LIMITS[key],
		);
	}
}
