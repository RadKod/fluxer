// SPDX-License-Identifier: AGPL-3.0-or-later

import {useId} from 'react';

export const BoostGemIcon = ({size = 20}: {size?: 16 | 20 | 24}) => {
	const gradientId = useId();
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-flx="boost.gem-icon">
			<defs>
				<linearGradient id={gradientId} x1="3" y1="3" x2="21" y2="22" gradientUnits="userSpaceOnUse">
					<stop stopColor="#ff89ce" />
					<stop offset="0.48" stopColor="#ed58bf" />
					<stop offset="1" stopColor="#9466ed" />
				</linearGradient>
			</defs>
			<path d="M7 2.5h10l5 7L12 22 2 9.5z" fill={`url(#${gradientId})`} />
			<path
				d="m7 2.5 2 7L12 22l3-12.5 2-7M2 9.5h20M9 9.5l3-7 3 7"
				fill="none"
				stroke="white"
				strokeOpacity="0.52"
				strokeWidth="0.85"
				strokeLinejoin="round"
			/>
		</svg>
	);
};
