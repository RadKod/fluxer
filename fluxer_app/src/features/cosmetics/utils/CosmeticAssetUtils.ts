// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {snapMediaProxyImageSize} from '@app/features/messaging/utils/MediaProxyUtils';
import {buildMediaUrl, parseAvatarHash} from '@app/features/user/utils/AvatarMediaUtils';
import type {MediaProxyImageSize} from '@fluxer/constants/src/MediaProxyImageSizes';
import type {
	CosmeticAssetDataResponse,
	CosmeticItemType,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';

// The media proxy never serves branding assets below 128 px, and cosmetic uploads are capped at 480 px, so larger
// requests only add CDN variants of the same image.
const COSMETIC_MEDIA_MIN_SIZE: MediaProxyImageSize = 128;
const COSMETIC_MEDIA_MAX_SIZE: MediaProxyImageSize = 480;
// In-front ultra parts are up to 576 px tall; 600 is the ladder rung that serves them whole.
export const ULTRA_FRONT_MEDIA_MAX_SIZE: MediaProxyImageSize = 600;

export function getCosmeticAssetURL(
	type: CosmeticItemType,
	data: CosmeticAssetDataResponse,
	cssSize: number,
	animated: boolean,
	maxSize: MediaProxyImageSize = COSMETIC_MEDIA_MAX_SIZE,
): string {
	const endpoint = RuntimeConfig.mediaEndpoint;
	if (!endpoint) return '';
	const {animated: isAnimated, hash} = parseAvatarHash(data.asset);
	const playAnimated = isAnimated && animated;
	const snapped = snapMediaProxyImageSize(cssSize);
	const size = snapped < COSMETIC_MEDIA_MIN_SIZE ? COSMETIC_MEDIA_MIN_SIZE : snapped > maxSize ? maxSize : snapped;
	return buildMediaUrl({
		endpoint,
		path: 'branding',
		id: `cosmetic-${type}-${data.item_id}`,
		hash: playAnimated ? data.asset : hash,
		size,
		animated: playAnimated,
	});
}
