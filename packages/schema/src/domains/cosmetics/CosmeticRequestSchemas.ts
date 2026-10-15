// SPDX-License-Identifier: AGPL-3.0-or-later

import {COSMETIC_ASSET_POLICY, ULTRA_FRONT_POLICY} from '@fluxer/constants/src/AssetFormatPolicy';
import {COSMETIC_SERIES_MAX_LENGTH} from '@fluxer/constants/src/CosmeticSeries';
import {
	CosmeticAvailability,
	CosmeticItemType,
	UltraLayout,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {base64LengthForBytes, createBase64StringType} from '@fluxer/schema/src/primitives/FileValidators';
import {createStringType, SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

// Micup: the outer cap is the largest per-type limit (ultraMaxBytes); updates carry no type, so each type's own
// limit (COSMETIC_ASSET_POLICY) is enforced where the image is stored, in EntityAssetService.
const COSMETIC_ASSET_MAX_BYTES = COSMETIC_ASSET_POLICY.ultraMaxBytes;

export const CosmeticCatalogQuery = z.object({
	type: CosmeticItemType.optional().describe('Only return items of this type'),
});

export type CosmeticCatalogQuery = z.infer<typeof CosmeticCatalogQuery>;

export const CosmeticItemIdParam = z.object({
	item_id: SnowflakeType.describe('The ID of the cosmetic item'),
});

export type CosmeticItemIdParam = z.infer<typeof CosmeticItemIdParam>;

export const EquipCosmeticsRequest = z.object({
	avatar_decoration_id: SnowflakeType.nullish().describe('Avatar decoration to wear; null takes it off'),
	avatar_ultra_id: SnowflakeType.nullish().describe('Ultra decoration to wear; null takes it off'),
	profile_effect_id: SnowflakeType.nullish().describe('Profile effect to wear; null takes it off'),
	nameplate_id: SnowflakeType.nullish().describe('Nameplate to wear; null takes it off'),
});

export type EquipCosmeticsRequest = z.infer<typeof EquipCosmeticsRequest>;

export const CosmeticItemCreateRequest = z.object({
	type: CosmeticItemType,
	name: createStringType(1, 64).describe('The display name of the item (1-64 characters)'),
	description: createStringType(1, 256).nullish().describe('A short description (1-256 characters)'),
	series: createStringType(1, COSMETIC_SERIES_MAX_LENGTH)
		.nullish()
		.describe('Series the item belongs to, such as "Arcade" (1-64 characters); null takes it out of its series'),
	availability: CosmeticAvailability,
	asset: createBase64StringType(1, base64LengthForBytes(COSMETIC_ASSET_MAX_BYTES)).describe(
		'Base64 PNG, APNG or WebP image, 8 MiB at most, 32-2048 px on each side; SVG is refused',
	),
});

export type CosmeticItemCreateRequest = z.infer<typeof CosmeticItemCreateRequest>;

// Outer caps per part; the service also holds the opening frames to their total and every part to its shape.
const frontPart = (maxBytes: number) => createBase64StringType(1, base64LengthForBytes(maxBytes));

export const UltraFrontUpload = z.object({
	closed: frontPart(ULTRA_FRONT_POLICY.closedMaxBytes).describe('Still closed frame, left half'),
	open: z
		.array(frontPart(ULTRA_FRONT_POLICY.openFrameMaxBytes))
		.min(ULTRA_FRONT_POLICY.minFrames)
		.max(ULTRA_FRONT_POLICY.maxFrames)
		.describe('Still opening frames in order, left half; 500 KB together at most'),
	idle: frontPart(ULTRA_FRONT_POLICY.idleMaxBytes).describe('Animated loop, left half'),
});

export type UltraFrontUpload = z.infer<typeof UltraFrontUpload>;

export const CosmeticItemUpdateRequest = CosmeticItemCreateRequest.omit({type: true})
	.partial()
	.extend({
		ultra_layout: UltraLayout.nullable()
			.optional()
			.describe('Ultra decorations only: sizes per surface; null goes back to the fixed sizes'),
		ultra_front: UltraFrontUpload.nullable()
			.optional()
			.describe('Ultra decorations only: the in-front images, all of them; null draws the item behind again'),
		on_sale: z.literal(true).optional().describe('Puts an item taken off sale back in the catalog'),
	});

export type CosmeticItemUpdateRequest = z.infer<typeof CosmeticItemUpdateRequest>;

const INT64_MAX = 9_223_372_036_854_775_807n;

export const CosmeticItemIdsQuery = z.object({
	ids: z
		.string()
		.regex(/^[1-9]\d{0,18}(,[1-9]\d{0,18}){0,49}$/)
		.refine(
			(ids) => ids.split(',').every((id) => /^\d+$/.test(id) && BigInt(id) <= INT64_MAX),
			'An item ID is above the int64 range',
		)
		.describe('Comma separated item IDs, at most 50'),
});

export type CosmeticItemIdsQuery = z.infer<typeof CosmeticItemIdsQuery>;

export const AdminUserCosmeticParam = z.object({
	user_id: SnowflakeType.describe('The ID of the user'),
	item_id: SnowflakeType.describe('The ID of the cosmetic item'),
});

export type AdminUserCosmeticParam = z.infer<typeof AdminUserCosmeticParam>;
