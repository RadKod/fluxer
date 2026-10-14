// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import type {BadgeRepository} from '@app/api/badge/BadgeRepository';
import {fillPioneerNumber, PIONEER_NUMBER_TOKEN} from '@app/api/badge/PioneerService';
import {Config} from '@app/api/Config';
import type {BadgeCatalogRow, UserBadgeRow} from '@app/api/database/types/BadgeTypes';
import {type IMediaService, mediaProxyMetadataPolicy} from '@app/api/infrastructure/IMediaService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {stripNonJpegImageMetadata} from '@app/api/infrastructure/StorageObjectHelpers';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import type {BadgeResponse} from '@fluxer/schema/src/domains/badge/BadgeResponseSchemas';
import {ms} from 'itty-time';

interface BadgeServiceDeps {
	repository: BadgeRepository;
	storageService: IStorageService;
	mediaService: IMediaService;
	snowflakeService: ISnowflakeService;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICON_FORMATS = new Set(['png', 'apng', 'webp']);
const CATALOG_CACHE_TTL_MS = ms('1 minute');

// The bytes decide, never the data URL type: only a PNG (APNG included) or a RIFF WebP container gets to the media
// proxy, so an SVG (script) or any other format is refused before it is read or stored.
function isPngOrWebp(bytes: Buffer): boolean {
	return (
		bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
		(bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
	);
}

function invalidIcon(): InputValidationError {
	return InputValidationError.fromCode('icon', ValidationErrorCodes.INVALID_IMAGE_FORMAT, {
		supportedExtensions: 'png, apng, webp',
	});
}

function toResponse(row: Pick<BadgeCatalogRow, 'badge_id' | 'icon_hash' | 'description'>): BadgeResponse {
	return {id: row.badge_id.toString(), icon: row.icon_hash, description: row.description};
}

export class BadgeService {
	// TEMPORARY: each API process caches the whole catalog for a minute, so a new or renamed badge reaches profiles
	// served by other processes within that minute. The catalog is one partition, bounded by the admin-curated list.
	private catalogCache: {expiresAt: number; badges: Promise<Map<bigint, BadgeResponse>>} | null = null;

	constructor(private readonly deps: BadgeServiceDeps) {}

	async listBadges(): Promise<Array<BadgeResponse>> {
		return (await this.deps.repository.listCatalog()).map(toResponse);
	}

	async createBadge(params: {icon: string; description: string}): Promise<BadgeResponse> {
		const badgeId = await this.deps.snowflakeService.generate();
		const iconHash = await this.storeIcon(badgeId, params.icon);
		const row = {badge_id: badgeId, icon_hash: iconHash, description: params.description, created_at: new Date()};
		await this.deps.repository.upsertBadge({...row, version: 1});
		this.catalogCache = null;
		return toResponse(row);
	}

	async updateBadge(badgeId: bigint, params: {icon?: string; description?: string}): Promise<BadgeResponse> {
		const existing = await this.requireBadge(badgeId);
		// A new icon gets a new hash and key; the old object stays so cached URLs keep resolving.
		const iconHash = params.icon === undefined ? existing.icon_hash : await this.storeIcon(badgeId, params.icon);
		const row = {
			...existing,
			icon_hash: iconHash,
			description: params.description ?? existing.description,
			version: existing.version + 1,
		};
		await this.deps.repository.upsertBadge(row);
		this.catalogCache = null;
		return toResponse(row);
	}

	async grantBadge(userId: UserID, badgeId: bigint): Promise<void> {
		const badge = await this.requireBadge(badgeId);
		// a text with {n} makes the badge numbered; only PioneerService.regrant gives it, with the account's number.
		if (badge.description.includes(PIONEER_NUMBER_TOKEN)) {
			throw new ConflictError({
				code: APIErrorCodes.CONFLICT,
				message: 'A numbered badge is only given with its own number.',
			});
		}
		await this.deps.repository.grantUserBadge({user_id: userId, badge_id: badgeId, granted_at: new Date()});
	}

	async revokeBadge(userId: UserID, badgeId: bigint): Promise<void> {
		await this.deps.repository.revokeUserBadge(userId, badgeId);
	}

	// One read of the user's own partition; the catalog comes from the process cache, and only when there is a badge. A
	// numbered badge (Öncü) shows the number stored on the account's own row in place of {n}.
	async getProfileBadges(userId: UserID): Promise<Array<BadgeResponse>> {
		return this.toProfileBadges(await this.deps.repository.listUserBadges(userId));
	}

	// Also for the granted rows kept in the cached profile view, so a renamed badge shows like before.
	async toProfileBadges(granted: Array<Pick<UserBadgeRow, 'badge_id' | 'sequence'>>): Promise<Array<BadgeResponse>> {
		if (granted.length === 0) return [];
		const catalog = await this.getCatalog();
		return granted.flatMap((row) => {
			const badge = catalog.get(row.badge_id);
			return badge ? {...badge, description: fillPioneerNumber(badge.description, row.sequence)} : [];
		});
	}

	async deleteUserBadges(userId: UserID): Promise<void> {
		await this.deps.repository.deleteUserBadges(userId);
	}

	async exportUserBadges(
		userId: UserID,
	): Promise<Array<{id: string; icon: string | null; description: string | null; granted_at: string}>> {
		const granted = await this.deps.repository.listUserBadges(userId);
		const badges = await Promise.all(granted.map((row) => this.deps.repository.getBadge(row.badge_id)));
		return granted.map((row, index) => ({
			id: row.badge_id.toString(),
			icon: badges[index]?.icon_hash ?? null,
			description: badges[index] ? fillPioneerNumber(badges[index].description, row.sequence) : null,
			granted_at: row.granted_at.toISOString(),
		}));
	}

	private async requireBadge(badgeId: bigint) {
		const badge = await this.deps.repository.getBadge(badgeId);
		if (!badge) throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		return badge;
	}

	private getCatalog(): Promise<Map<bigint, BadgeResponse>> {
		const now = Date.now();
		if (this.catalogCache && this.catalogCache.expiresAt > now) return this.catalogCache.badges;
		const entry = {
			expiresAt: now + CATALOG_CACHE_TTL_MS,
			badges: this.deps.repository
				.listCatalog()
				.then((rows) => new Map(rows.map((row) => [row.badge_id, toResponse(row)]))),
		};
		this.catalogCache = entry;
		entry.badges.catch(() => {
			if (this.catalogCache === entry) this.catalogCache = null;
		});
		return entry.badges;
	}

	// Stored the way media-proxy serves the branding prefix: key branding/badge-<id>/<hash8>, and the returned hash
	// carries the a_ prefix when the icon moves (the proxy drops it when it looks the key up).
	private async storeIcon(badgeId: bigint, base64: string): Promise<string> {
		const bytes = Buffer.from(base64, 'base64');
		if (!isPngOrWebp(bytes)) throw invalidIcon();
		const metadata = await this.deps.mediaService.getMetadata({
			type: 'base64',
			base64,
			...mediaProxyMetadataPolicy('allow'),
		});
		if (!metadata || !ICON_FORMATS.has(metadata.format.toLowerCase())) throw invalidIcon();
		const body = await stripNonJpegImageMetadata(bytes);
		const hash = crypto.createHash('md5').update(body).digest('hex').slice(0, 8);
		await this.deps.storageService.uploadObject({
			bucket: Config.s3.buckets.cdn,
			key: `branding/badge-${badgeId}/${hash}`,
			body,
		});
		return metadata.animated ? `a_${hash}` : hash;
	}
}
