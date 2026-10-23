// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/activities/band/cover/BandCover.module.css';
import type {ActivityCoverProps} from '@app/features/activities/registry/ActivityDefinition';
import {clsx} from 'clsx';

type Lane = 'green' | 'red' | 'yellow' | 'blue' | 'orange';

// Where the notes sit on each lane, in percent of the highway's length; drawn once, nothing moves.
const LANES: ReadonlyArray<{readonly lane: Lane; readonly notes: ReadonlyArray<number>}> = [
	{lane: 'green', notes: [23, 63]},
	{lane: 'red', notes: [44]},
	{lane: 'yellow', notes: [12, 81]},
	{lane: 'blue', notes: [58]},
	{lane: 'orange', notes: [33]},
];

// The card is the cover's own default; the other sizes adjust it.
const SIZE_CLASS: Readonly<Record<ActivityCoverProps['size'], string | null>> = {
	card: null,
	hero: styles.hero,
	tile: styles.tile,
};

// Bir Daha Baştan's cover, drawn in CSS: the note highway in the game's lane colours with the wordmark and the tilted
// beer-yellow block of the sanalyer logo. Decorative; the name is always written next to it.
export function BandCover({size}: ActivityCoverProps) {
	const showWordmark = size === 'card' || size === 'hero';
	return (
		<div
			className={clsx(styles.cover, SIZE_CLASS[size])}
			aria-hidden="true"
			data-flx="activities.band.band-cover.cover"
		>
			<div className={styles.highway} data-flx="activities.band.band-cover.highway">
				{LANES.map(({lane, notes}) => (
					<div key={lane} className={clsx(styles.lane, styles[lane])} data-flx="activities.band.band-cover.lane">
						{notes.map((top) => (
							<span
								key={top}
								className={styles.note}
								style={{top: `${top}%`}}
								data-flx="activities.band.band-cover.note"
							/>
						))}
					</div>
				))}
			</div>
			<div className={styles.fade} data-flx="activities.band.band-cover.fade" />
			{showWordmark && (
				<div className={styles.wordmark} data-flx="activities.band.band-cover.wordmark">
					<span className={styles.wordmarkText} data-flx="activities.band.band-cover.wordmark-text">
						<span className={styles.wordmarkLine} data-flx="activities.band.band-cover.wordmark-line">
							Bir Daha
						</span>
						<span className={styles.wordmarkLine} data-flx="activities.band.band-cover.wordmark-line--2">
							Baştan
						</span>
					</span>
					<span className={styles.block} data-flx="activities.band.band-cover.block" />
				</div>
			)}
		</div>
	);
}
