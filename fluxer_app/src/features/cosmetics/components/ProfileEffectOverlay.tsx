// SPDX-License-Identifier: AGPL-3.0-or-later

import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import styles from '@app/features/cosmetics/components/ProfileEffectOverlay.module.css';
import {getCosmeticAssetURL} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import {useAutoplayExpandedProfileAnimations} from '@app/features/user/hooks/useAutoplayExpandedProfileAnimations';
import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

// Effects cover a whole profile card; one open profile at a time asks for the full upload size.
const PROFILE_EFFECT_CSS_SIZE = 480;

interface ProfileEffectOverlayProps {
	effect: CosmeticAssetDataResponse | null | undefined;
}

export function ProfileEffectOverlay({effect}: ProfileEffectOverlayProps) {
	if (effect == null) return null;
	return <ProfileEffectImage effect={effect} data-flx="cosmetics.profile-effect-overlay.profile-effect-image" />;
}

const ProfileEffectImage = observer(function ProfileEffectImage({effect}: {effect: CosmeticAssetDataResponse}) {
	const autoplay = useAutoplayExpandedProfileAnimations();
	const shouldAnimate = useShouldAnimate({kind: 'banner', isHovering: autoplay});
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const url = getCosmeticAssetURL('profile_effect', effect, PROFILE_EFFECT_CSS_SIZE, shouldAnimate);
	if (!url || url === failedUrl) return null;
	return (
		<img
			className={styles.image}
			src={url}
			alt=""
			aria-hidden
			draggable={false}
			onError={() => setFailedUrl(url)}
			data-flx="cosmetics.profile-effect-overlay.image"
		/>
	);
});
