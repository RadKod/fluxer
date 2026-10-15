// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/boost/components/GuildBoostLevelBadge.module.css';
import level1BadgeUrl from '@app/media/images/boost/level-1.webp';
import level2BadgeUrl from '@app/media/images/boost/level-2.webp';
import level3BadgeUrl from '@app/media/images/boost/level-3.webp';

const LEVEL_BADGE_URLS: Record<number, string> = {1: level1BadgeUrl, 2: level2BadgeUrl, 3: level3BadgeUrl};

export const GuildBoostLevelBadge = ({level, size}: {level: number; size: 16 | 20 | 24}) => {
	const src = LEVEL_BADGE_URLS[level];
	if (!src) return null;
	return (
		<img
			src={src}
			alt=""
			width={size}
			height={size}
			className={styles.badge}
			draggable={false}
			data-boost-level={level}
			data-flx="boost.level-badge"
		/>
	);
};
