// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivityCoverProps} from '@app/features/activities/registry/ActivityDefinition';
import styles from '@app/features/activities/registry/JamCover.module.css';
import {clsx} from 'clsx';

// Three level bars in the band game's lane colours: free playing, no notes to follow.
export function JamCover({size}: ActivityCoverProps) {
	return (
		<div
			className={clsx(styles.cover, size !== 'thumb' && styles.large)}
			aria-hidden="true"
			data-flx="activities.jam-cover.cover"
		>
			<span className={clsx(styles.bar, styles.green)} data-flx="activities.jam-cover.bar" />
			<span className={clsx(styles.bar, styles.yellow)} data-flx="activities.jam-cover.bar--2" />
			<span className={clsx(styles.bar, styles.blue)} data-flx="activities.jam-cover.bar--3" />
		</div>
	);
}
