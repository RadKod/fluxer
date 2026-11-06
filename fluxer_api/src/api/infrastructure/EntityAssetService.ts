// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Config} from '@app/api/Config';
import {stripAnimationPrefix} from '@app/api/infrastructure/AssetEntitlementUtils';
import {contentModerationService, type ModerationContext} from '@app/api/infrastructure/ContentModerationService';
import type {IAssetDeletionQueue, QueuedAssetReference} from '@app/api/infrastructure/IAssetDeletionQueue';
import type {IMediaService, MediaProxyMetadataResponse} from '@app/api/infrastructure/IMediaService';
import {decodeValidatedImage, resolveAssetSizeLimit} from '@app/api/infrastructure/ImageUploadValidation';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {bannedAvatarHashCache} from '@app/api/middleware/BannedAvatarHashCache';
import type {User} from '@app/api/models/User';
import {awaitAll} from '@app/api/utils/ConcurrencyUtils';
import {type AssetKind, COSMETIC_ASSET_POLICY, getPolicy} from '@fluxer/constants/src/AssetFormatPolicy';
import {AVATAR_MAX_SIZE} from '@fluxer/constants/src/LimitConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ContentBlockedError} from '@fluxer/errors/src/domains/content/ContentBlockedError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {ms} from 'itty-time';

type AssetType =
	| 'avatar'
	| 'banner'
	| 'icon'
	| 'splash'
	| 'embed_splash'
	| 'branding'
	| 'branding_backdrop'
	| 'custom_badge'
	| 'role_icon';
type EntityType = 'user' | 'guild' | 'guild_member' | 'instance' | 'role';
// Micup: a cosmetic catalog image is a branding asset whose owner key names the item. The media proxy serves any
// branding/<owner>/<hash> with an owner key of [A-Za-z0-9_-]{1,128}, so no new asset type or prefix is needed.
export type CosmeticAssetOwnerKey = `cosmetic-${string}-${bigint}`;

// Micup (angel-wings): a part of an ultra decoration drawn in front: the left half (height = 2 × width), still or animated.
export interface CosmeticImageShape {
	height: Readonly<{min: number; max: number}>;
	animated: boolean;
}

const ASSET_TYPE_TO_PREFIX: Record<AssetType, string> = {
	avatar: 'avatars',
	banner: 'banners',
	icon: 'icons',
	splash: 'splashes',
	embed_splash: 'embed-splashes',
	branding: 'branding',
	branding_backdrop: 'branding-backdrops',
	custom_badge: 'custom-badges',
	role_icon: 'role-icons',
};

const ASSET_TYPE_TO_MODERATION_SURFACE: Record<AssetType, ModerationContext['surface']> = {
	avatar: 'avatar',
	banner: 'banner',
	icon: 'guild_icon',
	splash: 'guild_splash',
	embed_splash: 'guild_splash',
	branding: 'app_asset',
	branding_backdrop: 'app_asset',
	custom_badge: 'app_asset',
	role_icon: 'app_asset',
};

function normalizeContentType(contentType: string | null | undefined): string {
	return (contentType ?? '').toLowerCase().split(';', 1)[0]?.trim() ?? '';
}

function isSvgMetadata(metadata: MediaProxyMetadataResponse): boolean {
	const format = metadata.format.toLowerCase();
	const contentType = normalizeContentType(metadata.content_type);
	return format === 'svg' || contentType === 'image/svg+xml' || contentType === 'image/svg';
}

function requireDimensionsWithinPolicy(metadata: MediaProxyMetadataResponse, kind: AssetKind, errorPath: string): void {
	const dims = getPolicy(kind).dims;
	if (!dims) return;
	const {width, height} = metadata;
	const inRange = (value: number | null | undefined) => value != null && value >= dims.min && value <= dims.max;
	if (!inRange(width) || !inRange(height)) {
		throw InputValidationError.fromCode(errorPath, ValidationErrorCodes.IMAGE_DIMENSIONS_OUT_OF_RANGE, {
			min: dims.min,
			max: dims.max,
		});
	}
}

export interface PreparedAssetUpload {
	newHash: string | null;
	previousHash: string | null;
	isAnimated: boolean;
	newS3Key: string | null;
	previousS3Key: string | null;
	newCdnUrl: string | null;
	previousCdnUrl: string | null;
	height?: number;
	width?: number;
	imageBuffer?: Uint8Array;
	format?: string | null;
	contentType?: string | null;
	previousReference: QueuedAssetReference | null;
	newReference: QueuedAssetReference | null;
	_uploaded: boolean;
}

interface PrepareAssetUploadOptions {
	assetType: AssetType;
	entityType: EntityType;
	entityId: bigint | CosmeticAssetOwnerKey;
	guildId?: bigint;
	previousHash: string | null;
	base64Image: string | null;
	errorPath: string;
	cosmeticMaxBytes?: number;
	cosmeticShape?: CosmeticImageShape;
	uploader?: User | null;
	enforceDimensions?: boolean;
}

type LimitConfigSnapshotProvider = Pick<LimitConfigService, 'getConfigSnapshot'>;

export class EntityAssetService {
	constructor(
		private readonly storageService: IStorageService,
		private readonly mediaService: IMediaService,
		private readonly assetDeletionQueue: IAssetDeletionQueue,
		private readonly limitConfigService: LimitConfigSnapshotProvider,
	) {}

	private mapAssetTypeToAssetKind(assetType: AssetType): AssetKind {
		switch (assetType) {
			case 'avatar':
				return 'avatar';
			case 'icon':
			case 'branding':
			case 'custom_badge':
				return 'guild_icon';
			case 'banner':
				return 'banner';
			case 'splash':
				return 'splash';
			case 'embed_splash':
				return 'embed_splash';
			case 'branding_backdrop':
				return 'sign_in_backdrop';
			case 'role_icon':
				return 'role_icon';
		}
	}

	// Micup: admin-only path for cosmetic catalog images; the new object never replaces an old one, since accounts
	// that wear the previous image keep pointing at it, so callers do not commitAssetChange. Without a shape the image
	// follows the catalog rule (96-480 px each side, still or animated).
	async prepareCosmeticAssetUpload(
		ownerKey: CosmeticAssetOwnerKey,
		base64Image: string,
		errorPath: string,
		maxBytes: number,
		shape?: CosmeticImageShape,
	): Promise<PreparedAssetUpload> {
		return this.prepareAssetUpload({
			assetType: 'branding',
			entityType: 'instance',
			entityId: ownerKey,
			previousHash: null,
			base64Image,
			errorPath,
			cosmeticMaxBytes: maxBytes,
			cosmeticShape: shape,
		});
	}

	async prepareAssetUpload(options: PrepareAssetUploadOptions): Promise<PreparedAssetUpload> {
		const {
			assetType,
			entityType,
			entityId,
			guildId,
			previousHash,
			base64Image,
			errorPath,
			uploader,
			enforceDimensions,
		} = options;
		const cosmetic = typeof entityId === 'string';
		if (cosmetic && assetType !== 'branding') {
			throw new Error('Only branding assets take a cosmetic owner key');
		}
		const s3KeyBase = this.buildS3KeyBase(assetType, entityType, entityId, guildId);
		const cdnUrlBase = `${Config.endpoints.media}/${s3KeyBase}`;
		const previousS3Key = previousHash ? `${s3KeyBase}/${stripAnimationPrefix(previousHash)}` : null;
		const previousCdnUrl = previousHash ? `${cdnUrlBase}/${previousHash}` : null;
		const previousReference = previousHash
			? this.buildQueuedAssetReference(assetType, entityType, entityId, previousHash, guildId)
			: null;
		if (!base64Image) {
			return {
				newHash: null,
				previousHash,
				isAnimated: false,
				newS3Key: null,
				previousS3Key,
				newCdnUrl: null,
				previousCdnUrl,
				previousReference,
				newReference: null,
				_uploaded: false,
				format: null,
				contentType: null,
			};
		}
		const {
			imageBuffer,
			format,
			height,
			width,
			contentType,
			animated: isAnimated,
		} = await this.validateAndProcessImage(
			base64Image,
			errorPath,
			assetType,
			uploader ?? null,
			cosmetic,
			enforceDimensions ?? false,
			options.cosmeticMaxBytes,
			options.cosmeticShape,
		);
		const imageHash = crypto.createHash('md5').update(Buffer.from(imageBuffer)).digest('hex');
		const imageHashShort = imageHash.slice(0, 8);
		if (bannedAvatarHashCache.isBanned(imageHashShort)) {
			throw new ContentBlockedError();
		}
		const moderationContext: ModerationContext = {
			userId: uploader?.id ?? null,
			guildId: guildId ?? null,
			channelId: null,
			messageId: null,
			surface: ASSET_TYPE_TO_MODERATION_SURFACE[assetType],
		};
		contentModerationService.scanFileBuffer(imageBuffer, moderationContext);
		const newHash = isAnimated ? `a_${imageHashShort}` : imageHashShort;
		const newS3Key = `${s3KeyBase}/${imageHashShort}`;
		const newCdnUrl = `${cdnUrlBase}/${newHash}.${format}`;
		const prepared: PreparedAssetUpload = {
			newHash,
			previousHash,
			isAnimated,
			newS3Key,
			previousS3Key,
			newCdnUrl,
			previousCdnUrl,
			previousReference,
			newReference: this.buildQueuedAssetReference(assetType, entityType, entityId, newHash, guildId),
			height,
			width,
			_uploaded: false,
			imageBuffer,
			format,
			contentType,
		};
		if (newHash === previousHash) return prepared;
		let uploadBuffer: Uint8Array = imageBuffer;
		try {
			const stripped = await this.mediaService.stripImageMetadata(imageBuffer);
			if (stripped) {
				uploadBuffer = stripped;
			} else {
				Logger.error({assetType, entityType}, 'Failed to strip metadata from entity asset, uploading original');
			}
		} catch (error) {
			Logger.error({error, assetType, entityType}, 'Failed to strip metadata from entity asset, uploading original');
		}
		if (uploadBuffer !== imageBuffer) {
			contentModerationService.scanFileBuffer(uploadBuffer, moderationContext);
		}
		await this.uploadToS3(assetType, entityType, newS3Key, uploadBuffer);
		const exists = await this.verifyAssetExistsWithRetry(assetType, entityType, newS3Key);
		if (!exists) {
			Logger.error(
				{newS3Key, assetType, entityType},
				'Asset upload verification failed - object does not exist after upload with retries',
			);
			throw InputValidationError.fromCode(errorPath, ValidationErrorCodes.FAILED_TO_UPLOAD_IMAGE);
		}
		prepared._uploaded = true;
		return prepared;
	}

	async prepareAssetCopy(options: {
		assetType: AssetType;
		entityType: EntityType;
		sourceEntityId: bigint;
		entityId: bigint;
		guildId?: bigint;
		hash: string;
		errorPath: string;
	}): Promise<PreparedAssetUpload | null> {
		const {assetType, entityType, sourceEntityId, entityId, guildId, hash, errorPath} = options;
		const objectName = stripAnimationPrefix(hash);
		if (bannedAvatarHashCache.isBanned(objectName)) {
			Logger.warn({assetType, entityType}, 'Asset to copy is on the hash blocklist, leaving the copy without it');
			return null;
		}
		const sourceS3Key = `${this.buildS3KeyBase(assetType, entityType, sourceEntityId, guildId)}/${objectName}`;
		if ((await this.storageService.getObjectMetadata(Config.s3.buckets.cdn, sourceS3Key)) === null) {
			Logger.warn({sourceS3Key, assetType, entityType}, 'Asset to copy does not exist, leaving the copy without it');
			return null;
		}
		const s3KeyBase = this.buildS3KeyBase(assetType, entityType, entityId, guildId);
		const newS3Key = `${s3KeyBase}/${objectName}`;
		const prepared: PreparedAssetUpload = {
			newHash: hash,
			previousHash: null,
			isAnimated: hash.startsWith('a_'),
			newS3Key,
			previousS3Key: null,
			newCdnUrl: `${Config.endpoints.media}/${s3KeyBase}/${hash}`,
			previousCdnUrl: null,
			previousReference: null,
			newReference: this.buildQueuedAssetReference(assetType, entityType, entityId, hash, guildId),
			_uploaded: false,
		};
		await this.storageService.copyObject({
			sourceBucket: Config.s3.buckets.cdn,
			sourceKey: sourceS3Key,
			destinationBucket: Config.s3.buckets.cdn,
			destinationKey: newS3Key,
		});
		if (!(await this.verifyAssetExistsWithRetry(assetType, entityType, newS3Key))) {
			throw InputValidationError.fromCode(errorPath, ValidationErrorCodes.FAILED_TO_UPLOAD_IMAGE);
		}
		prepared._uploaded = true;
		return prepared;
	}

	async commitAssetChange(prepared: PreparedAssetUpload): Promise<void> {
		if (!prepared.previousHash || !prepared.previousS3Key || prepared.newHash === prepared.previousHash) {
			return;
		}
		await this.assetDeletionQueue.queueDeletion({
			s3Key: prepared.previousS3Key,
			cdnUrl: prepared.previousCdnUrl,
			reason: 'asset_replaced',
			staleReference: prepared.previousReference ?? undefined,
		});
		Logger.debug(
			{previousS3Key: prepared.previousS3Key, previousCdnUrl: prepared.previousCdnUrl},
			'Queued old asset for deferred deletion',
		);
	}

	async queueUploadForStaleCheck(prepared: PreparedAssetUpload): Promise<void> {
		if (!prepared._uploaded || !prepared.newS3Key || !prepared.newReference) {
			return;
		}
		await this.assetDeletionQueue.queueDeletion({
			s3Key: prepared.newS3Key,
			cdnUrl: null,
			reason: 'asset_upload_stale_check',
			staleReference: prepared.newReference,
		});
	}

	async commitAssetChanges(preparedAssets: ReadonlyArray<PreparedAssetUpload | null>): Promise<void> {
		await awaitAll(
			preparedAssets.filter((prepared) => prepared !== null).map(async (prepared) => this.commitAssetChange(prepared)),
			'Failed to commit asset changes',
		);
	}

	async rollbackAssetUpload(prepared: PreparedAssetUpload): Promise<void> {
		if (!prepared._uploaded || !prepared.newS3Key) {
			return;
		}
		try {
			await this.storageService.deleteObject(Config.s3.buckets.cdn, prepared.newS3Key);
			Logger.info({newS3Key: prepared.newS3Key}, 'Rolled back asset upload after DB failure');
		} catch (error) {
			Logger.error({error, newS3Key: prepared.newS3Key}, 'Failed to rollback asset upload - asset may be orphaned');
		}
	}

	private async verifyAssetExistsWithRetry(
		assetType: AssetType,
		entityType: EntityType,
		s3Key: string,
		maxRetries: number = 3,
		delayMs: number = ms('500 milliseconds'),
	): Promise<boolean> {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				const metadata = await this.storageService.getObjectMetadata(Config.s3.buckets.cdn, s3Key);
				if (metadata !== null) {
					if (attempt > 1) {
						Logger.info({s3Key, assetType, entityType, attempt}, 'Asset verification succeeded after retry');
					}
					return true;
				}
			} catch (error) {
				Logger.warn({error, s3Key, assetType, entityType, attempt}, 'Asset verification attempt failed');
			}
			if (attempt < maxRetries) {
				await delay(delayMs * attempt, undefined, {ref: false});
			}
		}
		Logger.error({s3Key, assetType, entityType, maxRetries}, 'Asset verification failed after all retries');
		return false;
	}

	private buildQueuedAssetReference(
		assetType: AssetType,
		entityType: EntityType,
		entityId: bigint | CosmeticAssetOwnerKey,
		hash: string,
		guildId?: bigint,
	): QueuedAssetReference {
		return {
			assetType,
			entityType,
			entityId: entityId.toString(),
			guildId: guildId?.toString(),
			hash,
		};
	}

	private buildS3KeyBase(
		assetType: AssetType,
		entityType: EntityType,
		entityId: bigint | CosmeticAssetOwnerKey,
		guildId?: bigint,
	): string {
		const prefix = ASSET_TYPE_TO_PREFIX[assetType];
		if (entityType === 'guild_member') {
			if (!guildId) {
				throw new Error('guildId is required for guild_member assets');
			}
			return `guilds/${guildId}/users/${entityId}/${prefix}`;
		}
		return `${prefix}/${entityId}`;
	}

	private async validateAndProcessImage(
		base64Image: string,
		errorPath: string,
		assetType: AssetType,
		uploader: User | null,
		cosmetic: boolean,
		enforceDimensions: boolean,
		cosmeticMaxBytes?: number,
		cosmeticShape?: CosmeticImageShape,
	): Promise<{
		imageBuffer: Uint8Array;
		format: string;
		height?: number;
		width?: number;
		contentType: string | null;
		animated: boolean;
	}> {
		const kind = this.mapAssetTypeToAssetKind(assetType);
		const {imageBuffer, metadata} = cosmetic
			? await this.decodeCosmeticImage(
					base64Image,
					errorPath,
					cosmeticMaxBytes ?? COSMETIC_ASSET_POLICY.maxBytes,
					cosmeticShape,
				)
			: await decodeValidatedImage(this.mediaService, {
					base64Image,
					errorPath,
					kind,
					maxSize:
						kind === 'sign_in_backdrop' || kind === 'role_icon'
							? getPolicy(kind).maxBytes
							: resolveAssetSizeLimit(this.limitConfigService, 'avatar_max_size', AVATAR_MAX_SIZE, null, uploader),
				});
		if (!cosmetic && (kind === 'role_icon' || enforceDimensions)) {
			requireDimensionsWithinPolicy(metadata, kind, errorPath);
		}
		const isAnimatedImage = metadata.animated ?? false;
		const keepDimensions = !isSvgMetadata(metadata);
		return {
			imageBuffer,
			format: metadata.format,
			height: keepDimensions ? (metadata.height ?? undefined) : undefined,
			width: keepDimensions ? (metadata.width ?? undefined) : undefined,
			contentType: metadata.content_type ?? null,
			animated: isAnimatedImage,
		};
	}

	private async decodeCosmeticImage(
		base64Image: string,
		errorPath: string,
		maxSize: number,
		shape?: CosmeticImageShape,
	): Promise<{imageBuffer: Uint8Array; metadata: MediaProxyMetadataResponse}> {
		const base64Data = base64Image.includes(',') ? base64Image.split(',')[1] : base64Image;
		if (Buffer.byteLength(base64Data, 'base64') > maxSize) {
			throw InputValidationError.fromCode(errorPath, ValidationErrorCodes.IMAGE_SIZE_EXCEEDS_LIMIT, {maxSize});
		}
		const imageBuffer = new Uint8Array(Buffer.from(base64Data, 'base64'));
		const metadata = await this.mediaService.getMetadata({
			type: 'base64',
			base64: base64Data,
			version: 2,
			nsfw: 'allow',
		});
		return {imageBuffer, metadata: this.requireCosmeticMetadata(metadata, errorPath, shape)};
	}

	private requireCosmeticMetadata(
		metadata: MediaProxyMetadataResponse | null,
		errorPath: string,
		shape?: CosmeticImageShape,
	): MediaProxyMetadataResponse {
		const {upload, dims} = COSMETIC_ASSET_POLICY;
		const within = (side: number | null | undefined, range: Readonly<{min: number; max: number}>) =>
			side != null && side >= range.min && side <= range.max;
		const shaped = shape
			? within(metadata?.height, shape.height) &&
				metadata?.width != null &&
				metadata.width * 2 === metadata.height &&
				(metadata.animated ?? false) === shape.animated
			: within(metadata?.width, dims) && within(metadata?.height, dims);
		if (
			metadata == null ||
			isSvgMetadata(metadata) ||
			!upload.some((ext) => ext === metadata.format.toLowerCase()) ||
			!shaped
		) {
			throw InputValidationError.fromCode(errorPath, ValidationErrorCodes.INVALID_IMAGE_FORMAT, {
				supportedExtensions: upload.join(', '),
			});
		}
		return metadata;
	}

	private async uploadToS3(
		assetType: AssetType,
		entityType: EntityType,
		s3Key: string,
		imageBuffer: Uint8Array,
	): Promise<void> {
		try {
			Logger.debug({s3Key, assetType, entityType, size: imageBuffer.length}, 'Starting asset upload to S3');
			await this.storageService.uploadObject({
				bucket: Config.s3.buckets.cdn,
				key: s3Key,
				body: imageBuffer,
			});
			Logger.debug({s3Key, assetType, entityType}, 'Asset upload to S3 completed successfully');
		} catch (error) {
			Logger.error({error, s3Key, assetType, entityType}, 'Asset upload to S3 failed');
			throw new Error(`Failed to upload asset to S3: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}
}
