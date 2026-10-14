// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {useHover} from '@app/features/app/hooks/useHover';
import {useShouldAnimate} from '@app/features/app/hooks/useShouldAnimate';
import styles from '@app/features/cosmetics/components/NameplateBackground.module.css';
import {getCosmeticAssetURL} from '@app/features/cosmetics/utils/CosmeticAssetUtils';
import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useState} from 'react';

// Member and direct message rows are about this wide; the image covers the row and is cropped from the left.
const NAMEPLATE_CSS_WIDTH = 240;

interface NameplateBackgroundProps {
	nameplate: CosmeticAssetDataResponse | null;
	// Plays without a hover, for a row no pointer reaches (the shop's inert preview); reduced motion still holds it.
	animate?: boolean;
	children: React.ReactNode;
}

// Rows without a nameplate render exactly as before: no wrapper, no hover listener.
export function NameplateBackground({nameplate, animate = false, children}: NameplateBackgroundProps) {
	if (nameplate == null) return <>{children}</>;
	return (
		<NameplateSurface
			nameplate={nameplate}
			animate={animate}
			data-flx="cosmetics.nameplate-background.nameplate-surface"
		>
			{children}
		</NameplateSurface>
	);
}

const NameplateSurface = observer(function NameplateSurface({
	nameplate,
	animate,
	children,
}: NameplateBackgroundProps & {nameplate: CosmeticAssetDataResponse}) {
	const [hoverRef, isHovering] = useHover();
	const shouldAnimate = useShouldAnimate({
		kind: 'avatar',
		isHovering: isHovering || (animate === true && !Accessibility.useReducedMotion),
	});
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const url = getCosmeticAssetURL('nameplate', nameplate, NAMEPLATE_CSS_WIDTH, shouldAnimate);
	return (
		<>
			{url && url !== failedUrl && (
				<img
					className={styles.image}
					src={url}
					alt=""
					aria-hidden
					draggable={false}
					onError={() => setFailedUrl(url)}
					data-flx="cosmetics.nameplate-background.image"
				/>
			)}
			<div ref={hoverRef} className={styles.content} data-flx="cosmetics.nameplate-background.content">
				{children}
			</div>
		</>
	);
});
