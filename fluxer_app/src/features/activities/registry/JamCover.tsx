// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/activities/registry/JamCover.module.css';
import {clsx} from 'clsx';

const LANES = ['green', 'red', 'yellow', 'blue', 'orange'] as const;

// Level bars in the band game's lane colours: free playing, no notes to follow. Decorative; the name is always
// written next to it. One picture at every size.
export function JamCover() {
	return (
		<div className={styles.cover} aria-hidden="true" data-flx="activities.jam-cover.cover">
			<div className={styles.meter} data-flx="activities.jam-cover.meter">
				{LANES.map((lane) => (
					<span key={lane} className={clsx(styles.bar, styles[lane])} data-flx="activities.jam-cover.bar" />
				))}
			</div>
		</div>
	);
}
