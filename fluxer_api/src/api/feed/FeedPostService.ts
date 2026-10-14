// SPDX-License-Identifier: AGPL-3.0-or-later

import {makeDataPackageAttachmentCdnUrl} from '@app/api/attachment/AttachmentUrls';
import {type UserID, userIdToChannelId} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {AttachmentUploadTraceRepository} from '@app/api/channel/repositories/message/AttachmentUploadTraceRepository';
import {type FeedMedia, FeedPostFlags, type FeedPostRow, isPublicFeedPost} from '@app/api/database/types/FeedTypes';
import type {FeedTrendService} from '@app/api/feed/discover/FeedTrendService';
import {feedInviteBases, findFeedLinkPreviewTarget} from '@app/api/feed/FeedLinkPreview';
import {FeedMediaService} from '@app/api/feed/FeedMediaService';
import {type FeedRepository, feedDay, feedDayStart} from '@app/api/feed/FeedRepository';
import {isHiddenFeedAuthor} from '@app/api/feed/FeedTimelineService';
import type {FeedInteractionRepository} from '@app/api/feed/interaction/FeedInteractionRepository';
import {pollColumnsFor} from '@app/api/feed/interaction/FeedPollService';
import type {FeedVideoRepository} from '@app/api/feed/video/FeedVideoRepository';
import {feedStreamEvidenceKey, isStreamMedia, streamPlaylistUrl} from '@app/api/feed/video/FeedVideoUrls';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import type {FollowRepository} from '@app/api/follow/FollowRepository';
import type {IPurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {contentModerationService} from '@app/api/infrastructure/ContentModerationService';
import type {IMediaService} from '@app/api/infrastructure/IMediaService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {User} from '@app/api/models/User';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {CannotSendEmptyMessageError} from '@fluxer/errors/src/domains/channel/CannotSendEmptyMessageError';
import {UnknownFeedPostError} from '@fluxer/errors/src/domains/content/UnknownFeedPostError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {DEFAULT_RESTRICTED_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import type {FeedPollCreateRequest} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import type {ClientUploadedAttachmentRequest} from '@fluxer/schema/src/domains/message/AttachmentSchemas';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import type {IVirusScanService} from '@pkgs/virus_scan/src/IVirusScanService';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

// Followers written per fanoutFeedPost job; each job queues the next page.
export const FEED_FANOUT_PAGE_SIZE = 500;
const DELETION_PAGE_SIZE = 500;
const DELETION_CONCURRENCY = 16;
// The data export archive lives 7 days (HarvestUserData ZIP_EXPIRY_MS), and so does a video's signed playlist URL in it.
const EXPORT_VIDEO_URL_SECONDS = 7 * 24 * 3600;

interface FeedPostServiceDeps {
	repository: FeedRepository;
	followRepository: FollowRepository;
	userRepository: UserRepository;
	kvCounterService: KVCounterService;
	workerService: IWorkerService<WorkerTaskName>;
	snowflakeService: ISnowflakeService;
	limitConfigService: LimitConfigService;
	storageService: IStorageService;
	mediaService: IMediaService;
	virusScanService: IVirusScanService;
	attachmentUploadTraceRepository: AttachmentUploadTraceRepository;
	purgeQueue: IPurgeQueue;
	interactionRepository: FeedInteractionRepository;
	trendService: FeedTrendService;
	videoRepository: Pick<FeedVideoRepository, 'markReported'>;
}

// The write side of the feed. The request path writes only the post (post row, author index, bucket list, KV state);
// followers get it from the fanoutFeedPost jobs on the feed lane, or pull it at read time when the author is above
// feed_fanout_max_followers (hybrid fan-out). Access (feature_feed, profile rule) is checked by the controller.
export class FeedPostService {
	readonly media: FeedMediaService;
	readonly trend: FeedTrendService;

	constructor(readonly deps: FeedPostServiceDeps) {
		this.media = new FeedMediaService(deps);
		this.trend = deps.trendService;
	}

	/** The feature_feed kill switch: 0 closes every feed route and stops the fan-out jobs. */
	isFeedEnabled(user: User): boolean {
		return this.resolveLimit(user, 'feature_feed') !== 0;
	}

	async createPost(params: {
		user: User;
		content?: string | null;
		attachments?: Array<ClientUploadedAttachmentRequest>;
		isPublic?: boolean;
		poll?: FeedPollCreateRequest;
	}): Promise<FeedPostRow> {
		const {user, poll} = params;
		const {repository} = this.deps;
		const content = params.content ?? null;
		const attachments = params.attachments ?? [];
		// A poll's question is the text; a poll carries no images or video.
		if (poll && attachments.length > 0) {
			throw InputValidationError.fromCode('poll', ValidationErrorCodes.INVALID_FORMAT);
		}
		if (!content && (poll || attachments.length === 0)) {
			throw new CannotSendEmptyMessageError();
		}
		for (const text of [content, poll?.options.join('\n')]) scanFeedText(user.id, text);
		const postId = await this.deps.snowflakeService.generate();
		const pollColumns = poll ? pollColumnsFor(postId, poll) : {};
		const day = feedDay(postId);
		const maxPerDay = this.resolveLimit(user, 'max_feed_posts_per_day');
		if ((await repository.countPostsToday(user.id, day)) >= maxPerDay) {
			throw dailyLimitError(maxPerDay, day);
		}
		const media = attachments.length > 0 ? await this.media.processPostMedia({user, postId, attachments}) : [];
		const postedToday = await repository.addPostToday(user.id, day);
		if (postedToday > maxPerDay) {
			await this.media.deleteMedia(user.id, media, {purge: false});
			throw dailyLimitError(maxPerDay, day);
		}
		const post: FeedPostRow = {
			post_id: postId,
			author_id: user.id,
			content,
			media: media.length > 0 ? media : null,
			edited_at: null,
			flags: params.isPublic ? FeedPostFlags.PUBLIC : 0,
			like_count: 0,
			comment_count: 0,
			...pollColumns,
		};
		await this.publishPost(user, post, postedToday);
		return post;
	}

	/**
	 * Writes a checked post and hands it out: the row, the author's last post, the link preview, Keşfet and the home
	 * feeds. `postedToday` is the author's count for the post's feed day, this post included. A Bunny video post comes
	 * here from its scan once the video is clean, so nothing reads it before.
	 */
	async publishPost(author: User, post: FeedPostRow, postedToday: number): Promise<void> {
		const {repository} = this.deps;
		const postId = post.post_id;
		await repository.createPost(post);
		await repository.setLastPost(author.id, postId);
		// The one link preview is resolved on the unfurl lane; a failed hand-off leaves the post without one.
		if (findFeedLinkPreviewTarget(post.content ?? null, feedInviteBases())) {
			await this.deps.workerService
				.addJob('extractFeedPostEmbeds', {postId: postId.toString()}, {jobKey: `feed-embeds:${postId}`})
				.catch((error) => Logger.warn({error, postId: postId.toString()}, 'Queueing a feed link preview failed'));
		}
		await this.trend.recordPostCreated(author, post);
		// Past feed_fanout_max_posts_per_day a post stays on the profile only. A failed hand-off never fails the post.
		if (postedToday <= this.resolveLimit(author, 'feed_fanout_max_posts_per_day')) {
			await this.distribute(author, postId).catch((error) =>
				Logger.warn({error, postId: postId.toString()}, 'Handing a feed post to the home feeds failed'),
			);
		}
	}

	async deletePost(userId: UserID, postId: bigint): Promise<void> {
		const post = await this.deps.repository.getPost(postId);
		if (!post) {
			throw new UnknownFeedPostError();
		}
		if (post.author_id !== userId) {
			throw new MissingPermissionsError();
		}
		await this.removePost(post);
	}

	/**
	 * Removes a post for its author, a moderator or account deletion: the images and their CDN copies first, then
	 * its likes and comments, the rows last, so a retry after a failure still finds the post. Home feeds drop it on read.
	 * Moderator and NCMEC removals pass priority, so the CDN copies go first. Keşfet drops it too, unless the caller
	 * (account deletion) already evicted the whole author. A Bunny video goes on the video lane, which keeps its
	 * evidence first when priority says a moderator removed it. The evidence key is recorded here, the one place, before the job, so a plain delete that took the job key (account deletion) keeps the evidence too. A
	 * failed record fails the removal before anything is deleted, for its caller to retry: the job carrying the key would
	 * be dropped as a duplicate of a plain delete already queued under the same key.
	 */
	async removePost(post: FeedPostRow, options: {priority?: boolean; discoverEvict?: boolean} = {}): Promise<void> {
		const media = post.media ?? [];
		for (const item of media.filter(isStreamMedia)) {
			const guid = item.stream_video_id!;
			const evidence = options.priority ? feedStreamEvidenceKey(post.author_id, item) : null;
			if (evidence) {
				await this.deps.videoRepository.markReported(guid, evidence).catch((error: unknown) => {
					Logger.error({guid, error}, 'Recording a feed video evidence key failed; the removal stops for a retry');
					throw error;
				});
			}
			await this.deps.workerService.addJob(
				'deleteFeedVideo',
				{guid, ...(evidence ? {priority: true, evidence} : {})},
				{jobKey: `feed-video-delete:${guid}`},
			);
		}
		// deleteMedia leaves the Bunny videos to the jobs above.
		await this.media.deleteMedia(post.author_id, media, {purge: true, priority: options.priority});
		await this.deps.interactionRepository.deletePostInteractions(post.post_id, {poll: post.poll_options != null});
		await this.deps.repository.deletePost(post);
		if (options.discoverEvict !== false) await this.trend.evictPost(post);
	}

	/** NCMEC removal of a reported post by ID; nothing when it is already gone. */
	async removePostById(postId: bigint, options: {priority?: boolean} = {}): Promise<void> {
		const post = await this.deps.repository.getPost(postId);
		if (post) await this.removePost(post, options);
	}

	/** One fanoutFeedPost job: writes one page of followers' home feeds and queues the next page. */
	async fanoutPage(params: {postId: bigint; authorId: UserID; before?: bigint}): Promise<void> {
		const {postId, authorId, before} = params;
		const {repository, followRepository, userRepository} = this.deps;
		const [post, author] = await Promise.all([repository.getPost(postId), userRepository.findUnique(authorId)]);
		// A deleted post, a deleted or disabled author or feature_feed at 0 ends the chain.
		if (!post || !author || isHiddenFeedAuthor(author) || !this.isFeedEnabled(author)) return;
		const page = await followRepository.listFollowers(authorId, {before, limit: FEED_FANOUT_PAGE_SIZE});
		if (page.length === 0) return;
		await repository.addToHomes(
			page.map((row) => row.user_id),
			postId,
			authorId,
		);
		await this.queueFanout(postId, authorId, page.at(-1)!.follow_id);
	}

	/**
	 * Account deletion (lifecycle lane, retried until done): every post with its images, then the author's indexes. One
	 * author eviction takes all of them off Keşfet.
	 */
	async deleteUserPosts(userId: UserID): Promise<void> {
		const {repository} = this.deps;
		await this.trend.evictAuthor(userId);
		for (;;) {
			const ids = await repository.listAuthorPostIds(userId, {limit: DELETION_PAGE_SIZE});
			if (ids.length === 0) break;
			const posts = await repository.getPosts(ids);
			await mapWithConcurrency(ids, DELETION_CONCURRENCY, async (postId) => {
				const post = posts.get(postId);
				await (post ? this.removePost(post, {discoverEvict: false}) : repository.deleteAuthorIndexRow(userId, postId));
			});
		}
		await repository.deleteAuthorData(userId);
	}

	async exportUserPosts(userId: UserID): Promise<{posts: Array<Record<string, unknown>>}> {
		const {repository} = this.deps;
		const posts: Array<Record<string, unknown>> = [];
		let before: bigint | undefined;
		for (;;) {
			const ids = await repository.listAuthorPostIds(userId, {before, limit: DELETION_PAGE_SIZE});
			if (ids.length === 0) return {posts};
			const rows = await repository.getPosts(ids);
			for (const postId of ids) {
				const row = rows.get(postId);
				if (row) posts.push(exportPost(row));
			}
			before = ids.at(-1);
		}
	}

	// Hybrid fan-out with hysteresis: an author goes pulled above feed_fanout_max_followers and back to written home
	// feeds only below feed_fanout_min_followers, so a count around the limit does not flip every post.
	private async distribute(author: User, postId: bigint): Promise<void> {
		const {repository, kvCounterService} = this.deps;
		const [followers, recent] = await Promise.all([
			kvCounterService.get(FOLLOWER_COUNT_COUNTER, author.id.toString()),
			repository.getCelebrityRecent(author.id),
		]);
		const pulled =
			recent !== null
				? followers >= this.resolveLimit(author, 'feed_fanout_min_followers')
				: followers > this.resolveLimit(author, 'feed_fanout_max_followers');
		if (pulled) {
			await repository.addCelebrityPost(author.id, postId, recent);
			return;
		}
		if (recent !== null) {
			await repository.removeCelebrity(author.id);
		}
		await this.queueFanout(postId, author.id);
	}

	private async queueFanout(postId: bigint, authorId: UserID, before?: bigint): Promise<void> {
		await this.deps.workerService.addJob(
			'fanoutFeedPost',
			{postId: postId.toString(), authorId: authorId.toString(), ...(before ? {before: before.toString()} : {})},
			{jobKey: `feed-fanout:${postId}:${before ?? 'start'}`},
		);
	}

	private resolveLimit(user: User, key: LimitKey): number {
		return resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user}),
			key,
			DEFAULT_RESTRICTED_LIMITS[key],
		);
	}
}

/** A feed text (post, poll, video post) through the content filter, as a message's. */
export function scanFeedText(userId: UserID, text: string | null | undefined): void {
	contentModerationService.scanText(text, {
		userId,
		guildId: null,
		channelId: null,
		messageId: null,
		surface: 'message_content',
	});
}

// max_feed_posts_per_day is a daily allowance, so it answers like a rate limit that resets with the next feed day.
export function dailyLimitError(limit: number, day: number): RateLimitError {
	const resetTime = feedDayStart(day + 1);
	return new RateLimitError({
		retryAfter: Math.ceil((resetTime.getTime() - Date.now()) / 1000),
		limit,
		resetTime,
		scope: 'user',
	});
}

function exportPost(row: FeedPostRow): Record<string, unknown> {
	const channelId = userIdToChannelId(row.author_id);
	return {
		id: row.post_id.toString(),
		content: row.content,
		created_at: snowflakeToDate(row.post_id).toISOString(),
		edited_at: row.edited_at?.toISOString() ?? null,
		public: isPublicFeedPost(row),
		...(row.poll_options && row.poll_expires_at
			? {poll: {options: row.poll_options, expires_at: row.poll_expires_at.toISOString()}}
			: {}),
		attachments: (row.media ?? []).map((media) =>
			isStreamMedia(media)
				? exportStreamVideo(media)
				: {
						id: media.attachment_id.toString(),
						filename: media.filename,
						content_type: media.content_type,
						size: Number(media.size),
						url: makeDataPackageAttachmentCdnUrl(channelId, media.attachment_id, media.filename),
					},
		),
	};
}

// A Bunny video keeps no original, so the export links its HLS playlist, signed for the 7 days the archive lives:
// it plays as is and `ffmpeg -i <url>` saves it. Without Bunny Stream settings there is no unsigned fallback, only null.
function exportStreamVideo(media: FeedMedia): Record<string, unknown> {
	const settings = Config.bunnyStream;
	return {
		id: media.attachment_id.toString(),
		filename: 'playlist.m3u8',
		content_type: 'application/vnd.apple.mpegurl',
		size: null,
		url: settings.enabled
			? streamPlaylistUrl(settings, media.stream_video_id!, Math.floor(Date.now() / 1000) + EXPORT_VIDEO_URL_SECONDS)
			: null,
	};
}
