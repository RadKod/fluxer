// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/user/components/profile/ProfileGradient.module.css';
import {profileGradientCssVars} from '@app/features/user/utils/ProfileGradient';
import type {ThemeColors} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import type React from 'react';

export interface ProfileGradientSurface {
	className: string;
	style: React.CSSProperties;
}

// The border turns transparent so the gradient runs under it instead of the accent colour.
export function profileGradientSurface(themeColors: ThemeColors | null | undefined): ProfileGradientSurface | null {
	if (!themeColors) return null;
	return {
		className: styles.surface,
		style: {...profileGradientCssVars(themeColors), borderColor: 'transparent'} as React.CSSProperties,
	};
}
