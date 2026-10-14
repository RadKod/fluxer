// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import styles from '@app/features/cosmetics/components/AvatarDecorationLayer.module.css';
import {DECORATION_SCALE} from '@app/features/cosmetics/constants/AvatarDecorationGeometry';
import {getCosmeticAssetURL} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

// The frame overhangs the avatar by a tenth on every side; below list-row size it would crowd the layout.
const MIN_DECORATED_AVATAR_SIZE = 32;

interface AvatarDecorationLayerProps {
	decoration: CosmeticAssetDataResponse | null;
	size: number;
	animate: boolean;
}

export function AvatarDecorationLayer({decoration, size, animate}: AvatarDecorationLayerProps) {
	if (decoration == null || size < MIN_DECORATED_AVATAR_SIZE) return null;
	return (
		<AvatarDecorationImage
			decoration={decoration}
			size={size}
			animate={animate}
			data-flx="cosmetics.avatar-decoration-layer.avatar-decoration-image"
		/>
	);
}

const AvatarDecorationImage = observer(function AvatarDecorationImage({
	decoration,
	size,
	animate,
}: AvatarDecorationLayerProps & {decoration: CosmeticAssetDataResponse}) {
	// Reduced motion keeps decorations still, on hover, while speaking and on profiles too.
	const shouldAnimate = useShouldAnimate({kind: 'avatar', isHovering: animate && !Accessibility.useReducedMotion});
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const url = getCosmeticAssetURL('avatar_decoration', decoration, size * DECORATION_SCALE, shouldAnimate);
	if (!url || url === failedUrl) return null;
	return (
		<img
			className={styles.image}
			src={url}
			alt=""
			aria-hidden
			draggable={false}
			onError={() => setFailedUrl(url)}
			data-flx="cosmetics.avatar-decoration-layer.image"
		/>
	);
});
