// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	CANVAS_RATIO,
	DECORATION_SCALE,
	FRONT_SCALE,
	ULTRA_BOX_SCALE,
} from '@app/features/cosmetics/constants/AvatarDecorationGeometry';
import UltraLayouts from '@app/features/cosmetics/state/UltraLayouts';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {getStatusGeometry} from '@app/features/ui/constants/AvatarStatusGeometry';
import type {User} from '@app/features/user/models/User';

type CssLengthVariables = Record<`--${string}`, string>;

export function getProfileAvatarLeft({
	decorationLeft,
	size,
	border,
	edgePadding,
	containerWidth,
}: {
	decorationLeft: number;
	size: number;
	border: number;
	edgePadding: number;
	containerWidth: number;
}) {
	const decorationAwareLeft = Math.max(edgePadding, edgePadding - border - decorationLeft);
	return Math.min(decorationAwareLeft, Math.max(edgePadding, containerWidth - size - border * 2 - edgePadding));
}

// Bounds relative to the avatar image, including the frame and both possible ultra placements.
export function getProfileAvatarDecorationBounds(user: User, size: number, border: number) {
	const frameOverhang = user.avatarDecoration ? ((DECORATION_SCALE - 1) * size) / 2 : 0;
	const bounds = {
		left: -Math.max(border, frameOverhang),
		top: -Math.max(border, frameOverhang),
		right: size + Math.max(border, frameOverhang),
		bottom: size + Math.max(border, frameOverhang),
	};
	if (!user.avatarUltra) return bounds;
	const itemId = user.avatarUltra.item_id;
	const front = UltraLayouts.frontFor(itemId);
	const layout = UltraLayouts.layoutFor(itemId)?.profile;
	// Reserve the fallback too: a failed front asset switches to the item's behind layout.
	const width = size * (layout ? layout.width * CANVAS_RATIO : ULTRA_BOX_SCALE.profile);
	const height = size * (layout ? layout.height * CANVAS_RATIO : ULTRA_BOX_SCALE.profile);
	const left = (size - width) / 2 + (layout?.offset_x ?? 0) * size;
	const top = (size - height) / 2 + (layout?.offset_y ?? 0) * size;
	const frontOverhang = front ? ((FRONT_SCALE - 1) * size) / 2 : 0;
	return {
		left: Math.min(bounds.left, left, -frontOverhang),
		top: Math.min(bounds.top, top, -frontOverhang),
		right: Math.max(bounds.right, left + width, size + frontOverhang),
		bottom: Math.max(bounds.bottom, top + height, size + frontOverhang),
	};
}

const PROFILE_POPOUT_AVATAR_SIZE_PX = 80;
const PROFILE_MODAL_AVATAR_SIZE_PX = 120;
const PROFILE_POPOUT_AVATAR_BORDER_PX = getStatusGeometry(PROFILE_POPOUT_AVATAR_SIZE_PX).borderWidth;
const PROFILE_MODAL_AVATAR_BORDER_PX = getStatusGeometry(PROFILE_MODAL_AVATAR_SIZE_PX).borderWidth;
const PROFILE_POPOUT_AVATAR_LEFT_PX = 10;
const PROFILE_POPOUT_AVATAR_TOP_PX = 55;
const PROFILE_MODAL_AVATAR_LEFT_PX = 16;
const PROFILE_POPOUT_AVATAR_OUTER_RADIUS_PX = PROFILE_POPOUT_AVATAR_SIZE_PX / 2 + PROFILE_POPOUT_AVATAR_BORDER_PX;
const PROFILE_MODAL_AVATAR_OUTER_RADIUS_PX = PROFILE_MODAL_AVATAR_SIZE_PX / 2 + PROFILE_MODAL_AVATAR_BORDER_PX;

export const PROFILE_POPOUT_GEOMETRY = {
	contentWidthPx: 300,
	contentHeightPx: 520,
	borderWidthPx: 2.5,
	avatarSizePx: PROFILE_POPOUT_AVATAR_SIZE_PX,
	avatarBorderPx: PROFILE_POPOUT_AVATAR_BORDER_PX,
	avatarLeftPx: PROFILE_POPOUT_AVATAR_LEFT_PX,
	avatarTopPx: PROFILE_POPOUT_AVATAR_TOP_PX,
	bannerHeightPx: 105,
	headerHeightPx: 140,
} as const;

export const PROFILE_POPOUT_BANNER_AVATAR_CUTOUT = {
	viewBoxWidthPx: PROFILE_POPOUT_GEOMETRY.contentWidthPx,
	viewBoxHeightPx: PROFILE_POPOUT_GEOMETRY.bannerHeightPx,
	cx: PROFILE_POPOUT_AVATAR_LEFT_PX + PROFILE_POPOUT_AVATAR_OUTER_RADIUS_PX,
	cy: PROFILE_POPOUT_AVATAR_TOP_PX + PROFILE_POPOUT_AVATAR_OUTER_RADIUS_PX,
	r: PROFILE_POPOUT_AVATAR_OUTER_RADIUS_PX,
} as const;

export const PROFILE_MODAL_GEOMETRY = {
	bannerViewBoxWidthPx: 600,
	bannerViewBoxHeightPx: 210,
	avatarSizePx: PROFILE_MODAL_AVATAR_SIZE_PX,
	avatarBorderPx: PROFILE_MODAL_AVATAR_BORDER_PX,
	avatarLeftPx: PROFILE_MODAL_AVATAR_LEFT_PX,
	avatarTopPx: -PROFILE_MODAL_AVATAR_OUTER_RADIUS_PX,
} as const;

export const PROFILE_MODAL_BANNER_AVATAR_CUTOUT = {
	viewBoxWidthPx: PROFILE_MODAL_GEOMETRY.bannerViewBoxWidthPx,
	viewBoxHeightPx: PROFILE_MODAL_GEOMETRY.bannerViewBoxHeightPx,
	cx: PROFILE_MODAL_GEOMETRY.avatarLeftPx + PROFILE_MODAL_AVATAR_OUTER_RADIUS_PX,
	cy: PROFILE_MODAL_GEOMETRY.bannerViewBoxHeightPx,
	r: PROFILE_MODAL_AVATAR_OUTER_RADIUS_PX,
} as const;
export const PROFILE_POPOUT_GEOMETRY_STYLE: CssLengthVariables = {
	'--profile-popout-content-width': remFromPx(PROFILE_POPOUT_GEOMETRY.contentWidthPx),
	'--profile-popout-content-height': remFromPx(PROFILE_POPOUT_GEOMETRY.contentHeightPx),
	'--profile-popout-border-width': remFromPx(PROFILE_POPOUT_GEOMETRY.borderWidthPx),
	'--profile-popout-avatar-size': remFromPx(PROFILE_POPOUT_GEOMETRY.avatarSizePx),
	'--profile-popout-avatar-border': remFromPx(PROFILE_POPOUT_GEOMETRY.avatarBorderPx),
	'--profile-popout-avatar-left': remFromPx(PROFILE_POPOUT_GEOMETRY.avatarLeftPx),
	'--profile-popout-avatar-top': remFromPx(PROFILE_POPOUT_GEOMETRY.avatarTopPx),
	'--profile-popout-banner-height': remFromPx(PROFILE_POPOUT_GEOMETRY.bannerHeightPx),
	'--profile-popout-header-height': remFromPx(PROFILE_POPOUT_GEOMETRY.headerHeightPx),
};

export const PROFILE_MODAL_GEOMETRY_STYLE: CssLengthVariables = {
	'--profile-modal-avatar-size': remFromPx(PROFILE_MODAL_GEOMETRY.avatarSizePx),
	'--profile-modal-avatar-border': remFromPx(PROFILE_MODAL_GEOMETRY.avatarBorderPx),
	'--profile-modal-avatar-left': remFromPx(PROFILE_MODAL_GEOMETRY.avatarLeftPx),
	'--profile-modal-avatar-top': remFromPx(PROFILE_MODAL_GEOMETRY.avatarTopPx),
};
