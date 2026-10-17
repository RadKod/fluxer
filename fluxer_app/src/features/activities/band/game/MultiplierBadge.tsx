// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/activities/band/game/MultiplierBadge.module.css';
import {clsx} from 'clsx';

interface MultiplierBadgeProps {
	// Streak multiplier 1..4, before star power doubles it.
	readonly multiplier: number;
	readonly starPower: boolean;
	// Replaces the "4×" text, e.g. with the finale bonus.
	readonly label?: string;
	// My star power bar, 0..1; left out for other players, whose bar is not broadcast.
	readonly energy?: number;
	readonly className?: string;
}

// The brand S-piece: three white blocks light one per multiplier step and the yellow block lands at 4x.
const BLOCKS: ReadonlyArray<readonly [number, number]> = [
	[0, 72],
	[72, 72],
	[72, 0],
];

export function MultiplierBadge({multiplier, starPower, label, energy, className}: MultiplierBadgeProps) {
	const lit = starPower ? 4 : Math.min(4, Math.max(1, multiplier));
	const shown = starPower ? multiplier * 2 : multiplier;
	return (
		<span
			className={clsx(styles.badge, starPower && styles.starPower, className)}
			data-flx="activities.band.game.multiplier-badge.badge"
		>
			<svg
				className={styles.piece}
				viewBox="-4 -4 216 144"
				aria-hidden="true"
				data-flx="activities.band.game.multiplier-badge.piece"
			>
				{BLOCKS.map(([x, y], index) => (
					<rect
						key={`${x}-${y}`}
						className={clsx(styles.block, index < lit && styles.lit)}
						x={x}
						y={y}
						width={64}
						height={64}
						rx={10}
						data-flx="activities.band.game.multiplier-badge.block"
					/>
				))}
				<rect
					className={clsx(styles.block, styles.yellow, lit >= 4 && styles.lit)}
					x={144}
					y={0}
					width={64}
					height={64}
					rx={10}
					data-flx="activities.band.game.multiplier-badge.block--2"
				/>
			</svg>
			<b className={styles.value} data-flx="activities.band.game.multiplier-badge.value">
				{label ?? `${shown}×`}
			</b>
			{energy !== undefined && energy > 0 && (
				<i
					className={styles.energy}
					style={{width: `${Math.min(1, energy) * 100}%`}}
					data-flx="activities.band.game.multiplier-badge.energy"
				/>
			)}
		</span>
	);
}
