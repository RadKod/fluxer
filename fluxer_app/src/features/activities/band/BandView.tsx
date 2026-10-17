// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import {
	LIBRARY_FAILED_TITLE_DESCRIPTOR,
	LIBRARY_FAILURE_DESCRIPTORS,
	LIBRARY_LOADING_DESCRIPTOR,
	ROOM_LOADING_DESCRIPTOR,
	SONG_DOWNLOADING_DESCRIPTOR,
	SONG_FAILED_DESCRIPTOR,
	SONG_PREPARING_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import {type BandRoom, getBandRoom} from '@app/features/activities/band/flow/BandRoom';
import {BandPlayStage} from '@app/features/activities/band/flow/components/BandPlayStage';
import {BandNotice, BandStage} from '@app/features/activities/band/flow/components/BandStage';
import {ResultsScreen} from '@app/features/activities/band/flow/components/ResultsScreen';
import {SelectScreen} from '@app/features/activities/band/flow/components/SelectScreen';
import {VoteScreen} from '@app/features/activities/band/flow/components/VoteScreen';
import type {ActivityViewProps} from '@app/features/activities/registry/ActivityDefinition';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

type PlayState = Extract<BandState, {phase: 'play'}>;

const SongPackageGate = observer(function SongPackageGate({
	room,
	state,
	song,
}: {
	readonly room: BandRoom;
	readonly state: PlayState;
	readonly song: BandSongSummary;
}) {
	const {i18n} = useLingui();
	const loaded = room.songPackage?.songId === song.id ? room.songPackage : null;
	if (loaded?.status === 'ready') {
		return (
			<BandPlayStage
				room={room}
				state={state}
				song={song}
				songPackage={loaded.songPackage}
				data-flx="activities.band.band-view.song-package-gate.band-play-stage"
			/>
		);
	}
	if (loaded?.status === 'failed') {
		return (
			<BandNotice
				title={i18n._(SONG_FAILED_DESCRIPTOR)}
				message={i18n._(LIBRARY_FAILURE_DESCRIPTORS[loaded.reason])}
				onRetry={() => room.retrySongPackage()}
				data-flx="activities.band.band-view.song-package-gate.band-notice"
			/>
		);
	}
	const download = room.library.download(song.id);
	const message =
		download?.status === 'downloading' && download.totalBytes > 0
			? i18n._(SONG_DOWNLOADING_DESCRIPTOR, {
					percent: Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100)),
				})
			: i18n._(SONG_PREPARING_DESCRIPTOR);
	return <BandNotice message={message} busy data-flx="activities.band.band-view.song-package-gate.band-notice--2" />;
});

const BandPhaseView = observer(function BandPhaseView({room}: {readonly room: BandRoom}) {
	const {i18n} = useLingui();
	const {state, library} = room;
	if (library.status.status === 'failed') {
		const {reason} = library.status;
		return (
			<BandNotice
				title={i18n._(LIBRARY_FAILED_TITLE_DESCRIPTOR)}
				message={i18n._(LIBRARY_FAILURE_DESCRIPTORS[reason])}
				onRetry={() => void library.load()}
				data-flx="activities.band.band-view.band-phase-view.band-notice"
			/>
		);
	}
	if (!state)
		return (
			<BandNotice
				message={i18n._(ROOM_LOADING_DESCRIPTOR)}
				busy
				data-flx="activities.band.band-view.band-phase-view.band-notice--2"
			/>
		);
	if (library.status.status !== 'ready')
		return (
			<BandNotice
				message={i18n._(LIBRARY_LOADING_DESCRIPTOR)}
				busy
				data-flx="activities.band.band-view.band-phase-view.band-notice--3"
			/>
		);
	if (state.phase === 'vote')
		return <VoteScreen room={room} state={state} data-flx="activities.band.band-view.band-phase-view.vote-screen" />;

	const song = library.song(state.songId);
	if (!song)
		return (
			<BandNotice
				message={i18n._(LIBRARY_FAILURE_DESCRIPTORS.unknownSong)}
				data-flx="activities.band.band-view.band-phase-view.band-notice--4"
			/>
		);
	switch (state.phase) {
		case 'select':
			return (
				<SelectScreen
					room={room}
					state={state}
					song={song}
					data-flx="activities.band.band-view.band-phase-view.select-screen"
				/>
			);
		case 'play':
			return (
				<SongPackageGate
					room={room}
					state={state}
					song={song}
					data-flx="activities.band.band-view.band-phase-view.song-package-gate"
				/>
			);
		case 'results':
			return (
				<ResultsScreen
					room={room}
					state={state}
					song={song}
					data-flx="activities.band.band-view.band-phase-view.results-screen"
				/>
			);
	}
});

// Bir Daha Baştan: the screen for whichever step the room is in. The room itself lives on when the panel closes.
export const BandView = observer(function BandView({session}: ActivityViewProps) {
	const {i18n} = useLingui();
	// The room starts the leader loop and writes shared state, so it is picked up after render, never during it.
	const [room, setRoom] = useState<BandRoom | null>(null);
	useEffect(() => setRoom(getBandRoom(session)), [session]);
	return (
		<BandStage phase={room?.state?.phase ?? null} data-flx="activities.band.band-view.band-stage">
			{room ? (
				<BandPhaseView room={room} data-flx="activities.band.band-view.band-phase-view" />
			) : (
				<BandNotice message={i18n._(ROOM_LOADING_DESCRIPTOR)} busy data-flx="activities.band.band-view.band-notice" />
			)}
		</BandStage>
	);
});
