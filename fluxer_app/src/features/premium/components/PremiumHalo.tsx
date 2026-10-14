// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/premium/components/PremiumHalo.module.css';
import {clsx} from 'clsx';
import type React from 'react';

interface PremiumHaloProps {
	// 'large' around plan and hero buttons, 'small' around shop card buttons.
	size: 'large' | 'small';
	// The strips slide while the halo is hovered or focused; true also while its section is (the premium hero).
	animated?: boolean;
	className?: string;
	// The Fluxer Button the halo glows around.
	children: React.ReactNode;
}

// Micup: the coloured light around the premium and shop buy buttons. Two blurred strips slide in opposite directions
// behind the button (transform only), only while hovered, focused or animated; the small one and reduced motion hold
// them still.
export function PremiumHalo({size, animated, className, children}: PremiumHaloProps) {
	return (
		<span
			className={clsx(styles.halo, size === 'small' && styles.small, className)}
			data-size={size}
			data-animated={animated}
			data-flx="premium.premium-halo.halo"
		>
			<span className={styles.glow} aria-hidden="true" data-flx="premium.premium-halo.glow" />
			{children}
		</span>
	);
}
