// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import styles from '@app/features/activities/band/flow/components/BandSongCover.module.css';
import {clsx} from 'clsx';
import {useState} from 'react';

// Deep tints for songs without album art; the song id picks one, so a song always looks the same.
const FALLBACK_TINTS = ['#173230', '#3A1F18', '#1B2A2C', '#2A1B33', '#33291A', '#1A2438', '#2E1A22'];

function tintFor(songId: string): string {
	let hash = 0;
	for (let i = 0; i < songId.length; i++) hash = (hash * 31 + songId.charCodeAt(i)) | 0;
	return FALLBACK_TINTS[Math.abs(hash) % FALLBACK_TINTS.length];
}

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
			style={{width: size, height: size, backgroundColor: tintFor(song.id)}}
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
		</div>
	);
}
