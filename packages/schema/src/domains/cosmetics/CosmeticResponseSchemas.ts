// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createNamedStringLiteralUnion,
	SnowflakeStringType,
	withOpenApiType,
} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const CosmeticItemType = withOpenApiType(
	createNamedStringLiteralUnion(
		[
			['avatar_decoration', 'avatar_decoration', 'A frame drawn around the avatar'],
			['avatar_ultra', 'avatar_ultra', 'Large decoration drawn behind or in front of the avatar, such as wings'],
			['profile_effect', 'profile_effect', 'An effect played over the profile card'],
			['nameplate', 'nameplate', 'A background behind the name in member and direct message lists'],
		],
		'The kind of profile cosmetic',
	),
	'CosmeticItemType',
);

export type CosmeticItemType = z.infer<typeof CosmeticItemType>;

export const CosmeticAvailability = withOpenApiType(
	createNamedStringLiteralUnion(
		[
			['free', 'free', 'Every account can wear it'],
			['premium', 'premium', 'Accounts with premium can wear it'],
			['owned', 'owned', 'Only accounts that own it can wear it'],
		],
		'Who can wear the cosmetic',
	),
	'CosmeticAvailability',
);

export type CosmeticAvailability = z.infer<typeof CosmeticAvailability>;

export const UltraLayoutSurface = z
	.object({
		width: z.number().min(0.5).max(6),
		height: z.number().min(0.5).max(6),
		offset_x: z.number().min(-3).max(3),
		offset_y: z.number().min(-3).max(3),
	})
	.describe('Multiples of the avatar diameter on the scale of the fixed sizes (2.30, 3.20, 3.40)');

export type UltraLayoutSurface = z.infer<typeof UltraLayoutSurface>;

export const UltraLayout = z.object({
	compact: UltraLayoutSurface.nullable().describe('Chat and member list; null uses the fixed size'),
	voice: UltraLayoutSurface.nullable().describe('Voice tiles; null uses the fixed size'),
	profile: UltraLayoutSurface.nullable().describe('Profile card; null uses the fixed size'),
});

export type UltraLayout = z.infer<typeof UltraLayout>;

export const UltraFront = z
	.object({
		closed: z.string().describe('Hash of the still closed frame'),
		open: z.array(z.string()).min(2).max(30).describe('Hashes of the opening frames in order; frame 0 matches closed'),
		idle: z.string().describe('Hash of the animated loop that plays while open'),
	})
	.describe(
		'Ultra decorations drawn in front of the avatar that open on interaction; every image is the left half and the client mirrors it',
	);

export type UltraFront = z.infer<typeof UltraFront>;

export const CosmeticItemResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the cosmetic item'),
	type: CosmeticItemType,
	name: z.string().describe('The display name of the item'),
	description: z.string().nullable().describe('A short description of the item'),
	series: z
		.string()
		.nullish()
		.describe('Series the item belongs to, such as "Arcade"; null or absent when it has none'),
	asset: z
		.string()
		.describe('Hash of the item image; the media proxy serves it under branding/cosmetic-<type>-<id>/<asset>'),
	availability: CosmeticAvailability,
	ultra_layout: UltraLayout.nullish().describe('Ultra decorations only; null or absent uses the fixed sizes'),
	ultra_front: UltraFront.nullish().describe('Ultra decorations only; null or absent draws the item behind the avatar'),
});

export type CosmeticItemResponse = z.infer<typeof CosmeticItemResponse>;

export const CosmeticCatalogResponse = z.array(CosmeticItemResponse).describe('Catalog items, filtered by type');

export type CosmeticCatalogResponse = z.infer<typeof CosmeticCatalogResponse>;

export const CosmeticItemListResponse = z
	.array(CosmeticItemResponse)
	.describe('Every cosmetic item, items taken off sale included');

export type CosmeticItemListResponse = z.infer<typeof CosmeticItemListResponse>;

export const EquippedCosmeticsResponse = z.object({
	avatar_decoration_id: SnowflakeStringType.nullable().describe('The avatar decoration being worn'),
	avatar_ultra_id: SnowflakeStringType.nullable().describe('The ultra decoration being worn'),
	profile_effect_id: SnowflakeStringType.nullable().describe('The profile effect being worn'),
	nameplate_id: SnowflakeStringType.nullable().describe('The nameplate being worn'),
});

export type EquippedCosmeticsResponse = z.infer<typeof EquippedCosmeticsResponse>;

export const UserCosmeticsResponse = z.object({
	owned: z.array(CosmeticItemResponse).describe('Items the account owns'),
	equipped: EquippedCosmeticsResponse.describe('Items the account wears'),
});

export type UserCosmeticsResponse = z.infer<typeof UserCosmeticsResponse>;

export const CosmeticAssetDataResponse = z.object({
	asset: z.string().describe('Hash of the worn item image'),
	item_id: SnowflakeStringType.describe('The ID of the worn cosmetic item'),
});

export type CosmeticAssetDataResponse = z.infer<typeof CosmeticAssetDataResponse>;

export const AdminUserCosmeticResponse = z.object({
	item_id: SnowflakeStringType.describe('The ID of the cosmetic item'),
	owned: z.boolean().describe('Whether the account owns the item now'),
	equipped: z.boolean().describe('Whether the account wears the item now'),
	changed: z.boolean().describe('false when the account already owned (grant) or did not own (take back) the item'),
	unequipped: z.boolean().describe('Take back only: the item was worn and has been taken off'),
});

export type AdminUserCosmeticResponse = z.infer<typeof AdminUserCosmeticResponse>;
