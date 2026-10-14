// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import {AvatarUltraFront} from '@app/features/cosmetics/components/AvatarUltraFront';
import styles from '@app/features/cosmetics/components/AvatarUltraLayer.module.css';
import {CANVAS_RATIO, ULTRA_BOX_SCALE} from '@app/features/cosmetics/constants/AvatarDecorationGeometry';
import UltraLayouts from '@app/features/cosmetics/state/UltraLayouts';
import {getCosmeticAssetURL} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type CSSProperties, useState} from 'react';

export type AvatarDecorationSurface = 'none' | 'compact' | 'voice' | 'profile';
type UltraSurface = Exclude<AvatarDecorationSurface, 'none'>;
// Micup: 'behind' is the underlay slot, 'front' the decoration slot over the avatar.
export type AvatarUltraPlacement = 'behind' | 'front';

const MIN_ULTRA_AVATAR_SIZE = 32;

interface AvatarUltraLayerProps {
	ultra: CosmeticAssetDataResponse | null;
	size: number;
	animate: boolean;
	surface: AvatarDecorationSurface;
	placement?: AvatarUltraPlacement;
}

export function AvatarUltraLayer({ultra, size, animate, surface, placement = 'behind'}: AvatarUltraLayerProps) {
	if (ultra == null || surface === 'none' || size < MIN_ULTRA_AVATAR_SIZE) return null;
	return (
		<AvatarUltraSlot
			ultra={ultra}
			size={size}
			animate={animate}
			surface={surface}
			placement={placement}
			data-flx="cosmetics.avatar-ultra-layer.avatar-ultra-slot"
		/>
	);
}

interface AvatarUltraSlotProps {
	ultra: CosmeticAssetDataResponse;
	size: number;
	animate: boolean;
	surface: UltraSurface;
	placement: AvatarUltraPlacement;
}

// Nothing draws before the item is read; an in-front item draws only in front, every other item (and a failed read)
// draws behind exactly as before.
const AvatarUltraSlot = observer(function AvatarUltraSlot({
	ultra,
	size,
	animate,
	surface,
	placement,
}: AvatarUltraSlotProps) {
	const front = UltraLayouts.frontFor(ultra.item_id);
	if (front === undefined) return null;
	if (placement === 'front') {
		return front ? (
			<AvatarUltraFront
				itemId={ultra.item_id}
				front={front}
				size={size}
				animate={animate}
				surface={surface}
				data-flx="cosmetics.avatar-ultra-layer.avatar-ultra-front"
			/>
		) : null;
	}
	return front ? null : (
		<AvatarUltraImage
			ultra={ultra}
			size={size}
			animate={animate}
			surface={surface}
			data-flx="cosmetics.avatar-ultra-layer.avatar-ultra-image"
		/>
	);
});

interface AvatarUltraImageProps {
	ultra: CosmeticAssetDataResponse;
	size: number;
	animate: boolean;
	surface: UltraSurface;
}

const AvatarUltraImage = observer(function AvatarUltraImage({ultra, size, animate, surface}: AvatarUltraImageProps) {
	const playing = useShouldAnimate({kind: 'avatar', isHovering: animate && !Accessibility.useReducedMotion});
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	// Without an admin-set size the DOM stays exactly as the fixed sizes draw it: no style attribute.
	const layout = UltraLayouts.layoutFor(ultra.item_id)?.[surface] ?? null;
	const boxScale = layout ? Math.max(layout.width, layout.height) * CANVAS_RATIO : ULTRA_BOX_SCALE[surface];
	const url = getCosmeticAssetURL('avatar_ultra', ultra, size * boxScale, playing);
	if (!url || url === failedUrl) return null;
	return (
		<img
			className={clsx(
				styles.ultra,
				surface === 'voice' && styles.ultraVoice,
				surface === 'profile' && styles.ultraProfile,
				layout && styles.ultraCustom,
			)}
			style={
				layout
					? ({
							'--ultra-w': layout.width,
							'--ultra-h': layout.height,
							'--ultra-x': layout.offset_x,
							'--ultra-y': layout.offset_y,
						} as CSSProperties)
					: undefined
			}
			src={url}
			alt=""
			aria-hidden
			draggable={false}
			onError={() => setFailedUrl(url)}
			data-flx="cosmetics.avatar-ultra-layer.image"
		/>
	);
});
