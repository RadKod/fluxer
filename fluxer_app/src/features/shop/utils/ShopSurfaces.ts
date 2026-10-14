// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticType} from '@app/features/cosmetics/state/Cosmetics';

export type ShopSurface = 'profile' | 'chat' | 'member_list' | 'voice';

// Where the app draws each type; the detail dialog shows these surfaces and no others.
export const SHOP_SURFACES: Record<CosmeticType, ReadonlyArray<ShopSurface>> = {
	avatar_decoration: ['profile', 'chat', 'member_list', 'voice'],
	avatar_ultra: ['profile', 'chat', 'member_list', 'voice'],
	profile_effect: ['profile'],
	nameplate: ['member_list'],
};

export function isShopCosmeticType(type: string): type is CosmeticType {
	return Object.hasOwn(SHOP_SURFACES, type);
}

export function detailSurfacesFor(types: ReadonlyArray<string>): Array<Exclude<ShopSurface, 'voice'>> {
	return (['profile', 'member_list', 'chat'] as const).filter((surface) =>
		types.some((type) => isShopCosmeticType(type) && SHOP_SURFACES[type].includes(surface)),
	);
}
