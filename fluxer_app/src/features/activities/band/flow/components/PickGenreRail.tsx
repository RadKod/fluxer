// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandGenreGroup} from '@app/features/activities/band/BandProtocol';
import {
	DECADE_DESCRIPTORS,
	GENRE_GROUP_DESCRIPTORS,
	PICK_ERA_DESCRIPTOR,
	PICK_GENRES_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import {BAND_DECADES, type BandDecade, type BandGroupCount} from '@app/features/activities/band/flow/BandSongFilters';
import styles from '@app/features/activities/band/flow/components/PickGenreRail.module.css';
import {formatNumber} from '@app/features/i18n/utils/IntlCache';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {useId} from 'react';

interface PickGenreRailProps {
	readonly counts: ReadonlyArray<BandGroupCount>;
	readonly group: BandGenreGroup | null;
	readonly decade: BandDecade | null;
	readonly onGroup: (group: BandGenreGroup | null) => void;
	// Clicking the chosen decade again clears it.
	readonly onDecade: (decade: BandDecade | null) => void;
}

// The genre shelves with their song counts, then the era chips. On a narrow stage it becomes one scrolling row.
export function PickGenreRail({counts, group, decade, onGroup, onDecade}: PickGenreRailProps) {
	const {i18n} = useLingui();
	const eraId = useId();
	const locale = getCurrentLocale();
	return (
		<nav
			className={styles.rail}
			aria-label={i18n._(PICK_GENRES_DESCRIPTOR)}
			data-flx="activities.band.flow.pick-genre-rail.rail"
		>
			<div className={styles.groups} data-flx="activities.band.flow.pick-genre-rail.groups">
				{counts.map((entry) => {
					const selected = entry.group === group;
					return (
						<button
							key={entry.group ?? 'all'}
							type="button"
							className={clsx(styles.group, selected && styles.groupSelected)}
							aria-pressed={selected}
							onClick={() => onGroup(entry.group)}
							data-flx="activities.band.flow.pick-genre-rail.group.button"
						>
							<span className={styles.groupName} data-flx="activities.band.flow.pick-genre-rail.group-name">
								{i18n._(GENRE_GROUP_DESCRIPTORS[entry.group ?? 'all'])}
							</span>
							<span className={styles.count} data-flx="activities.band.flow.pick-genre-rail.count">
								{formatNumber(entry.count, locale)}
							</span>
						</button>
					);
				})}
			</div>
			<div
				className={styles.era}
				role="group"
				aria-labelledby={eraId}
				data-flx="activities.band.flow.pick-genre-rail.era"
			>
				<span id={eraId} className={styles.eraTitle} data-flx="activities.band.flow.pick-genre-rail.era-title">
					{i18n._(PICK_ERA_DESCRIPTOR)}
				</span>
				<div className={styles.chips} data-flx="activities.band.flow.pick-genre-rail.chips">
					{BAND_DECADES.map((entry) => {
						const selected = entry === decade;
						return (
							<button
								key={entry}
								type="button"
								className={clsx(styles.chip, selected && styles.chipSelected)}
								aria-pressed={selected}
								onClick={() => onDecade(selected ? null : entry)}
								data-flx="activities.band.flow.pick-genre-rail.chip.button"
							>
								{i18n._(DECADE_DESCRIPTORS[entry])}
							</button>
						);
					})}
				</div>
			</div>
		</nav>
	);
}
