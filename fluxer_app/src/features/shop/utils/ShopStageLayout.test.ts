// SPDX-License-Identifier: AGPL-3.0-or-later

import {shopStageLayout} from '@app/features/shop/utils/ShopStageLayout';
import {
	PROFILE_POPOUT_GEOMETRY as G,
	getProfileAvatarDecorationBounds,
	getProfileAvatarLeft,
} from '@app/features/user/constants/UserProfileSurfaceGeometry';
import type {User} from '@app/features/user/models/User';
import type {UltraLayoutSurface} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({profile: null as UltraLayoutSurface | null}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {
		frontFor: () => ({closed: 'closed', open: ['closed', 'open'], idle: 'idle'}),
		layoutFor: () => ({profile: state.profile}),
	},
}));
const user = {avatarDecoration: null, avatarUltra: {item_id: '1', asset: 'wings'}} as User;

describe('shopStageLayout', () => {
	it('fits real avatar bounds in a grid and reserves actual profile overhang for every valid extreme', () => {
		for (const width of [0.5, 6])
			for (const height of [0.5, 6]) {
				for (const offset_x of [-3, 3])
					for (const offset_y of [-3, 3]) {
						state.profile = {width, height, offset_x, offset_y};
						const grid = shopStageLayout(user, 'grid');
						const bounds = getProfileAvatarDecorationBounds(user, 80, 0);
						expect(grid.cardX + bounds.left).toBeGreaterThanOrEqual(0);
						expect(grid.cardY + bounds.top).toBeGreaterThanOrEqual(0);
						expect(grid.cardX + bounds.right).toBeLessThanOrEqual(grid.width);
						expect(grid.cardY + bounds.bottom).toBeLessThanOrEqual(grid.height!);
						expect(grid.width * grid.scale).toBeLessThanOrEqual(288 + 1e-8);
						expect(grid.height! * grid.scale).toBeLessThanOrEqual(211.2 + 1e-8);
						const full = shopStageLayout(user, 'full');
						const profileBounds = getProfileAvatarDecorationBounds(user, G.avatarSizePx, G.avatarBorderPx);
						const avatarLeft = getProfileAvatarLeft({
							decorationLeft: profileBounds.left,
							size: G.avatarSizePx,
							border: G.avatarBorderPx,
							edgePadding: G.avatarLeftPx,
							containerWidth: G.contentWidthPx,
						});
						const origin = full.cardX + G.borderWidthPx + avatarLeft + G.avatarBorderPx;
						expect(origin + profileBounds.left).toBeGreaterThanOrEqual(0);
						expect(origin + profileBounds.right).toBeLessThanOrEqual(full.width);
						expect(full.height).toBeUndefined();
						expect(full.width * full.scale).toBeLessThanOrEqual(360 + 1e-8);
					}
			}
	});
});
