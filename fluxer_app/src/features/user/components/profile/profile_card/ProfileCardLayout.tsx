// SPDX-License-Identifier: AGPL-3.0-or-later

import {ProfileEffectOverlay} from '@app/features/cosmetics/components/ProfileEffectOverlay';
import {profileGradientSurface} from '@app/features/user/components/profile/ProfileGradientSurface';
import styles from '@app/features/user/components/profile/profile_card/ProfileCardLayout.module.css';
import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ThemeColors} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {Trans} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useMemo} from 'react';

interface ProfileCardLayoutProps {
	borderColor: string;
	themeColors?: ThemeColors | null;
	showPreviewLabel?: boolean;
	hoverRef?: (instance: HTMLDivElement | null) => void;
	className?: string;
	style?: React.CSSProperties;
	profileEffect?: CosmeticAssetDataResponse | null;
	children: React.ReactNode;
}

export const ProfileCardLayout: React.FC<ProfileCardLayoutProps> = observer(
	({borderColor, themeColors, showPreviewLabel = false, hoverRef, className, style, profileEffect, children}) => {
		const gradient = useMemo(() => profileGradientSurface(themeColors), [themeColors]);
		const cardStyle = useMemo<React.CSSProperties>(
			() => ({...style, borderColor, ...gradient?.style}),
			[borderColor, style, gradient],
		);
		return (
			<div data-flx="user.profile.profile-card.profile-card-layout.div">
				{showPreviewLabel && (
					<div className={styles.previewLabel} data-flx="user.profile.profile-card.profile-card-layout.preview-label">
						<Trans>Profile preview</Trans>
					</div>
				)}
				<div
					ref={hoverRef}
					className={clsx(styles.profileCard, gradient?.className, className)}
					style={cardStyle}
					data-flx="user.profile.profile-card.profile-card-layout.profile-card"
				>
					{children}
					<ProfileEffectOverlay
						effect={profileEffect}
						data-flx="user.profile.profile-card.profile-card-layout.profile-effect-overlay"
					/>
				</div>
			</div>
		);
	},
);
