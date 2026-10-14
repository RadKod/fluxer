// SPDX-License-Identifier: AGPL-3.0-or-later

import {isShopCosmeticType, SHOP_SURFACES, type ShopSurface} from '@app/features/shop/utils/ShopSurfaces';
import type {User} from '@app/features/user/models/User';
import type {
	CosmeticAssetDataResponse,
	CosmeticItemResponse,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';

function assetData(item: CosmeticItemResponse): CosmeticAssetDataResponse {
	return {asset: item.asset, item_id: item.id};
}

export function previewUserForSurface(
	user: User,
	surface: ShopSurface,
	items: ReadonlyArray<CosmeticItemResponse>,
): User {
	return previewUserFor(
		user,
		...items.filter((item) => isShopCosmeticType(item.type) && SHOP_SURFACES[item.type].includes(surface)),
	);
}

// Shows only these items, as if worn: every slot the user wears starts empty, so nothing of theirs (their ultra wings
// above all) mixes into the preview. A profile effect lives on the profile, not the user (previewEffectFor).
export function previewUserFor(user: User, ...items: Array<CosmeticItemResponse>): User {
	const worn = (type: CosmeticItemResponse['type']) => {
		const item = items.find((candidate) => candidate.type === type);
		return item ? assetData(item) : null;
	};
	return user.withUpdates({
		avatar_decoration_data: worn('avatar_decoration'),
		avatar_ultra_data: worn('avatar_ultra'),
		nameplate_data: worn('nameplate'),
	});
}

// The first effect among these items, as delivery wears the first of each type.
export function previewEffectFor(...items: Array<CosmeticItemResponse>): CosmeticAssetDataResponse | null {
	const effect = items.find((item) => item.type === 'profile_effect');
	return effect ? assetData(effect) : null;
}
