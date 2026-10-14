// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import {makeSignedAttachmentCdnUrl} from '@app/api/attachment/AttachmentUrls';
import {createAttachmentID, type UserID, userIdToChannelId} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {AttachmentUploadTraceRepository} from '@app/api/channel/repositories/message/AttachmentUploadTraceRepository';
import {
	assertAttachmentFileSizesWithinLimit,
	getContentType,
	makeAttachmentCdnKey,
	makeAttachmentCdnUrl,
	validateAttachmentIds,
} from '@app/api/channel/services/message/MessageHelpers';
import {applyUploadRelayDecision, resolveUploadRelayDecision} from '@app/api/channel/services/UploadRelay';
import type {FeedMedia} from '@app/api/database/types/FeedTypes';
import {isStreamMedia} from '@app/api/feed/video/FeedVideoUrls';
import {type IPurgeQueue, priorityPurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {contentModerationService} from '@app/api/infrastructure/ContentModerationService';
import type {IMediaService} from '@app/api/infrastructure/IMediaService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {User} from '@app/api/models/User';
import {MessageAttachmentFlags} from '@fluxer/constants/src/ChannelConstants';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import {ATTACHMENT_MAX_SIZE_NON_PREMIUM} from '@fluxer/constants/src/LimitConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ContentBlockedError} from '@fluxer/errors/src/domains/content/ContentBlockedError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {FileSizeTooLargeError} from '@fluxer/errors/src/domains/core/FileSizeTooLargeError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MediaMetadataError} from '@fluxer/errors/src/domains/core/MediaMetadataError';
import type {ClientUploadedAttachmentRequest} from '@fluxer/schema/src/domains/message/AttachmentSchemas';
import type {
	PresignedAttachmentUploadRequestItem,
	PresignedAttachmentUploadResponseItem,
} from '@fluxer/schema/src/domains/message/AttachmentUploadSchemas';
import type {MessageAttachmentResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import type {IVirusScanService} from '@pkgs/virus_scan/src/IVirusScanService';
import {temporaryFile} from 'tempy';

// Types the media proxy sniffs from the bytes. No SVG, plain files or video here: a video goes through Bunny Stream.
const FEED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const FEED_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
// The names the retired media proxy video path took: 403 while feature_feed_video is 0, as it always answered.
const LEGACY_VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

export function mapFeedMediaToResponse(authorId: UserID, media: FeedMedia): MessageAttachmentResponse {
	const url = makeSignedAttachmentCdnUrl(userIdToChannelId(authorId), media.attachment_id, media.filename);
	return {
		id: media.attachment_id.toString(),
		filename: media.filename,
		description: media.description,
		content_type: media.content_type,
		content_hash: media.content_hash,
		size: Number(media.size),
		url,
		proxy_url: url,
		width: media.width,
		height: media.height,
		placeholder: media.placeholder,
		flags: media.flags,
		nsfw: media.nsfw,
		duration: media.duration ?? null,
	};
}

interface FeedMediaServiceDeps {
	storageService: IStorageService;
	mediaService: IMediaService;
	virusScanService: IVirusScanService;
	attachmentUploadTraceRepository: AttachmentUploadTraceRepository;
	snowflakeService: ISnowflakeService;
	purgeQueue: IPurgeQueue;
	limitConfigService: LimitConfigService;
}

// Post images take the message attachment path: presigned upload into the uploads bucket with an upload trace, the
// media proxy metadata probe, the content hash blocklist, the virus scan and the metadata stripping copy into
// attachments/<the author's personal channel ID>/<attachment ID>/<filename>, which the media proxy signs like any
// attachment. Stricter than messages: only sniffed PNG/JPEG/WebP/GIF, at most 10 MB, NSFW blocked, and a file the
// media proxy cannot read is refused rather than kept as a plain file. Videos never take this path (Bunny Stream,
// FeedVideoService); the evidence copy and the delete here skip a Bunny video's media.
export class FeedMediaService {
	constructor(private readonly deps: FeedMediaServiceDeps) {}

	async planUploads(params: {
		user: User;
		clientIp: string;
		attachments: Array<PresignedAttachmentUploadRequestItem>;
	}): Promise<Array<PresignedAttachmentUploadResponseItem>> {
		const {user, clientIp, attachments} = params;
		if (!Config.presignedAttachmentUploadsEnabled) {
			throw new FeatureTemporarilyDisabledError();
		}
		this.refuseLegacyVideo(
			user,
			attachments.map(({filename}) => filename),
		);
		attachments.forEach((attachment, index) => {
			if (!FEED_MEDIA_TYPES.has(getContentType(attachment.filename))) {
				throw InputValidationError.fromCode(
					`attachments.${index}.filename`,
					ValidationErrorCodes.ATTACHMENT_MUST_BE_IMAGE,
				);
			}
		});
		assertAttachmentFileSizesWithinLimit(
			attachments.map(({file_size}) => file_size),
			this.maxBytes(user),
		);
		const {storageService, attachmentUploadTraceRepository} = this.deps;
		const bucket = Config.s3.buckets.uploads;
		const channelId = userIdToChannelId(user.id);
		const relayDecision = await resolveUploadRelayDecision(clientIp);
		return Promise.all(
			attachments.map(async (attachment) => {
				const uploadKey = crypto.randomUUID();
				const contentType = getContentType(attachment.filename);
				await attachmentUploadTraceRepository.recordRequestedUpload({
					uploadKey,
					userId: user.id,
					channelId,
					filename: attachment.filename,
					contentType,
					uploadMode: 'presigned_singlepart',
					requestIp: clientIp,
				});
				const presignedUrl = await storageService.getPresignedUploadURL({
					bucket,
					key: uploadKey,
					contentType,
					contentLength: attachment.file_size,
				});
				return {
					upload_mode: 'singlepart' as const,
					id: attachment.id,
					filename: attachment.filename,
					upload_filename: uploadKey,
					upload_url: applyUploadRelayDecision({
						presignedUrl,
						bucket,
						key: uploadKey,
						relayDecision,
						contentType,
						maxBytes: attachment.file_size,
					}),
					file_size: attachment.file_size,
					content_type: contentType,
				};
			}),
		);
	}

	/** Checks and stores the images of a new post; on any refusal the images already stored are removed again. */
	async processPostMedia(params: {
		user: User;
		postId: bigint;
		attachments: Array<ClientUploadedAttachmentRequest>;
	}): Promise<Array<FeedMedia>> {
		const {user, postId, attachments} = params;
		validateAttachmentIds(attachments.map(({id}) => ({id: BigInt(id)})));
		// Checked again here: the planned name is not bound to the upload, and the flag may have changed since.
		this.refuseLegacyVideo(
			user,
			attachments.map(({filename}) => filename),
		);
		const maxBytes = this.maxBytes(user);
		const results = await Promise.allSettled(
			attachments.map((attachment, index) => this.processOne({user, postId, attachment, index, maxBytes})),
		);
		const stored = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
		const failure = results.find((result) => result.status === 'rejected');
		if (failure) {
			await this.deleteMedia(user.id, stored, {purge: false});
			throw failure.reason;
		}
		return stored;
	}

	/**
	 * Copies the images to the reports bucket under their CDN keys before a moderator removes the post, as the report
	 * path does for reported posts, and returns the keys copied. A failed copy is logged and never stops the removal.
	 */
	async keepEvidence(authorId: UserID, media: ReadonlyArray<FeedMedia>): Promise<Array<string>> {
		const channelId = userIdToChannelId(authorId);
		const copied = await Promise.all(
			media
				.filter((item) => !isStreamMedia(item))
				.map(async (item) => {
					const key = makeAttachmentCdnKey(channelId, item.attachment_id, item.filename);
					try {
						await this.deps.storageService.copyObject({
							sourceBucket: Config.s3.buckets.cdn,
							sourceKey: key,
							destinationBucket: Config.s3.buckets.reports,
							destinationKey: key,
							newContentType: item.content_type,
						});
						return [key];
					} catch (error) {
						Logger.error({error, key}, 'Failed to keep a moderated feed image as evidence');
						return [];
					}
				}),
		);
		return copied.flat();
	}

	/**
	 * Removes stored images, and queues their CDN purge when they were ever served (the CDN purge path); moderator and
	 * NCMEC removals take the priority purge, as Fluxer's message removals do.
	 */
	async deleteMedia(
		authorId: UserID,
		media: ReadonlyArray<FeedMedia>,
		options: {purge: boolean; priority?: boolean} = {purge: true},
	): Promise<void> {
		// A Bunny video is deleted on the video lane (deleteFeedVideo), never from the attachment buckets.
		const stored = media.filter((item) => !isStreamMedia(item));
		if (stored.length === 0) return;
		const channelId = userIdToChannelId(authorId);
		await Promise.all(
			stored.map((item) =>
				this.deps.storageService.deleteObject(
					Config.s3.buckets.cdn,
					makeAttachmentCdnKey(channelId, item.attachment_id, item.filename),
				),
			),
		);
		if (options.purge) {
			const purgeQueue = options.priority ? priorityPurgeQueue(this.deps.purgeQueue) : this.deps.purgeQueue;
			await purgeQueue.addUrls(
				stored.map((item) => makeAttachmentCdnUrl(channelId, item.attachment_id, item.filename)),
			);
		}
	}

	private async processOne(params: {
		user: User;
		postId: bigint;
		attachment: ClientUploadedAttachmentRequest;
		index: number;
		maxBytes: number;
	}): Promise<FeedMedia> {
		const {user, postId, attachment, index, maxBytes} = params;
		const {storageService, mediaService, attachmentUploadTraceRepository} = this.deps;
		const uploads = Config.s3.buckets.uploads;
		const uploadKey = attachment.upload_filename;
		const field = `attachments.${index}.upload_filename`;
		const channelId = userIdToChannelId(user.id);
		// The name becomes the last segment of the CDN key, so it has to read as an image as well.
		if (!FEED_MEDIA_TYPES.has(getContentType(attachment.filename))) {
			throw InputValidationError.fromCode(
				`attachments.${index}.filename`,
				ValidationErrorCodes.ATTACHMENT_MUST_BE_IMAGE,
			);
		}
		const pending = await attachmentUploadTraceRepository.getPendingUpload({
			uploadKey,
			userId: user.id,
			channelId,
			uploadMode: 'presigned_singlepart',
		});
		if (!pending) {
			throw InputValidationError.fromCode(field, ValidationErrorCodes.UPLOADED_ATTACHMENT_NOT_FOUND, {
				filename: attachment.filename,
			});
		}
		const uploaded = await storageService.getObjectMetadata(uploads, uploadKey);
		if (!uploaded) {
			throw InputValidationError.fromCode(field, ValidationErrorCodes.FILE_NOT_FOUND);
		}
		if (uploaded.contentLength > maxBytes) {
			throw new FileSizeTooLargeError(maxBytes);
		}
		const metadata = await mediaService.getMetadata({
			type: 'upload',
			upload_filename: uploadKey,
			filename: attachment.filename,
			nsfw: 'block',
		});
		if (!metadata) {
			throw new MediaMetadataError('upload');
		}
		if (!FEED_MEDIA_TYPES.has(metadata.content_type)) {
			throw InputValidationError.fromCode(`attachments.${index}`, ValidationErrorCodes.ATTACHMENT_MUST_BE_IMAGE);
		}
		const localPath = temporaryFile();
		try {
			await storageService.writeObjectToDisk(uploads, uploadKey, localPath);
			await this.scan({user, postId, uploadKey, contentHash: metadata.content_hash, localPath});
			const attachmentId = createAttachmentID(await this.deps.snowflakeService.generate());
			const cdnKey = makeAttachmentCdnKey(channelId, attachmentId, attachment.filename);
			const stored = await storageService.copyObjectWithMetadataStripping({
				sourceBucket: uploads,
				sourceKey: uploadKey,
				destinationBucket: Config.s3.buckets.cdn,
				destinationKey: cdnKey,
				contentType: metadata.content_type,
				sourceLocalPath: localPath,
			});
			// Binding the trace consumes the upload, so a second post cannot reuse it.
			if (!(await attachmentUploadTraceRepository.bindAttachment(uploadKey, attachmentId))) {
				await storageService.deleteObject(Config.s3.buckets.cdn, cdnKey);
				throw InputValidationError.fromCode(field, ValidationErrorCodes.UPLOADED_ATTACHMENT_NOT_FOUND, {
					filename: attachment.filename,
				});
			}
			this.deleteUpload(uploadKey);
			return {
				attachment_id: attachmentId,
				filename: attachment.filename,
				size: BigInt(stored?.contentLength ?? metadata.size),
				description: attachment.description ?? null,
				width: stored?.width ?? metadata.width ?? null,
				height: stored?.height ?? metadata.height ?? null,
				content_type: metadata.content_type,
				content_hash: stored?.contentHash ?? metadata.content_hash,
				placeholder: metadata.placeholder ?? null,
				flags: metadata.animated ? MessageAttachmentFlags.IS_ANIMATED : 0,
				nsfw: false,
			};
		} finally {
			await fs.promises.unlink(localPath).catch(() => undefined);
		}
	}

	// The content hash blocklist, then the virus scan; either refusal deletes the upload.
	private async scan(params: {
		user: User;
		postId: bigint;
		uploadKey: string;
		contentHash: string;
		localPath: string;
	}): Promise<void> {
		const {user, postId, uploadKey, contentHash, localPath} = params;
		try {
			contentModerationService.scanSha256(contentHash, {
				userId: user.id,
				guildId: null,
				channelId: userIdToChannelId(user.id),
				messageId: postId,
				surface: 'message_attachment',
			});
			const {virusScanService} = this.deps;
			if (virusScanService.enabled && !(await virusScanService.scanFile(localPath)).isClean) {
				throw new ContentBlockedError();
			}
		} catch (error) {
			if (error instanceof ContentBlockedError) {
				await this.deps.storageService.deleteObject(Config.s3.buckets.uploads, uploadKey);
			}
			throw error;
		}
	}

	private deleteUpload(uploadKey: string): void {
		void this.deps.storageService.deleteObject(Config.s3.buckets.uploads, uploadKey).catch((error) => {
			Logger.warn({error, uploadKey}, 'Failed to delete a consumed feed upload');
		});
	}

	// An mp4/webm name answers 403 while feature_feed_video is 0, as it did before the Bunny path; once the flag is
	// 1 the image check refuses it with 400, like every other name that is not an image.
	private refuseLegacyVideo(user: User, filenames: ReadonlyArray<string>): void {
		if (
			filenames.some((filename) => LEGACY_VIDEO_TYPES.has(getContentType(filename))) &&
			this.limit(user, 'feature_feed_video', 0) === 0
		) {
			throw new FeatureTemporarilyDisabledError();
		}
	}

	// 10 MB, or less when the account's max_attachment_file_size is lower.
	private maxBytes(user: User): number {
		const maxAttachment = this.limit(user, 'max_attachment_file_size', ATTACHMENT_MAX_SIZE_NON_PREMIUM);
		return Math.min(FEED_MEDIA_MAX_BYTES, Math.floor(maxAttachment));
	}

	private limit(user: User, key: LimitKey, fallback: number): number {
		return resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user}),
			key,
			fallback,
		);
	}
}
