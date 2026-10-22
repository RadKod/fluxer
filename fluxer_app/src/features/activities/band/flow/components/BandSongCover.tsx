// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import styles from '@app/features/activities/band/flow/components/BandSongCover.module.css';
import {clsx} from 'clsx';
import {useState} from 'react';

const LANES = ['green', 'red', 'yellow', 'blue', 'orange'] as const;

interface BandSongCoverProps {
	readonly song: BandSongSummary;
	// Rendered size in rem; the type cover scales its lettering from it.
	readonly sizeRem?: number;
	readonly showArtist?: boolean;
	readonly className?: string;
}

export function BandSongCover({song, sizeRem, showArtist = true, className}: BandSongCoverProps) {
	const [broken, setBroken] = useState(false);
	const size = sizeRem === undefined ? undefined : `${sizeRem}rem`;
	if (song.coverUrl && !broken) {
		return (
			<img
				className={clsx(styles.cover, className)}
				style={{width: size, height: size}}
				src={song.coverUrl}
				alt=""
				loading="lazy"
				onError={() => setBroken(true)}
				data-flx="activities.band.flow.band-song-cover.cover"
			/>
		);
	}
	return (
		<div
			className={clsx(styles.cover, styles.typeCover, className)}
			style={{width: size, height: size}}
			aria-hidden="true"
			data-flx="activities.band.flow.band-song-cover.cover--2"
		>
			<span className={styles.lettering} data-flx="activities.band.flow.band-song-cover.lettering">
				<span className={styles.title} data-flx="activities.band.flow.band-song-cover.title">
					{song.name}
				</span>
				{showArtist && (
					<span className={styles.artist} data-flx="activities.band.flow.band-song-cover.artist">
						{song.artist}
					</span>
				)}
			</span>
			<span className={styles.lanes} data-flx="activities.band.flow.band-song-cover.lanes">
				{LANES.map((lane) => (
					<i key={lane} className={styles[lane]} data-flx="activities.band.flow.band-song-cover.lane" />
				))}
			</span>
		</div>
	);
}
