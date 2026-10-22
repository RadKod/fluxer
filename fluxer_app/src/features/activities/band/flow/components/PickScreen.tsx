// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import {tallyVotes} from '@app/features/activities/band/BandVotes';
import {
	GENRE_GROUP_DESCRIPTORS,
	PICK_LIBRARY_EMPTY_DESCRIPTOR,
	PICK_NO_MATCH_DESCRIPTOR,
	PICK_PREVIEW_HINT_DESCRIPTOR,
	PICK_RANDOM_DESCRIPTOR,
	PICK_RANDOM_HINT_DESCRIPTOR,
	PICK_SEARCH_DESCRIPTOR,
	PICK_SONG_COUNT_DESCRIPTOR,
	PICK_TITLE_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import {myVoteSongId, votePanel} from '@app/features/activities/band/flow/BandPickModel';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {
	type BandSongFilter,
	filterSongs,
	groupCounts,
	NO_SONG_FILTER,
	randomSong,
} from '@app/features/activities/band/flow/BandSongFilters';
import {BandSongPreview} from '@app/features/activities/band/flow/BandSongPreview';
import {BandModeSwitch} from '@app/features/activities/band/flow/components/BandModeSwitch';
import {PickGenreRail} from '@app/features/activities/band/flow/components/PickGenreRail';
import styles from '@app/features/activities/band/flow/components/PickScreen.module.css';
import {PickSongGrid} from '@app/features/activities/band/flow/components/PickSongGrid';
import {type BandPreviewLabel, PickSongPanel} from '@app/features/activities/band/flow/components/PickSongPanel';
import {useBandNow} from '@app/features/activities/band/flow/components/useBandNow';
import BandSettings from '@app/features/activities/band/game/BandSettings';
import ActivityViewDock from '@app/features/activities/components/ActivityViewDock';
import {Scroller} from '@app/features/ui/components/Scroller';
import {useLingui} from '@lingui/react/macro';
import {MagnifyingGlassIcon, ShuffleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';

type PickState = Extract<BandState, {phase: 'pick'}>;

// A pointer resting this long on a card starts its preview; sweeping across the grid starts none.
const HOVER_PREVIEW_DELAY_MS = 350;
// Arrow keys held down step through many cards; only the one they stop on plays.
const SELECT_PREVIEW_DELAY_MS = 200;

// Plays the hovered card's preview, else the selected one's, only while the screen is on the expanded stage (the
// tile and the mini window show the summary in this step, and the View may be parked out of sight). Stops with the
// screen, so it never outlives the pick step.
function usePickPreview(room: BandRoom, hovered: BandSongSummary | null, selected: BandSongSummary | null) {
	const [preview] = useState(() => new BandSongPreview({library: room.library, volume: () => BandSettings.volume}));
	useEffect(() => () => preview.stop(), [preview]);
	const target = hovered ?? selected;
	const onStage = ActivityViewDock.placement === 'stage';
	const onDevice = target ? room.library.isOnDevice(target.id) : false;
	useEffect(() => {
		if (!target || !onStage || !onDevice) {
			preview.stop();
			return;
		}
		const timer = setTimeout(
			() => preview.play(target),
			target === hovered ? HOVER_PREVIEW_DELAY_MS : SELECT_PREVIEW_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [preview, target, hovered, onStage, onDevice]);
	return preview;
}

function previewLabel(room: BandRoom, preview: BandSongPreview, song: BandSongSummary | null): BandPreviewLabel {
	if (!song) return null;
	if (preview.state.status === 'playing' && preview.state.songId === song.id) return 'playing';
	return room.library.download(song.id)?.status === 'downloading' ? 'downloading' : null;
}

interface PickScreenProps {
	readonly room: BandRoom;
	readonly state: PickState;
}

// The first step of a round: browse the library by genre and era, hear a preview, vote. The first vote starts a short
// countdown, then the most voted song goes to part picking.
export const PickScreen = observer(function PickScreen({room, state}: PickScreenProps) {
	const {i18n} = useLingui();
	const searchRef = useRef<HTMLInputElement>(null);
	const gridRef = useRef<HTMLDivElement>(null);
	const [filter, setFilter] = useState<BandSongFilter>(NO_SONG_FILTER);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [hovered, setHovered] = useState<BandSongSummary | null>(null);
	const now = useBandNow(room.session);
	useEffect(() => gridRef.current?.focus({preventScroll: true}), []);

	const library = room.library.songs;
	const songs = useMemo(() => filterSongs(library, filter), [library, filter]);
	const counts = useMemo(() => groupCounts(library, filter), [library, filter]);
	// A song chosen from the vote list stays chosen even when the shelves do not show it.
	const selected = (selectedId ? room.library.song(selectedId) : undefined) ?? songs[0] ?? null;
	const preview = usePickPreview(room, hovered, selected);
	const myVoteId = myVoteSongId(state.votes, room.myUserId);
	const votersOf = new Map(tallyVotes(state.votes).map((entry) => [entry.songId, entry.voterIds]));
	const panel = votePanel(state, room.myUserId, room.session.isLeader, now);
	const anyPreviewable = songs.some((song) => room.library.isOnDevice(song.id));

	const vote = (song: BandSongSummary) => room.send({t: 'band.vote', songId: song.id});
	const select = (song: BandSongSummary) => setSelectedId(song.id);
	const voteRandom = () => {
		const song = randomSong(songs, myVoteId);
		if (!song) return;
		select(song);
		if (song.id !== myVoteId) vote(song);
	};
	const changeFilter = (patch: Partial<BandSongFilter>) => setFilter((current) => ({...current, ...patch}));

	const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			gridRef.current?.focus({preventScroll: true});
		} else if (event.key === 'Enter' && selected) {
			event.preventDefault();
			vote(selected);
		} else if (event.key === 'Escape' && filter.query) {
			event.preventDefault();
			changeFilter({query: ''});
		}
	};

	return (
		<div className={styles.screen} data-flx="activities.band.flow.pick-screen.screen">
			<header className={styles.header} data-flx="activities.band.flow.pick-screen.header">
				<BandModeSwitch room={room} mode="songs" data-flx="activities.band.flow.pick-screen.band-mode-switch" />
				<h2 className={styles.title} data-flx="activities.band.flow.pick-screen.title">
					{i18n._(PICK_TITLE_DESCRIPTOR)}
				</h2>
				<label className={styles.search} data-flx="activities.band.flow.pick-screen.search">
					<MagnifyingGlassIcon
						size={16}
						weight="bold"
						className={styles.searchIcon}
						aria-hidden="true"
						data-flx="activities.band.flow.pick-screen.search-icon"
					/>
					<input
						ref={searchRef}
						type="search"
						aria-label={i18n._(PICK_SEARCH_DESCRIPTOR)}
						placeholder={i18n._(PICK_SEARCH_DESCRIPTOR)}
						value={filter.query}
						onChange={(event) => changeFilter({query: event.target.value})}
						onKeyDown={onSearchKeyDown}
						data-flx="activities.band.flow.pick-screen.search-input.key-down"
					/>
				</label>
				<button
					type="button"
					className={styles.random}
					title={i18n._(PICK_RANDOM_HINT_DESCRIPTOR)}
					disabled={songs.length === 0}
					onClick={voteRandom}
					data-flx="activities.band.flow.pick-screen.random.button"
				>
					<ShuffleIcon
						size={16}
						weight="bold"
						aria-hidden="true"
						data-flx="activities.band.flow.pick-screen.random-icon"
					/>
					{i18n._(PICK_RANDOM_DESCRIPTOR)}
				</button>
			</header>
			<div className={styles.body} data-flx="activities.band.flow.pick-screen.body">
				<PickGenreRail
					counts={counts}
					group={filter.group}
					decade={filter.decade}
					onGroup={(group) => changeFilter({group})}
					onDecade={(decade) => changeFilter({decade})}
					data-flx="activities.band.flow.pick-screen.genre-rail"
				/>
				<main className={styles.main} data-flx="activities.band.flow.pick-screen.main">
					<div className={styles.shelf} data-flx="activities.band.flow.pick-screen.shelf">
						<h3 className={styles.shelfTitle} data-flx="activities.band.flow.pick-screen.shelf-title">
							{i18n._(GENRE_GROUP_DESCRIPTORS[filter.group ?? 'all'])}
						</h3>
						<span className={styles.shelfNote} data-flx="activities.band.flow.pick-screen.shelf-note">
							{i18n._(PICK_SONG_COUNT_DESCRIPTOR, {count: songs.length})}
							{anyPreviewable && ` · ${i18n._(PICK_PREVIEW_HINT_DESCRIPTOR)}`}
						</span>
					</div>
					{songs.length === 0 ? (
						<p className={styles.empty} data-flx="activities.band.flow.pick-screen.empty">
							{i18n._(library.length === 0 ? PICK_LIBRARY_EMPTY_DESCRIPTOR : PICK_NO_MATCH_DESCRIPTOR)}
						</p>
					) : (
						<Scroller className={styles.scroller} fade={false} data-flx="activities.band.flow.pick-screen.scroller">
							<PickSongGrid
								songs={songs}
								selectedId={selected?.id ?? null}
								myVoteId={myVoteId}
								previewId={preview.state.status === 'playing' ? preview.state.songId : null}
								votersOf={votersOf}
								listRef={gridRef}
								onSelect={select}
								onVote={vote}
								onHover={setHovered}
								onType={() => searchRef.current?.focus()}
								data-flx="activities.band.flow.pick-screen.song-grid"
							/>
						</Scroller>
					)}
				</main>
				<PickSongPanel
					room={room}
					state={state}
					song={selected}
					panel={panel}
					preview={previewLabel(room, preview, selected)}
					onVote={vote}
					onSelect={select}
					data-flx="activities.band.flow.pick-screen.song-panel"
				/>
			</div>
		</div>
	);
});
