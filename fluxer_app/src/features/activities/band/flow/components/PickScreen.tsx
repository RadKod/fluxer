// SPDX-License-Identifier: AGPL-3.0-or-later

import {BAND_PHASE_MS, type BandSongSummary, type BandState} from '@app/features/activities/band/BandProtocol';
import {tallyVotes} from '@app/features/activities/band/BandVotes';
import {
	PART_INTENSITY_DESCRIPTOR,
	PICK_ALL_SONGS_DESCRIPTOR,
	PICK_COUNTDOWN_DESCRIPTOR,
	PICK_HINT_DESCRIPTOR,
	PICK_KEYS_DESCRIPTOR,
	PICK_LIBRARY_EMPTY_DESCRIPTOR,
	PICK_NO_MATCH_DESCRIPTOR,
	PICK_SEARCH_DESCRIPTOR,
	PICK_SUGGESTIONS_DESCRIPTOR,
	PICK_TITLE_DESCRIPTOR,
	PICK_VOTED_DESCRIPTOR,
	PLAY_NOW_DESCRIPTOR,
	partDescriptor,
	SONG_PLAYERS_DESCRIPTOR,
	VOTE_COUNT_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {songPlayableParts} from '@app/features/activities/band/flow/BandRoomMachine';
import {searchSongs} from '@app/features/activities/band/flow/BandSongSearch';
import {BandPartIcon} from '@app/features/activities/band/flow/components/BandPartIcon';
import {BandAvatar} from '@app/features/activities/band/flow/components/BandPeople';
import {BandSongCover} from '@app/features/activities/band/flow/components/BandSongCover';
import {BandTimer} from '@app/features/activities/band/flow/components/BandTimer';
import styles from '@app/features/activities/band/flow/components/PickScreen.module.css';
import {formatSongLength, secondsUntil, useBandNow} from '@app/features/activities/band/flow/components/useBandNow';
import {Scroller} from '@app/features/ui/components/Scroller';
import {useLingui} from '@lingui/react/macro';
import {MagnifyingGlassIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useId, useRef, useState} from 'react';

type PickState = Extract<BandState, {phase: 'pick'}>;

const VOTERS_SHOWN = 4;

interface Section {
	readonly key: string;
	readonly title: string | null;
	readonly songs: ReadonlyArray<BandSongSummary>;
}

interface SongRowProps {
	readonly room: BandRoom;
	readonly song: BandSongSummary;
	readonly id: string;
	readonly active: boolean;
	readonly voterIds: ReadonlyArray<string>;
	readonly onHover?: () => void;
	readonly onVote: () => void;
	// Set for the leader on a voted song: skips the countdown.
	readonly onPlayNow?: () => void;
}

const SongRow = observer(function SongRow({
	room,
	song,
	id,
	active,
	voterIds,
	onHover,
	onVote,
	onPlayNow,
}: SongRowProps) {
	const {i18n} = useLingui();
	const rowRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (active) rowRef.current?.scrollIntoView({block: 'nearest'});
	}, [active]);
	const parts = songPlayableParts(song);
	const mine = voterIds.includes(room.myUserId);
	return (
		<div
			ref={rowRef}
			className={clsx(styles.row, active && styles.rowActive, mine && styles.rowMine)}
			data-flx="activities.band.flow.pick-screen.song-row.row"
		>
			<button
				id={id}
				type="button"
				role="option"
				tabIndex={-1}
				aria-selected={active}
				className={styles.rowButton}
				onMouseMove={onHover}
				// The search box keeps the focus, so typing and the arrow keys go on working after a click.
				onMouseDown={(event) => event.preventDefault()}
				onClick={onVote}
				data-flx="activities.band.flow.pick-screen.song-row.row-button.vote"
			>
				<BandSongCover
					song={song}
					sizeRem={2.5}
					showArtist={false}
					data-flx="activities.band.flow.pick-screen.song-row.band-song-cover"
				/>
				<span className={styles.text} data-flx="activities.band.flow.pick-screen.song-row.text">
					<b data-flx="activities.band.flow.pick-screen.song-row.b">{song.name}</b>
					<span data-flx="activities.band.flow.pick-screen.song-row.span">{song.artist}</span>
				</span>
				<span className={styles.parts} data-flx="activities.band.flow.pick-screen.song-row.parts">
					{parts.map((part) => {
						const partName = i18n._(partDescriptor(part, song));
						const level = room.library.partIntensity(song.id, part);
						return (
							<span
								key={part}
								title={level === null ? partName : i18n._(PART_INTENSITY_DESCRIPTOR, {part: partName, level})}
								data-flx="activities.band.flow.pick-screen.song-row.part"
							>
								<BandPartIcon
									part={part}
									className={styles.partIcon}
									data-flx="activities.band.flow.pick-screen.song-row.part-icon"
								/>
							</span>
						);
					})}
				</span>
				<span className={styles.voters} data-flx="activities.band.flow.pick-screen.song-row.voters">
					{voterIds.slice(0, VOTERS_SHOWN).map((userId) => (
						<BandAvatar
							key={userId}
							userId={userId}
							size={20}
							className={styles.voter}
							data-flx="activities.band.flow.pick-screen.song-row.voter"
						/>
					))}
					{voterIds.length > 0 && (
						<span className={styles.voteCount} data-flx="activities.band.flow.pick-screen.song-row.vote-count">
							{i18n._(VOTE_COUNT_DESCRIPTOR, {count: voterIds.length})}
						</span>
					)}
				</span>
				<span className={styles.players} data-flx="activities.band.flow.pick-screen.song-row.players">
					{i18n._(SONG_PLAYERS_DESCRIPTOR, {count: parts.length})}
				</span>
				<span className={styles.length} data-flx="activities.band.flow.pick-screen.song-row.length">
					{formatSongLength(song.lengthMs)}
				</span>
			</button>
			{onPlayNow && (
				<button
					type="button"
					className={styles.playNow}
					onClick={onPlayNow}
					data-flx="activities.band.flow.pick-screen.song-row.play-now.button"
				>
					{i18n._(PLAY_NOW_DESCRIPTOR)}
				</button>
			)}
		</div>
	);
});

interface PickScreenProps {
	readonly room: BandRoom;
	readonly state: PickState;
}

// The first step of a round: anyone searches the library and votes; the first vote starts a short countdown, then the
// most voted song goes to part picking.
export const PickScreen = observer(function PickScreen({room, state}: PickScreenProps) {
	const {i18n} = useLingui();
	const listId = useId();
	const searchRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState('');
	const [activeIndex, setActiveIndex] = useState(0);
	const now = useBandNow(room.session);
	useEffect(() => searchRef.current?.focus(), []);

	const library = room.library.songs;
	const tally = tallyVotes(state.votes);
	const votersOf = new Map(tally.map((entry) => [entry.songId, entry.voterIds]));
	const songsOf = (songIds: ReadonlyArray<string>) =>
		songIds.map((songId) => room.library.song(songId)).filter((song): song is BandSongSummary => song !== undefined);
	const votedSongs = songsOf(tally.map((entry) => entry.songId));
	const sections: ReadonlyArray<Section> = query.trim()
		? [{key: 'results', title: null, songs: searchSongs(library, query)}]
		: [
				{key: 'suggestions', title: i18n._(PICK_SUGGESTIONS_DESCRIPTOR), songs: songsOf(state.suggestions)},
				{key: 'all', title: i18n._(PICK_ALL_SONGS_DESCRIPTOR), songs: library},
			];
	const rows = sections.flatMap((section) => section.songs);
	const sectionStarts = sections.map((_, index) =>
		sections.slice(0, index).reduce((sum, section) => sum + section.songs.length, 0),
	);
	const active = Math.min(activeIndex, Math.max(0, rows.length - 1));
	const rowId = (index: number) => `${listId}-${index}`;
	const vote = (song: BandSongSummary) => room.send({t: 'band.vote', songId: song.id});
	const playNow = (song: BandSongSummary) => room.send({t: 'band.playNow', songId: song.id});

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			setActiveIndex(Math.min(rows.length - 1, Math.max(0, active + step)));
		} else if (event.key === 'Enter' && rows[active]) {
			event.preventDefault();
			vote(rows[active]);
		}
	};

	return (
		<div className={styles.screen} data-flx="activities.band.flow.pick-screen.screen">
			<header data-flx="activities.band.flow.pick-screen.heading">
				<h2 className={styles.title} data-flx="activities.band.flow.pick-screen.title">
					{i18n._(PICK_TITLE_DESCRIPTOR)}
				</h2>
				<p className={styles.hint} data-flx="activities.band.flow.pick-screen.hint">
					{i18n._(PICK_HINT_DESCRIPTOR)}
				</p>
			</header>
			<div className={styles.searchRow} data-flx="activities.band.flow.pick-screen.search-row">
				<MagnifyingGlassIcon
					size={18}
					weight="bold"
					className={styles.searchIcon}
					data-flx="activities.band.flow.pick-screen.search-icon"
				/>
				<input
					ref={searchRef}
					className={styles.search}
					type="search"
					role="combobox"
					aria-expanded="true"
					aria-controls={listId}
					aria-activedescendant={rows.length > 0 ? rowId(active) : undefined}
					aria-label={i18n._(PICK_SEARCH_DESCRIPTOR)}
					placeholder={i18n._(PICK_SEARCH_DESCRIPTOR)}
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setActiveIndex(0);
					}}
					onKeyDown={onKeyDown}
					data-flx="activities.band.flow.pick-screen.search.key-down"
				/>
				<span className={styles.keys} data-flx="activities.band.flow.pick-screen.keys">
					{i18n._(PICK_KEYS_DESCRIPTOR)}
				</span>
			</div>
			{state.endsAt !== null && (
				<BandTimer
					endsAt={state.endsAt}
					durationMs={BAND_PHASE_MS.pick}
					now={now}
					showSeconds={false}
					className={styles.countdown}
					data-flx="activities.band.flow.pick-screen.countdown"
				>
					<span className={styles.countdownText} data-flx="activities.band.flow.pick-screen.countdown-text">
						{i18n._(PICK_COUNTDOWN_DESCRIPTOR, {seconds: secondsUntil(state.endsAt, now)})}
					</span>
				</BandTimer>
			)}
			{votedSongs.length > 0 && (
				<section
					className={styles.votedSection}
					aria-label={i18n._(PICK_VOTED_DESCRIPTOR)}
					data-flx="activities.band.flow.pick-screen.voted-section"
				>
					<h3 className={styles.sectionTitle} data-flx="activities.band.flow.pick-screen.voted-title">
						{i18n._(PICK_VOTED_DESCRIPTOR)}
					</h3>
					<div className={styles.rows} data-flx="activities.band.flow.pick-screen.voted-rows">
						{votedSongs.map((song) => (
							<SongRow
								key={song.id}
								room={room}
								song={song}
								id={`${listId}-voted-${song.id}`}
								active={false}
								voterIds={votersOf.get(song.id) ?? []}
								onVote={() => vote(song)}
								onPlayNow={room.session.isLeader ? () => playNow(song) : undefined}
								data-flx="activities.band.flow.pick-screen.voted-row"
							/>
						))}
					</div>
				</section>
			)}
			{rows.length === 0 ? (
				<p className={styles.empty} data-flx="activities.band.flow.pick-screen.empty">
					{i18n._(library.length === 0 ? PICK_LIBRARY_EMPTY_DESCRIPTOR : PICK_NO_MATCH_DESCRIPTOR)}
				</p>
			) : (
				<Scroller className={styles.scroller} fade={false} data-flx="activities.band.flow.pick-screen.scroller">
					<div
						id={listId}
						role="listbox"
						aria-label={i18n._(PICK_TITLE_DESCRIPTOR)}
						className={styles.list}
						data-flx="activities.band.flow.pick-screen.list"
					>
						{sections.map((section, sectionIndex) => {
							const start = sectionStarts[sectionIndex];
							if (section.songs.length === 0) return null;
							return (
								<div
									key={section.key}
									role="group"
									aria-label={section.title ?? undefined}
									data-flx="activities.band.flow.pick-screen.section"
								>
									{section.title && (
										<h3 className={styles.sectionTitle} data-flx="activities.band.flow.pick-screen.section-title">
											{section.title}
										</h3>
									)}
									<div className={styles.rows} data-flx="activities.band.flow.pick-screen.rows">
										{section.songs.map((song, index) => (
											<SongRow
												key={song.id}
												room={room}
												song={song}
												id={rowId(start + index)}
												active={start + index === active}
												voterIds={votersOf.get(song.id) ?? []}
												onHover={() => setActiveIndex(start + index)}
												onVote={() => vote(song)}
												data-flx="activities.band.flow.pick-screen.song-row"
											/>
										))}
									</div>
								</div>
							);
						})}
					</div>
				</Scroller>
			)}
		</div>
	);
});
