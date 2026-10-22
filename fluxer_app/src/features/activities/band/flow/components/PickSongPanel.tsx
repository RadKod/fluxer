// SPDX-License-Identifier: AGPL-3.0-or-later

import {BAND_PHASE_MS, type BandSongSummary, type BandState} from '@app/features/activities/band/BandProtocol';
import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import {
	GENRE_GROUP_DESCRIPTORS,
	PART_TIER_DESCRIPTOR,
	PART_UNRATED_DESCRIPTOR,
	PICK_COUNTDOWN_DESCRIPTOR,
	PICK_SELECTED_DESCRIPTOR,
	PICK_WAITING_DESCRIPTOR,
	PLAY_LEADING_NOW_DESCRIPTOR,
	PREVIEW_DOWNLOADING_DESCRIPTOR,
	PREVIEW_PLAYING_DESCRIPTOR,
	partDescriptor,
	UNVOTE_DESCRIPTOR,
	VOTE_DESCRIPTOR,
	VOTES_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import {type BandVotePanel, voteAction} from '@app/features/activities/band/flow/BandPickModel';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {songPlayableParts} from '@app/features/activities/band/flow/BandRoomMachine';
import {CHARTER_TIER_MAX} from '@app/features/activities/band/flow/BandSongLibrary';
import {bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import {BandSongCover} from '@app/features/activities/band/flow/components/BandSongCover';
import styles from '@app/features/activities/band/flow/components/PickSongPanel.module.css';
import {formatSongLength} from '@app/features/activities/band/flow/components/useBandNow';
import {useLingui} from '@lingui/react/macro';
import {PlayIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

type PickState = Extract<BandState, {phase: 'pick'}>;

const TIERS = Array.from({length: CHARTER_TIER_MAX + 1}, (_, tier) => tier);

const PART_CLASSES: Readonly<Record<BandPart, string>> = {
	guitar: styles.partGuitar,
	rhythm: styles.partRhythm,
	bass: styles.partBass,
	drums: styles.partDrums,
	keys: styles.partKeys,
	vocals: styles.partVocals,
};

// Countdown ring geometry, in SVG units.
const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export type BandPreviewLabel = 'playing' | 'downloading' | null;

const SongDetails = observer(function SongDetails({
	room,
	song,
	preview,
}: {
	room: BandRoom;
	song: BandSongSummary;
	preview: BandPreviewLabel;
}) {
	const {i18n} = useLingui();
	const [group] = song.groups;
	const meta = [song.year, formatSongLength(song.lengthMs), group ? i18n._(GENRE_GROUP_DESCRIPTORS[group]) : null]
		.filter((value) => value !== null)
		.join(' · ');
	return (
		<>
			<div className={styles.song} data-flx="activities.band.flow.pick-song-panel.song-details.song">
				<BandSongCover
					song={song}
					sizeRem={8.25}
					className={styles.cover}
					data-flx="activities.band.flow.pick-song-panel.song-details.cover"
				/>
				<div className={styles.text} data-flx="activities.band.flow.pick-song-panel.song-details.text">
					<h3 className={styles.name} data-flx="activities.band.flow.pick-song-panel.song-details.name">
						{song.name}
					</h3>
					<span className={styles.artist} data-flx="activities.band.flow.pick-song-panel.song-details.artist">
						{song.artist}
					</span>
					<span className={styles.meta} data-flx="activities.band.flow.pick-song-panel.song-details.meta">
						{meta}
					</span>
					{preview && (
						<span
							className={clsx(styles.preview, preview === 'downloading' && styles.previewWaiting)}
							role="status"
							data-flx="activities.band.flow.pick-song-panel.song-details.preview"
						>
							{preview === 'playing' && (
								<PlayIcon
									size={12}
									weight="fill"
									aria-hidden="true"
									data-flx="activities.band.flow.pick-song-panel.song-details.preview-icon"
								/>
							)}
							{i18n._(preview === 'playing' ? PREVIEW_PLAYING_DESCRIPTOR : PREVIEW_DOWNLOADING_DESCRIPTOR)}
						</span>
					)}
				</div>
			</div>
			<ul className={styles.parts} data-flx="activities.band.flow.pick-song-panel.song-details.parts">
				{songPlayableParts(song).map((part) => {
					const name = i18n._(partDescriptor(part, song));
					const tier = room.library.partTier(song.id, part);
					return (
						<li
							key={part}
							className={clsx(styles.part, PART_CLASSES[part])}
							data-flx="activities.band.flow.pick-song-panel.song-details.part"
						>
							<span className={styles.partName} data-flx="activities.band.flow.pick-song-panel.song-details.part-name">
								{name}
							</span>
							<span
								className={styles.bars}
								role="img"
								aria-label={
									tier === null
										? i18n._(PART_UNRATED_DESCRIPTOR, {part: name})
										: i18n._(PART_TIER_DESCRIPTOR, {part: name, tier})
								}
								data-flx="activities.band.flow.pick-song-panel.song-details.bars"
							>
								{TIERS.map((step) => (
									<i
										key={step}
										className={clsx(styles.bar, tier !== null && step <= tier && styles.barOn)}
										data-flx="activities.band.flow.pick-song-panel.song-details.bar"
									/>
								))}
							</span>
						</li>
					);
				})}
			</ul>
		</>
	);
});

function CountdownRing({seconds, remaining}: {seconds: number; remaining: number}) {
	return (
		<span className={styles.ring} aria-hidden="true" data-flx="activities.band.flow.pick-song-panel.ring">
			<svg viewBox="0 0 36 36" data-flx="activities.band.flow.pick-song-panel.ring-svg">
				<circle
					className={styles.ringTrack}
					cx={18}
					cy={18}
					r={RING_RADIUS}
					data-flx="activities.band.flow.pick-song-panel.ring-track"
				/>
				<circle
					className={styles.ringFill}
					cx={18}
					cy={18}
					r={RING_RADIUS}
					strokeDasharray={RING_LENGTH}
					strokeDashoffset={RING_LENGTH * (1 - remaining)}
					data-flx="activities.band.flow.pick-song-panel.ring-fill"
				/>
			</svg>
			<b data-flx="activities.band.flow.pick-song-panel.ring-seconds">{seconds}</b>
		</span>
	);
}

const VoteList = observer(function VoteList({
	room,
	panel,
	onSelect,
}: {
	room: BandRoom;
	panel: BandVotePanel;
	onSelect: (song: BandSongSummary) => void;
}) {
	const {i18n} = useLingui();
	return (
		<section className={styles.votes} data-flx="activities.band.flow.pick-song-panel.vote-list.votes">
			<header className={styles.votesHeader} data-flx="activities.band.flow.pick-song-panel.vote-list.header">
				<h3 className={styles.votesTitle} data-flx="activities.band.flow.pick-song-panel.vote-list.title">
					{i18n._(VOTES_DESCRIPTOR)}
				</h3>
				{panel.kind === 'counting' && (
					<CountdownRing
						seconds={panel.secondsLeft}
						remaining={panel.remaining}
						data-flx="activities.band.flow.pick-song-panel.vote-list.countdown-ring"
					/>
				)}
			</header>
			<p className={styles.votesNote} role="status" data-flx="activities.band.flow.pick-song-panel.vote-list.note">
				{panel.kind === 'counting'
					? i18n._(PICK_COUNTDOWN_DESCRIPTOR, {seconds: panel.secondsLeft})
					: i18n._(PICK_WAITING_DESCRIPTOR, {seconds: BAND_PHASE_MS.pick / 1000})}
			</p>
			{panel.kind === 'counting' && (
				<ol className={styles.voteRows} data-flx="activities.band.flow.pick-song-panel.vote-list.rows">
					{panel.rows.map((row) => {
						const song = room.library.song(row.songId);
						if (!song) return null;
						return (
							<li key={row.songId} data-flx="activities.band.flow.pick-song-panel.vote-list.row-item">
								<button
									type="button"
									className={clsx(styles.voteRow, row.leading && styles.voteRowLeading)}
									onClick={() => onSelect(song)}
									data-flx="activities.band.flow.pick-song-panel.vote-list.row.button"
								>
									<BandSongCover
										song={song}
										sizeRem={2.5}
										showArtist={false}
										data-flx="activities.band.flow.pick-song-panel.vote-list.row-cover"
									/>
									<span className={styles.voteText} data-flx="activities.band.flow.pick-song-panel.vote-list.row-text">
										<b data-flx="activities.band.flow.pick-song-panel.vote-list.row-name">{song.name}</b>
										<span data-flx="activities.band.flow.pick-song-panel.vote-list.row-voters">
											{row.voterIds.map(bandDisplayName).join(', ')}
										</span>
									</span>
									<span
										className={styles.voteCount}
										data-flx="activities.band.flow.pick-song-panel.vote-list.row-count"
									>
										{row.voterIds.length}
									</span>
								</button>
							</li>
						);
					})}
				</ol>
			)}
			{panel.kind === 'counting' && panel.canPlayNow && (
				<button
					type="button"
					className={styles.playNow}
					onClick={() => room.send({t: 'band.playNow', songId: panel.rows[0].songId})}
					data-flx="activities.band.flow.pick-song-panel.vote-list.play-now.button"
				>
					{i18n._(PLAY_LEADING_NOW_DESCRIPTOR)}
				</button>
			)}
		</section>
	);
});

interface PickSongPanelProps {
	readonly room: BandRoom;
	readonly state: PickState;
	readonly song: BandSongSummary | null;
	readonly panel: BandVotePanel;
	readonly preview: BandPreviewLabel;
	readonly onVote: (song: BandSongSummary) => void;
	readonly onSelect: (song: BandSongSummary) => void;
}

// The chosen song, its parts and the vote button on top; how the votes stand below.
export const PickSongPanel = observer(function PickSongPanel({
	room,
	state,
	song,
	panel,
	preview,
	onVote,
	onSelect,
}: PickSongPanelProps) {
	const {i18n} = useLingui();
	const unvote = song !== null && voteAction(song.id, state.votes, room.myUserId) === 'unvote';
	return (
		<aside
			className={styles.panel}
			aria-label={i18n._(PICK_SELECTED_DESCRIPTOR)}
			data-flx="activities.band.flow.pick-song-panel.panel"
		>
			{song && (
				<div className={styles.selected} data-flx="activities.band.flow.pick-song-panel.selected">
					<SongDetails
						room={room}
						song={song}
						preview={preview}
						data-flx="activities.band.flow.pick-song-panel.song-details"
					/>
					<button
						type="button"
						className={clsx(styles.vote, unvote && styles.unvote)}
						onClick={() => onVote(song)}
						data-flx="activities.band.flow.pick-song-panel.vote.button"
					>
						{i18n._(unvote ? UNVOTE_DESCRIPTOR : VOTE_DESCRIPTOR)}
					</button>
				</div>
			)}
			<VoteList
				room={room}
				panel={panel}
				onSelect={onSelect}
				data-flx="activities.band.flow.pick-song-panel.vote-list"
			/>
		</aside>
	);
});
