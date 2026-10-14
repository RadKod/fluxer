// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	PROFILE_POPOUT_GEOMETRY as G,
	getProfileAvatarDecorationBounds,
	getProfileAvatarLeft,
	PROFILE_POPOUT_OUTER_WIDTH_PX,
} from '@app/features/user/constants/UserProfileSurfaceGeometry';
import type {User} from '@app/features/user/models/User';

// Reuse the avatar renderer's bounds, including front-wing fallback and admin offsets. No DOM measurement or timer.
export function shopStageLayout(user: User, size: 'grid' | 'full') {
	const bounds = getProfileAvatarDecorationBounds(user, G.avatarSizePx, size === 'grid' ? 0 : G.avatarBorderPx);
	if (size === 'grid') {
		const width = bounds.right - bounds.left + 32;
		const height = bounds.bottom - bounds.top + 32;
		return {
			width,
			height,
			cardX: 16 - bounds.left,
			cardY: 16 - bounds.top,
			scale: Math.min(1, 288 / width, 211.2 / height),
		};
	}
	const avatarLeft = getProfileAvatarLeft({
		decorationLeft: bounds.left,
		size: G.avatarSizePx,
		border: G.avatarBorderPx,
		edgePadding: G.avatarLeftPx,
		containerWidth: G.contentWidthPx,
	});
	const origin = G.borderWidthPx + avatarLeft + G.avatarBorderPx;
	const left = Math.min(0, origin + bounds.left);
	const right = Math.max(PROFILE_POPOUT_OUTER_WIDTH_PX, origin + bounds.right);
	const width = right - left + 32;
	// ProfileCardBanner already reserves decoration height; profile text continues in normal flow below it.
	return {width, height: undefined, cardX: 16 - left, cardY: 16, scale: Math.min(1, 360 / width)};
}
