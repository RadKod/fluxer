// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import {
	PICK_SONGS_DESCRIPTOR,
	PREVIEW_PLAYING_DESCRIPTOR,
	VOTE_COUNT_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import {isGridKey, moveInGrid, pickGridColumns} from '@app/features/activities/band/flow/BandPickModel';
import {BandAvatar} from '@app/features/activities/band/flow/components/BandPeople';
import {BandSongCover} from '@app/features/activities/band/flow/components/BandSongCover';
import styles from '@app/features/activities/band/flow/components/PickSongGrid.module.css';
import {useElementSize} from '@app/features/activities/band/flow/components/useElementSize';
import {useLingui} from '@lingui/react/macro';
import {SpeakerHighIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {type RefObject, useEffect, useId, useRef} from 'react';

const VOTERS_SHOWN = 3;

interface SongCardProps {
	readonly song: BandSongSummary;
	readonly id: string;
	readonly selected: boolean;
	readonly mine: boolean;
	readonly previewing: boolean;
	readonly voterIds: ReadonlyArray<string>;
	readonly onSelect: () => void;
	readonly onVote: () => void;
	readonly onHover: () => void;
}

const SongCard = observer(function SongCard({
	song,
	id,
	selected,
	mine,
	previewing,
	voterIds,
	onSelect,
	onVote,
	onHover,
}: SongCardProps) {
	const {i18n} = useLingui();
	const cardRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (selected) cardRef.current?.scrollIntoView({block: 'nearest'});
	}, [selected]);
	return (
		<button
			ref={cardRef}
			id={id}
			type="button"
			role="option"
			tabIndex={-1}
			aria-selected={selected}
			className={clsx(styles.card, selected && styles.cardSelected)}
			onClick={onSelect}
			onDoubleClick={onVote}
			onMouseEnter={onHover}
			data-flx="activities.band.flow.pick-song-grid.song-card.card"
		>
			<span className={styles.art} data-flx="activities.band.flow.pick-song-grid.song-card.art">
				<BandSongCover
					song={song}
					className={styles.cover}
					data-flx="activities.band.flow.pick-song-grid.song-card.cover"
				/>
				{voterIds.length > 0 && (
					<span
						className={clsx(styles.votes, mine && styles.votesMine)}
						title={i18n._(VOTE_COUNT_DESCRIPTOR, {count: voterIds.length})}
						data-flx="activities.band.flow.pick-song-grid.song-card.votes"
					>
						<span className={styles.voters} data-flx="activities.band.flow.pick-song-grid.song-card.voters">
							{voterIds.slice(0, VOTERS_SHOWN).map((userId) => (
								<BandAvatar
									key={userId}
									userId={userId}
									size={20}
									className={styles.voter}
									data-flx="activities.band.flow.pick-song-grid.song-card.voter"
								/>
							))}
						</span>
						{voterIds.length}
					</span>
				)}
				{previewing && (
					<span
						className={styles.previewing}
						title={i18n._(PREVIEW_PLAYING_DESCRIPTOR)}
						data-flx="activities.band.flow.pick-song-grid.song-card.previewing"
					>
						<SpeakerHighIcon size={14} weight="fill" data-flx="activities.band.flow.pick-song-grid.song-card.icon" />
					</span>
				)}
			</span>
			<span className={styles.title} data-flx="activities.band.flow.pick-song-grid.song-card.title">
				{song.name}
			</span>
			<span className={styles.artist} data-flx="activities.band.flow.pick-song-grid.song-card.artist">
				{song.artist}
			</span>
		</button>
	);
});

interface PickSongGridProps {
	readonly songs: ReadonlyArray<BandSongSummary>;
	readonly selectedId: string | null;
	readonly myVoteId: string | null;
	readonly previewId: string | null;
	readonly votersOf: ReadonlyMap<string, ReadonlyArray<string>>;
	readonly listRef: RefObject<HTMLDivElement | null>;
	readonly onSelect: (song: BandSongSummary) => void;
	readonly onVote: (song: BandSongSummary) => void;
	readonly onHover: (song: BandSongSummary | null) => void;
	// A printable key pressed on the grid: the screen moves it to the search box.
	readonly onType: () => void;
}

// The cover grid. It holds the focus as one listbox: the arrows move the selection, Enter votes, typing searches.
export const PickSongGrid = observer(function PickSongGrid({
	songs,
	selectedId,
	myVoteId,
	previewId,
	votersOf,
	listRef,
	onSelect,
	onVote,
	onHover,
	onType,
}: PickSongGridProps) {
	const {i18n} = useLingui();
	const listId = useId();
	const {width} = useElementSize(listRef);
	const columns = pickGridColumns(width);
	const selectedIndex = songs.findIndex((song) => song.id === selectedId);
	const cardId = (song: BandSongSummary) => `${listId}-${song.id}`;

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		if (isGridKey(event.key)) {
			event.preventDefault();
			const next = songs[moveInGrid(selectedIndex, event.key, columns, songs.length)];
			if (next) onSelect(next);
		} else if ((event.key === 'Enter' || event.key === ' ') && songs[selectedIndex]) {
			event.preventDefault();
			onVote(songs[selectedIndex]);
		} else if (event.key.length === 1) {
			onType();
		}
	};

	return (
		<div
			ref={listRef}
			id={listId}
			role="listbox"
			tabIndex={0}
			aria-label={i18n._(PICK_SONGS_DESCRIPTOR)}
			aria-activedescendant={songs[selectedIndex] ? cardId(songs[selectedIndex]) : undefined}
			className={styles.grid}
			style={{gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`}}
			onKeyDown={onKeyDown}
			onMouseLeave={() => onHover(null)}
			data-flx="activities.band.flow.pick-song-grid.grid"
		>
			{songs.map((song) => (
				<SongCard
					key={song.id}
					song={song}
					id={cardId(song)}
					selected={song.id === selectedId}
					mine={song.id === myVoteId}
					previewing={song.id === previewId}
					voterIds={votersOf.get(song.id) ?? []}
					onSelect={() => {
						onSelect(song);
						listRef.current?.focus({preventScroll: true});
					}}
					onVote={() => onVote(song)}
					onHover={() => onHover(song)}
					data-flx="activities.band.flow.pick-song-grid.song-card"
				/>
			))}
		</div>
	);
});
