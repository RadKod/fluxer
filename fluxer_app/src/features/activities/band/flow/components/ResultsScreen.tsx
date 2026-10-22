// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAND_DIFFICULTY_MULTIPLIER,
	BAND_PHASE_MS,
	BAND_RATING_MAX,
	type BandPlayerResult,
	type BandSeat,
	type BandSongSummary,
	type BandState,
} from '@app/features/activities/band/BandProtocol';
import type {BandDifficulty} from '@app/features/activities/band/engine/ChartModel';
import {
	ACCURACY_DESCRIPTOR,
	AWAITING_RESULT_DESCRIPTOR,
	CROWD_HINT_DESCRIPTOR,
	CROWD_TITLE_DESCRIPTOR,
	DIFFICULTY_DESCRIPTORS,
	FINALE_BONUS_DESCRIPTOR,
	FREESTYLE_SOLO_DESCRIPTOR,
	GO_TO_PICK_DESCRIPTOR,
	LONGEST_STREAK_DESCRIPTOR,
	MY_RATING_DESCRIPTOR,
	NEXT_PICK_DESCRIPTOR,
	NO_RESULT_DESCRIPTOR,
	NOTES_MISSED_DESCRIPTOR,
	PART_AND_DIFFICULTY_DESCRIPTOR,
	partDescriptor,
	RATE_PLAYER_DESCRIPTOR,
	RATING_PENDING_DESCRIPTOR,
	RATINGS_COUNT_DESCRIPTOR,
	RESULTS_SUMMARY_DESCRIPTOR,
	SONG_SUBTITLE_DESCRIPTOR,
	STAR_POWER_DESCRIPTOR,
	STARS_LABEL_DESCRIPTOR,
	TIMES_DESCRIPTOR,
	YOU_TAG_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {resultsWaitEndsAt} from '@app/features/activities/band/flow/BandRoomMachine';
import {BandPartIcon} from '@app/features/activities/band/flow/components/BandPartIcon';
import {BandAvatar, bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import {BandSongCover} from '@app/features/activities/band/flow/components/BandSongCover';
import {BandTimer} from '@app/features/activities/band/flow/components/BandTimer';
import styles from '@app/features/activities/band/flow/components/ResultsScreen.module.css';
import {formatSongLength, secondsUntil, useBandNow} from '@app/features/activities/band/flow/components/useBandNow';
import type {I18n} from '@lingui/core';
import {useLingui} from '@lingui/react/macro';
import {StarIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

type ResultsState = Extract<BandState, {phase: 'results'}>;

const STAR_VALUES = Array.from({length: BAND_RATING_MAX}, (_, index) => index + 1);

// Share of notes hit across the band; a player without notes counts by their own accuracy.
export function groupAccuracy(results: ReadonlyArray<BandPlayerResult>): number {
	const notes = results.reduce((sum, result) => sum + result.notesHit + result.notesMissed, 0);
	if (notes > 0) return results.reduce((sum, result) => sum + result.notesHit, 0) / notes;
	return results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.accuracy, 0) / results.length;
}

// Five stars from about 95% up; 90% earns four.
export function groupStars(accuracy: number): number {
	return Math.max(0, Math.min(BAND_RATING_MAX, Math.floor(accuracy * BAND_RATING_MAX + 0.25)));
}

// The results state does not keep the group difficulty; the one most seats played stands in for it.
function commonDifficulty(seats: ReadonlyArray<BandSeat>): BandDifficulty | null {
	const counts = new Map<BandDifficulty, number>();
	for (const seat of seats) counts.set(seat.difficulty, (counts.get(seat.difficulty) ?? 0) + 1);
	let best: BandDifficulty | null = null;
	for (const [difficulty, count] of counts) if (best === null || count > (counts.get(best) ?? 0)) best = difficulty;
	return best;
}

function Percent({value, i18n, className}: {readonly value: number; readonly i18n: I18n; readonly className?: string}) {
	const parts = new Intl.NumberFormat(i18n.locale, {style: 'percent', maximumFractionDigits: 0}).formatToParts(value);
	return (
		<span className={className} data-flx="activities.band.flow.results-screen.percent.span">
			{parts.map((part, index) =>
				part.type === 'percentSign' ? (
					<small key={index} data-flx="activities.band.flow.results-screen.percent.small">
						{part.value}
					</small>
				) : (
					<span key={index} data-flx="activities.band.flow.results-screen.percent.span--2">
						{part.value}
					</span>
				),
			)}
		</span>
	);
}

function Stars({count, className}: {readonly count: number; readonly className?: string}) {
	return (
		<span className={className} data-flx="activities.band.flow.results-screen.stars.span">
			{STAR_VALUES.map((value) => (
				<StarIcon
					key={value}
					size="1em"
					weight="fill"
					className={clsx(value > count && styles.starEmpty)}
					data-flx="activities.band.flow.results-screen.stars.star-empty"
				/>
			))}
		</span>
	);
}

interface PlayerColumnProps {
	readonly room: BandRoom;
	readonly song: BandSongSummary;
	readonly seat: BandSeat;
	readonly result: BandPlayerResult | undefined;
	// Past the wait, a missing score is shown as missing rather than on its way.
	readonly gaveUp: boolean;
}

const PlayerColumn = observer(function PlayerColumn({room, song, seat, result, gaveUp}: PlayerColumnProps) {
	const {i18n} = useLingui();
	return (
		<div className={styles.column} data-flx="activities.band.flow.results-screen.player-column.column">
			<div className={styles.who} data-flx="activities.band.flow.results-screen.player-column.who">
				<BandAvatar
					userId={seat.userId}
					size={30}
					data-flx="activities.band.flow.results-screen.player-column.band-avatar"
				/>
				<div data-flx="activities.band.flow.results-screen.player-column.div">
					<b data-flx="activities.band.flow.results-screen.player-column.b">
						<span data-flx="activities.band.flow.results-screen.player-column.span">
							{bandDisplayName(seat.userId)}
						</span>
						{seat.userId === room.myUserId && (
							<span className={styles.youTag} data-flx="activities.band.flow.results-screen.player-column.you-tag">
								{i18n._(YOU_TAG_DESCRIPTOR)}
							</span>
						)}
					</b>
					<span className={styles.role} data-flx="activities.band.flow.results-screen.player-column.role">
						<BandPartIcon
							part={seat.part}
							className={styles.roleIcon}
							data-flx="activities.band.flow.results-screen.player-column.role-icon"
						/>
						<span data-flx="activities.band.flow.results-screen.player-column.span--2">
							{i18n._(PART_AND_DIFFICULTY_DESCRIPTOR, {
								part: i18n._(partDescriptor(seat.part, song)),
								difficulty: i18n._(DIFFICULTY_DESCRIPTORS[seat.difficulty]),
							})}
						</span>
					</span>
				</div>
			</div>
			{result ? (
				<>
					<Percent
						value={result.accuracy}
						i18n={i18n}
						className={styles.accuracy}
						data-flx="activities.band.flow.results-screen.player-column.accuracy"
					/>
					<div className={styles.points} data-flx="activities.band.flow.results-screen.player-column.points">
						<span data-flx="activities.band.flow.results-screen.player-column.span--3">
							{i18n.number(result.score)}
						</span>
						<span
							className={styles.pointsDetail}
							data-flx="activities.band.flow.results-screen.player-column.points-detail"
						>
							{i18n.number(result.rawScore)} × {i18n.number(BAND_DIFFICULTY_MULTIPLIER[result.difficulty])}
						</span>
					</div>
					<dl className={styles.stats} data-flx="activities.band.flow.results-screen.player-column.stats">
						<dt data-flx="activities.band.flow.results-screen.player-column.dt">{i18n._(LONGEST_STREAK_DESCRIPTOR)}</dt>
						<dd data-flx="activities.band.flow.results-screen.player-column.dd">{i18n.number(result.bestStreak)}</dd>
						<dt data-flx="activities.band.flow.results-screen.player-column.dt--2">{i18n._(STAR_POWER_DESCRIPTOR)}</dt>
						<dd data-flx="activities.band.flow.results-screen.player-column.dd--2">
							{i18n._(TIMES_DESCRIPTOR, {count: result.starPowerUses})}
						</dd>
						<dt data-flx="activities.band.flow.results-screen.player-column.dt--3">
							{i18n._(NOTES_MISSED_DESCRIPTOR)}
						</dt>
						<dd data-flx="activities.band.flow.results-screen.player-column.dd--3">
							{i18n.number(result.notesMissed)}
						</dd>
						{result.finaleBonus !== undefined && result.finaleBonus > 0 && (
							<>
								<dt data-flx="activities.band.flow.results-screen.player-column.dt--4">
									{i18n._(FINALE_BONUS_DESCRIPTOR)}
								</dt>
								<dd className={styles.finaleBonus} data-flx="activities.band.flow.results-screen.player-column.dd--4">
									+{i18n.number(result.finaleBonus)}
								</dd>
							</>
						)}
						{result.freestylePoints !== undefined && result.freestylePoints > 0 && (
							<>
								<dt data-flx="activities.band.flow.results-screen.player-column.dt--5">
									{i18n._(FREESTYLE_SOLO_DESCRIPTOR)}
								</dt>
								<dd className={styles.finaleBonus} data-flx="activities.band.flow.results-screen.player-column.dd--5">
									+{i18n.number(result.freestylePoints)}
								</dd>
							</>
						)}
					</dl>
				</>
			) : (
				<p className={styles.awaiting} data-flx="activities.band.flow.results-screen.player-column.awaiting">
					{i18n._(gaveUp ? NO_RESULT_DESCRIPTOR : AWAITING_RESULT_DESCRIPTOR)}
				</p>
			)}
		</div>
	);
});

interface CrowdColumnProps {
	readonly room: BandRoom;
	readonly state: ResultsState;
	readonly playerId: string;
}

const CrowdColumn = observer(function CrowdColumn({room, state, playerId}: CrowdColumnProps) {
	const {i18n} = useLingui();
	const raters = [
		...new Set([...room.spectatorIds, ...Object.keys(state.ratings).filter((id) => playerId in state.ratings[id])]),
	].filter((id) => id !== playerId);
	const given = raters
		.map((id) => state.ratings[id]?.[playerId])
		.filter((stars): stars is number => stars !== undefined);
	const average = given.length === 0 ? null : given.reduce((sum, stars) => sum + stars, 0) / given.length;
	const playerName = bandDisplayName(playerId);
	return (
		<div className={styles.column} data-flx="activities.band.flow.results-screen.crowd-column.column">
			<div className={styles.average} data-flx="activities.band.flow.results-screen.crowd-column.average">
				<StarIcon
					size="1em"
					weight="fill"
					className={styles.averageStar}
					data-flx="activities.band.flow.results-screen.crowd-column.average-star"
				/>
				<span data-flx="activities.band.flow.results-screen.crowd-column.span">
					{average === null ? '–' : i18n.number(average, {maximumFractionDigits: 1, minimumFractionDigits: 1})}
				</span>
				<small data-flx="activities.band.flow.results-screen.crowd-column.small">
					{i18n._(RATINGS_COUNT_DESCRIPTOR, {count: given.length})}
				</small>
			</div>
			{raters.map((raterId) => {
				const stars = state.ratings[raterId]?.[playerId];
				const mine = raterId === room.myUserId;
				return (
					<div
						key={raterId}
						className={styles.rating}
						data-flx="activities.band.flow.results-screen.crowd-column.rating"
					>
						<BandAvatar
							userId={raterId}
							size={18}
							data-flx="activities.band.flow.results-screen.crowd-column.band-avatar"
						/>
						<span className={styles.raterName} data-flx="activities.band.flow.results-screen.crowd-column.rater-name">
							{mine ? i18n._(MY_RATING_DESCRIPTOR) : bandDisplayName(raterId)}
						</span>
						{mine ? (
							<span
								className={styles.starInput}
								role="radiogroup"
								aria-label={i18n._(MY_RATING_DESCRIPTOR)}
								data-flx="activities.band.flow.results-screen.crowd-column.star-input"
							>
								{STAR_VALUES.map((value) => (
									<button
										key={value}
										type="button"
										role="radio"
										aria-checked={stars === value}
										aria-label={i18n._(RATE_PLAYER_DESCRIPTOR, {name: playerName, stars: value})}
										className={clsx(styles.starButton, (stars ?? 0) < value && styles.starEmpty)}
										onClick={() => room.send({t: 'band.rate', playerId, stars: value})}
										data-flx="activities.band.flow.results-screen.crowd-column.star-button.send"
									>
										<StarIcon
											size={14}
											weight="fill"
											data-flx="activities.band.flow.results-screen.crowd-column.star-icon"
										/>
									</button>
								))}
							</span>
						) : stars === undefined ? (
							<span className={styles.pending} data-flx="activities.band.flow.results-screen.crowd-column.pending">
								{i18n._(RATING_PENDING_DESCRIPTOR)}
								<i data-flx="activities.band.flow.results-screen.crowd-column.i" />
								<i data-flx="activities.band.flow.results-screen.crowd-column.i--2" />
								<i data-flx="activities.band.flow.results-screen.crowd-column.i--3" />
							</span>
						) : (
							<span
								role="img"
								aria-label={i18n._(STARS_LABEL_DESCRIPTOR, {stars})}
								data-flx="activities.band.flow.results-screen.crowd-column.img"
							>
								<Stars
									count={stars}
									className={styles.smallStars}
									data-flx="activities.band.flow.results-screen.crowd-column.small-stars"
								/>
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
});

interface ResultsScreenProps {
	readonly room: BandRoom;
	readonly state: ResultsState;
	readonly song: BandSongSummary;
}

export const ResultsScreen = observer(function ResultsScreen({room, state, song}: ResultsScreenProps) {
	const {i18n} = useLingui();
	const now = useBandNow(room.session);
	const resultFor = (userId: string) => state.results.find((result) => result.userId === userId);
	const accuracy = groupAccuracy(state.results);
	const stars = groupStars(accuracy);
	const total = state.results.reduce((sum, result) => sum + result.score, 0);
	const groupDifficulty = commonDifficulty(state.seats);

	return (
		<div className={styles.screen} data-flx="activities.band.flow.results-screen.screen">
			<header className={styles.group} data-flx="activities.band.flow.results-screen.group">
				<BandSongCover song={song} sizeRem={5.25} data-flx="activities.band.flow.results-screen.band-song-cover" />
				<div className={styles.song} data-flx="activities.band.flow.results-screen.song">
					<b data-flx="activities.band.flow.results-screen.b">{song.name}</b>
					<span data-flx="activities.band.flow.results-screen.span">
						{i18n._(SONG_SUBTITLE_DESCRIPTOR, {artist: song.artist, length: formatSongLength(song.lengthMs)})}
					</span>
					{groupDifficulty && (
						<small data-flx="activities.band.flow.results-screen.small">
							{i18n._(RESULTS_SUMMARY_DESCRIPTOR, {
								difficulty: i18n._(DIFFICULTY_DESCRIPTORS[groupDifficulty]),
								players: state.seats.length,
								spectators: room.spectatorIds.length,
							})}
						</small>
					)}
				</div>
				<div className={styles.total} data-flx="activities.band.flow.results-screen.total">
					<div className={styles.score} data-flx="activities.band.flow.results-screen.score">
						{i18n.number(total)}
					</div>
					<div className={styles.totalSub} data-flx="activities.band.flow.results-screen.total-sub">
						<span
							role="img"
							aria-label={i18n._(STARS_LABEL_DESCRIPTOR, {stars})}
							data-flx="activities.band.flow.results-screen.img"
						>
							<Stars
								count={stars}
								className={styles.groupStars}
								data-flx="activities.band.flow.results-screen.group-stars"
							/>
						</span>
						<span className={styles.groupAccuracy} data-flx="activities.band.flow.results-screen.group-accuracy">
							<Percent value={accuracy} i18n={i18n} data-flx="activities.band.flow.results-screen.percent" />
							<span data-flx="activities.band.flow.results-screen.span--2">{i18n._(ACCURACY_DESCRIPTOR)}</span>
						</span>
					</div>
				</div>
			</header>
			<div className={styles.columns} data-flx="activities.band.flow.results-screen.columns">
				{state.seats.map((seat) => (
					<PlayerColumn
						key={seat.userId}
						room={room}
						song={song}
						seat={seat}
						result={resultFor(seat.userId)}
						gaveUp={now >= resultsWaitEndsAt(state)}
						data-flx="activities.band.flow.results-screen.player-column"
					/>
				))}
			</div>
			<section className={styles.crowd} data-flx="activities.band.flow.results-screen.crowd">
				<div className={styles.crowdHeading} data-flx="activities.band.flow.results-screen.crowd-heading">
					<b data-flx="activities.band.flow.results-screen.b--2">{i18n._(CROWD_TITLE_DESCRIPTOR)}</b>
					<span data-flx="activities.band.flow.results-screen.span--3">{i18n._(CROWD_HINT_DESCRIPTOR)}</span>
				</div>
				<div className={styles.columns} data-flx="activities.band.flow.results-screen.columns--2">
					{state.seats.map((seat) => (
						<CrowdColumn
							key={seat.userId}
							room={room}
							state={state}
							playerId={seat.userId}
							data-flx="activities.band.flow.results-screen.crowd-column"
						/>
					))}
				</div>
			</section>
			<footer className={styles.next} data-flx="activities.band.flow.results-screen.next">
				<span className={styles.nextText} data-flx="activities.band.flow.results-screen.next-text">
					{i18n._(NEXT_PICK_DESCRIPTOR, {seconds: secondsUntil(state.endsAt, now)})}
				</span>
				<BandTimer
					endsAt={state.endsAt}
					durationMs={BAND_PHASE_MS.results}
					now={now}
					showSeconds={false}
					className={styles.nextTimer}
					data-flx="activities.band.flow.results-screen.next-timer"
				/>
				{room.session.isLeader && (
					<button
						type="button"
						className={styles.goButton}
						onClick={() => room.send({t: 'band.skip'})}
						data-flx="activities.band.flow.results-screen.go-button.send"
					>
						{i18n._(GO_TO_PICK_DESCRIPTOR)}
					</button>
				)}
			</footer>
		</div>
	);
});
