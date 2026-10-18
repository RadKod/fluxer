// SPDX-License-Identifier: AGPL-3.0-or-later

import {BAND_PHASE_MS, type BandSongSummary, type BandState} from '@app/features/activities/band/BandProtocol';
import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import {
	ADD_TO_QUEUE_DESCRIPTOR,
	DOWNLOAD_FAILED_DESCRIPTOR,
	DOWNLOAD_QUEUED_DESCRIPTOR,
	DOWNLOADED_DESCRIPTOR,
	DOWNLOADING_DESCRIPTOR,
	LEADING_DESCRIPTOR,
	MY_VOTE_DESCRIPTOR,
	PART_INTENSITY_DESCRIPTOR,
	PART_MISSING_DESCRIPTOR,
	PART_MISSING_SHORT_DESCRIPTOR,
	partDescriptor,
	QUEUE_ENTRY_DESCRIPTOR,
	SONG_PLAYERS_DESCRIPTOR,
	UP_NEXT_DESCRIPTOR,
	VOTE_COUNT_DESCRIPTOR,
	VOTE_EMPTY_DESCRIPTOR,
	VOTE_FOR_DESCRIPTOR,
	VOTE_HINT_DESCRIPTOR,
	VOTE_KEYS_DESCRIPTOR,
	VOTE_TALLY_DESCRIPTOR,
	VOTE_TITLE_DESCRIPTOR,
	VOTE_WAITING_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {rankCandidates, songPartDifficulties, voteCounts} from '@app/features/activities/band/flow/BandRoomMachine';
import type {BandSongDownload} from '@app/features/activities/band/flow/BandSongLibrary';
import {BandPartIcon} from '@app/features/activities/band/flow/components/BandPartIcon';
import {BandAvatar, bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import {BandSongCover} from '@app/features/activities/band/flow/components/BandSongCover';
import {BandNotice} from '@app/features/activities/band/flow/components/BandStage';
import {BandTimer} from '@app/features/activities/band/flow/components/BandTimer';
import {SongPicker} from '@app/features/activities/band/flow/components/SongPicker';
import {useBandKeys} from '@app/features/activities/band/flow/components/useBandKeys';
import {formatSongLength, useBandNow} from '@app/features/activities/band/flow/components/useBandNow';
import styles from '@app/features/activities/band/flow/components/VoteScreen.module.css';
import {useLingui} from '@lingui/react/macro';
import {CheckIcon, DownloadSimpleIcon, PlusIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useRef, useState} from 'react';

type VoteState = Extract<BandState, {phase: 'vote'}>;

const VOTE_KEYS = ['a', 's', 'd'] as const;
const KEY_CAP_CLASSES = [styles.keyGreen, styles.keyRed, styles.keyYellow];
const CARD_PARTS: ReadonlyArray<BandPart> = ['guitar', 'rhythm', 'bass', 'drums', 'keys', 'vocals'];
// Rhythm guitar and keys only show up on the card when the song has them; the others always do, so a missing part
// reads as missing.
const OPTIONAL_CARD_PARTS: ReadonlySet<BandPart> = new Set(['rhythm', 'keys']);
const QUEUE_PREVIEW = 2;
const INTENSITY_CELLS = 5;

function KeyCap({index, className}: {readonly index: number; readonly className?: string}) {
	return (
		<span
			className={clsx(styles.keyCap, KEY_CAP_CLASSES[index], className)}
			aria-hidden="true"
			data-flx="activities.band.flow.vote-screen.key-cap.key-cap"
		>
			{VOTE_KEYS[index].toUpperCase()}
		</span>
	);
}

const DownloadStatus = observer(function DownloadStatus({download}: {readonly download: BandSongDownload | undefined}) {
	const {i18n} = useLingui();
	if (!download) return null;
	switch (download.status) {
		case 'cached':
			return (
				<span className={styles.download} data-flx="activities.band.flow.vote-screen.download-status.download">
					<CheckIcon
						weight="bold"
						className={styles.downloadIcon}
						data-flx="activities.band.flow.vote-screen.download-status.download-icon"
					/>
					{i18n._(DOWNLOADED_DESCRIPTOR)}
				</span>
			);
		case 'downloading': {
			const percent =
				download.totalBytes > 0 ? Math.min(100, Math.floor((download.receivedBytes / download.totalBytes) * 100)) : 0;
			return (
				<span className={styles.download} data-flx="activities.band.flow.vote-screen.download-status.download--2">
					<DownloadSimpleIcon
						weight="bold"
						className={styles.downloadIcon}
						data-flx="activities.band.flow.vote-screen.download-status.download-icon--2"
					/>
					{i18n._(DOWNLOADING_DESCRIPTOR, {percent})}
				</span>
			);
		}
		case 'queued':
			return (
				<span className={styles.download} data-flx="activities.band.flow.vote-screen.download-status.download--3">
					<DownloadSimpleIcon
						weight="bold"
						className={styles.downloadIcon}
						data-flx="activities.band.flow.vote-screen.download-status.download-icon--3"
					/>
					{i18n._(DOWNLOAD_QUEUED_DESCRIPTOR)}
				</span>
			);
		case 'failed':
			return (
				<span
					className={clsx(styles.download, styles.downloadFailed)}
					data-flx="activities.band.flow.vote-screen.download-status.download--4"
				>
					{i18n._(DOWNLOAD_FAILED_DESCRIPTOR)}
				</span>
			);
	}
});

// One player per charted part: lead, rhythm, bass, drums, keys and vocals each take a seat.
function songPlayerCount(song: BandSongSummary): number {
	return Object.values(song.parts).filter((difficulties) => (difficulties?.length ?? 0) > 0).length;
}

const PartsRow = observer(function PartsRow({room, song}: {readonly room: BandRoom; readonly song: BandSongSummary}) {
	const {i18n} = useLingui();
	const parts = CARD_PARTS.filter(
		(part) => !OPTIONAL_CARD_PARTS.has(part) || songPartDifficulties(song, part).length > 0,
	);
	return (
		<div className={styles.parts} data-flx="activities.band.flow.vote-screen.parts-row.parts">
			{parts.map((part) => {
				const partName = i18n._(partDescriptor(part, song));
				if (songPartDifficulties(song, part).length === 0) {
					return (
						<span
							key={part}
							className={clsx(styles.part, styles.partMissing)}
							title={i18n._(PART_MISSING_DESCRIPTOR, {part: partName})}
							data-flx="activities.band.flow.vote-screen.parts-row.part"
						>
							<BandPartIcon
								part={part}
								className={styles.partIcon}
								data-flx="activities.band.flow.vote-screen.parts-row.part-icon"
							/>
							<small data-flx="activities.band.flow.vote-screen.parts-row.small">
								{i18n._(PART_MISSING_SHORT_DESCRIPTOR)}
							</small>
						</span>
					);
				}
				const level = room.library.partIntensity(song.id, part);
				return (
					<span
						key={part}
						className={styles.part}
						title={level === null ? partName : i18n._(PART_INTENSITY_DESCRIPTOR, {part: partName, level})}
						data-flx="activities.band.flow.vote-screen.parts-row.part--2"
					>
						<BandPartIcon
							part={part}
							className={styles.partIcon}
							data-flx="activities.band.flow.vote-screen.parts-row.part-icon--2"
						/>
						{level !== null && (
							<span
								className={styles.cells}
								aria-hidden="true"
								data-flx="activities.band.flow.vote-screen.parts-row.cells"
							>
								{Array.from({length: INTENSITY_CELLS}, (_, cell) => (
									<i
										key={cell}
										className={clsx(styles.cell, cell < level && styles.cellFilled)}
										data-flx="activities.band.flow.vote-screen.parts-row.cell"
									/>
								))}
							</span>
						)}
					</span>
				);
			})}
		</div>
	);
});

interface SongCardProps {
	readonly room: BandRoom;
	readonly song: BandSongSummary;
	readonly index: number;
	readonly voters: ReadonlyArray<string>;
	readonly leading: boolean;
	readonly mine: boolean;
	readonly onVote: () => void;
}

const SongCard = observer(function SongCard({room, song, index, voters, leading, mine, onVote}: SongCardProps) {
	const {i18n} = useLingui();
	return (
		<article
			className={clsx(styles.card, mine && styles.cardMine)}
			data-flx="activities.band.flow.vote-screen.song-card.card"
		>
			<button
				type="button"
				className={styles.cardButton}
				onClick={onVote}
				aria-pressed={mine}
				aria-label={i18n._(VOTE_FOR_DESCRIPTOR, {song: song.name})}
				data-flx="activities.band.flow.vote-screen.song-card.card-button.vote"
			/>
			<div className={styles.coverWrap} data-flx="activities.band.flow.vote-screen.song-card.cover-wrap">
				<BandSongCover
					song={song}
					className={styles.cover}
					data-flx="activities.band.flow.vote-screen.song-card.cover"
				/>
				<KeyCap
					index={index}
					className={styles.coverKey}
					data-flx="activities.band.flow.vote-screen.song-card.cover-key"
				/>
				{leading && (
					<span
						className={styles.leading}
						title={i18n._(LEADING_DESCRIPTOR)}
						data-flx="activities.band.flow.vote-screen.song-card.leading"
					>
						<CheckIcon size={16} weight="bold" data-flx="activities.band.flow.vote-screen.song-card.check-icon" />
					</span>
				)}
				{mine && (
					<span
						className={clsx(styles.mineTag, leading && styles.mineTagShifted)}
						data-flx="activities.band.flow.vote-screen.song-card.mine-tag"
					>
						{i18n._(MY_VOTE_DESCRIPTOR)}
					</span>
				)}
				<div className={styles.voters} data-flx="activities.band.flow.vote-screen.song-card.voters">
					{voters.map((userId) => (
						<BandAvatar
							key={userId}
							userId={userId}
							size={28}
							className={styles.voter}
							data-flx="activities.band.flow.vote-screen.song-card.voter"
						/>
					))}
				</div>
				{voters.length > 0 && (
					<span
						className={clsx(styles.voteCount, styles.num)}
						data-flx="activities.band.flow.vote-screen.song-card.vote-count"
					>
						{i18n._(VOTE_COUNT_DESCRIPTOR, {count: voters.length})}
					</span>
				)}
			</div>
			<div className={styles.meta} data-flx="activities.band.flow.vote-screen.song-card.meta">
				<div className={styles.metaRow} data-flx="activities.band.flow.vote-screen.song-card.meta-row">
					<span className={styles.songName} data-flx="activities.band.flow.vote-screen.song-card.song-name">
						{song.name}
					</span>
					<span
						className={clsx(styles.length, styles.num)}
						data-flx="activities.band.flow.vote-screen.song-card.length"
					>
						{i18n._(SONG_PLAYERS_DESCRIPTOR, {count: songPlayerCount(song)})}, {formatSongLength(song.lengthMs)}
					</span>
				</div>
				<div className={styles.metaRow} data-flx="activities.band.flow.vote-screen.song-card.meta-row--2">
					<span className={styles.artist} data-flx="activities.band.flow.vote-screen.song-card.artist">
						{song.artist}
					</span>
					<DownloadStatus
						download={room.library.download(song.id)}
						data-flx="activities.band.flow.vote-screen.song-card.download-status"
					/>
				</div>
				<PartsRow room={room} song={song} data-flx="activities.band.flow.vote-screen.song-card.parts-row" />
			</div>
		</article>
	);
});

const QueuePreview = observer(function QueuePreview({
	room,
	state,
}: {
	readonly room: BandRoom;
	readonly state: VoteState;
}) {
	const {i18n} = useLingui();
	const upNext = state.queue.filter((entry) => !state.candidates.includes(entry.songId)).slice(0, QUEUE_PREVIEW);
	return (
		<>
			{upNext.length > 0 && (
				<span className={styles.queueLabel} data-flx="activities.band.flow.vote-screen.queue-preview.queue-label">
					{i18n._(UP_NEXT_DESCRIPTOR)}
				</span>
			)}
			{upNext.map((entry) => {
				const song = room.library.song(entry.songId);
				if (!song) return null;
				return (
					<span
						key={entry.songId}
						className={styles.queueItem}
						data-flx="activities.band.flow.vote-screen.queue-preview.queue-item"
					>
						<BandSongCover
							song={song}
							sizeRem={2.25}
							showArtist={false}
							data-flx="activities.band.flow.vote-screen.queue-preview.band-song-cover"
						/>
						<span className={styles.queueText} data-flx="activities.band.flow.vote-screen.queue-preview.queue-text">
							<b data-flx="activities.band.flow.vote-screen.queue-preview.b">{song.name}</b>
							<span data-flx="activities.band.flow.vote-screen.queue-preview.span">
								{i18n._(QUEUE_ENTRY_DESCRIPTOR, {artist: song.artist, name: bandDisplayName(entry.addedBy)})}
							</span>
						</span>
					</span>
				);
			})}
		</>
	);
});

interface VoteScreenProps {
	readonly room: BandRoom;
	readonly state: VoteState;
}

export const VoteScreen = observer(function VoteScreen({room, state}: VoteScreenProps) {
	const {i18n} = useLingui();
	const rootRef = useRef<HTMLDivElement>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const now = useBandNow(room.session);
	const myVote = state.votes[room.myUserId];
	const vote = (songId: string) => room.send({t: 'band.vote', songId});

	useBandKeys(rootRef, (key, event) => {
		const index = VOTE_KEYS.indexOf(key as (typeof VOTE_KEYS)[number]);
		const songId = state.candidates[index];
		if (pickerOpen || !songId) return;
		event.preventDefault();
		vote(songId);
	});

	const counts = voteCounts(state);
	const [leader] = rankCandidates(state);
	const leaderVotes = leader ? (counts.get(leader) ?? 0) : 0;
	const roomSize = new Set(room.session.participants.map((participant) => participant.userId)).size;
	const songs = state.candidates
		.map((songId) => room.library.song(songId))
		.filter((song): song is BandSongSummary => song !== undefined);

	return (
		<div ref={rootRef} className={styles.screen} data-flx="activities.band.flow.vote-screen.screen">
			<header className={styles.heading} data-flx="activities.band.flow.vote-screen.heading">
				<div data-flx="activities.band.flow.vote-screen.div">
					<h2 className={styles.title} data-flx="activities.band.flow.vote-screen.title">
						{i18n._(VOTE_TITLE_DESCRIPTOR)}
					</h2>
					<p className={styles.hint} data-flx="activities.band.flow.vote-screen.hint">
						{i18n._(VOTE_HINT_DESCRIPTOR)}
					</p>
				</div>
				<span className={clsx(styles.tally, styles.num)} data-flx="activities.band.flow.vote-screen.tally">
					{i18n._(VOTE_TALLY_DESCRIPTOR, {voted: Object.keys(state.votes).length, total: roomSize})}
				</span>
			</header>
			{songs.length === 0 ? (
				<BandNotice message={i18n._(VOTE_EMPTY_DESCRIPTOR)} data-flx="activities.band.flow.vote-screen.band-notice" />
			) : (
				<div className={styles.cards} data-flx="activities.band.flow.vote-screen.cards">
					{songs.map((song, index) => (
						<SongCard
							key={song.id}
							room={room}
							song={song}
							index={index}
							voters={Object.keys(state.votes).filter((userId) => state.votes[userId] === song.id)}
							leading={leaderVotes > 0 && song.id === leader}
							mine={myVote === song.id}
							onVote={() => vote(song.id)}
							data-flx="activities.band.flow.vote-screen.song-card"
						/>
					))}
				</div>
			)}
			<BandTimer
				endsAt={state.endsAt}
				waitingLabel={i18n._(VOTE_WAITING_DESCRIPTOR)}
				durationMs={BAND_PHASE_MS.vote}
				now={now}
				className={styles.timer}
				data-flx="activities.band.flow.vote-screen.timer"
			>
				{songs.length > 0 && (
					<span className={styles.keys} data-flx="activities.band.flow.vote-screen.keys">
						{i18n._(VOTE_KEYS_DESCRIPTOR)}
						{songs.map((song, index) => (
							<KeyCap
								key={song.id}
								index={index}
								className={styles.smallKey}
								data-flx="activities.band.flow.vote-screen.small-key"
							/>
						))}
					</span>
				)}
			</BandTimer>
			<footer className={styles.queue} data-flx="activities.band.flow.vote-screen.queue">
				<QueuePreview room={room} state={state} data-flx="activities.band.flow.vote-screen.queue-preview" />
				<button
					type="button"
					className={styles.addButton}
					onClick={() => setPickerOpen(true)}
					data-flx="activities.band.flow.vote-screen.add-button.set-picker-open"
				>
					<PlusIcon weight="bold" className={styles.addIcon} data-flx="activities.band.flow.vote-screen.add-icon" />
					{i18n._(ADD_TO_QUEUE_DESCRIPTOR)}
				</button>
			</footer>
			{pickerOpen && (
				<SongPicker
					room={room}
					queue={state.queue}
					onClose={() => setPickerOpen(false)}
					onPlayNow={room.session.isLeader ? (songId) => room.send({t: 'band.playNow', songId}) : undefined}
					data-flx="activities.band.flow.vote-screen.song-picker"
				/>
			)}
		</div>
	);
});
