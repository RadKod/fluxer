// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAND_DIFFICULTY_MULTIPLIER,
	BAND_PHASE_MS,
	type BandSeat,
	type BandSongSummary,
	type BandState,
} from '@app/features/activities/band/BandProtocol';
import {
	BAND_DIFFICULTIES,
	type BandDifficulty,
	type BandPart,
	type InstrumentPart,
	STAGE_ORDER,
} from '@app/features/activities/band/engine/ChartModel';
import {
	DIFFICULTY_DESCRIPTORS,
	FREE_PART_DESCRIPTOR,
	GROUP_DIFFICULTY_DESCRIPTOR,
	GROUP_DIFFICULTY_HINT_DESCRIPTOR,
	GROUP_DIFFICULTY_LEADER_HINT_DESCRIPTOR,
	I_AM_READY_DESCRIPTOR,
	LEADER_TAG_DESCRIPTOR,
	MULTIPLIER_DESCRIPTOR,
	NOT_READY_DESCRIPTOR,
	PART_DESCRIPTORS,
	PICK_A_PART_DESCRIPTOR,
	PICKING_DESCRIPTOR,
	partDescriptor,
	READY_DESCRIPTOR,
	READY_TALLY_DESCRIPTOR,
	SONG_SUBTITLE_DESCRIPTOR,
	TAKE_PART_DESCRIPTOR,
	VOCALS_HINT_DESCRIPTOR,
	WATCH_DESCRIPTOR,
	YOU_TAG_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import {type BandLaneColour, bandPartKeys} from '@app/features/activities/band/flow/BandKeyGuide';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {songPartDifficulties} from '@app/features/activities/band/flow/BandRoomMachine';
import {BandPartIcon} from '@app/features/activities/band/flow/components/BandPartIcon';
import {BandAvatar, bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import {BandSongCover} from '@app/features/activities/band/flow/components/BandSongCover';
import {BandTimer} from '@app/features/activities/band/flow/components/BandTimer';
import {KeyGuide} from '@app/features/activities/band/flow/components/KeyGuide';
import styles from '@app/features/activities/band/flow/components/SelectScreen.module.css';
import {SpectatorStrip} from '@app/features/activities/band/flow/components/SpectatorStrip';
import {formatSongLength, useBandNow} from '@app/features/activities/band/flow/components/useBandNow';
import {DEFAULT_BAND_KEY_MAP} from '@app/features/activities/band/game/BandInput';
import {useLingui} from '@lingui/react/macro';
import {CheckIcon, EyeIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useRef} from 'react';

type SelectState = Extract<BandState, {phase: 'select'}>;

const LANE_CLASSES: Readonly<Record<BandLaneColour, string>> = {
	green: styles.laneGreen,
	red: styles.laneRed,
	yellow: styles.laneYellow,
	blue: styles.laneBlue,
	orange: styles.laneOrange,
};

function PartKeys({part}: {readonly part: InstrumentPart}) {
	const {lanes, kick} = bandPartKeys(DEFAULT_BAND_KEY_MAP, part);
	return (
		<span className={styles.keys} aria-hidden="true" data-flx="activities.band.flow.select-screen.part-keys.keys">
			{lanes.map((key) => (
				<span
					key={key.code}
					className={clsx(styles.keyCap, key.colour && LANE_CLASSES[key.colour])}
					data-flx="activities.band.flow.select-screen.part-keys.key-cap"
				>
					{key.label}
				</span>
			))}
			{kick && (
				<span
					className={clsx(styles.keyCap, styles.keyWide, kick.colour && LANE_CLASSES[kick.colour])}
					data-flx="activities.band.flow.select-screen.part-keys.key-cap--2"
				>
					{kick.label}
				</span>
			)}
		</span>
	);
}

interface DifficultyListProps {
	readonly room: BandRoom;
	readonly offered: ReadonlyArray<BandDifficulty>;
	readonly selected: BandDifficulty | null;
	readonly editable: boolean;
	readonly className?: string;
	readonly optionClassName?: string;
}

const DifficultyList = observer(function DifficultyList({
	room,
	offered,
	selected,
	editable,
	className,
	optionClassName,
}: DifficultyListProps) {
	const {i18n} = useLingui();
	return (
		<div
			className={className}
			role="radiogroup"
			data-flx="activities.band.flow.select-screen.difficulty-list.radiogroup"
		>
			{BAND_DIFFICULTIES.filter((difficulty) => offered.includes(difficulty)).map((difficulty) => (
				<button
					key={difficulty}
					type="button"
					role="radio"
					aria-checked={difficulty === selected}
					disabled={!editable}
					className={clsx(styles.difficulty, optionClassName, difficulty === selected && styles.difficultyOn)}
					onClick={() => room.send({t: 'band.difficulty', difficulty})}
					data-flx="activities.band.flow.select-screen.difficulty-list.difficulty.send.button"
				>
					<span
						className={styles.difficultyName}
						data-flx="activities.band.flow.select-screen.difficulty-list.difficulty-name"
					>
						{i18n._(DIFFICULTY_DESCRIPTORS[difficulty])}
					</span>
					<span className={styles.multiplier} data-flx="activities.band.flow.select-screen.difficulty-list.multiplier">
						{i18n._(MULTIPLIER_DESCRIPTOR, {multiplier: i18n.number(BAND_DIFFICULTY_MULTIPLIER[difficulty])})}
					</span>
				</button>
			))}
		</div>
	);
});

interface SeatPersonProps {
	readonly room: BandRoom;
	readonly seat: BandSeat;
}

const SeatPerson = observer(function SeatPerson({room, seat}: SeatPersonProps) {
	const {i18n} = useLingui();
	const mine = seat.userId === room.myUserId;
	const leader = room.session.leader?.userId === seat.userId;
	let status: string;
	if (mine && leader) status = i18n._(LEADER_TAG_DESCRIPTOR);
	else if (seat.ready) status = i18n._(READY_DESCRIPTOR);
	else status = i18n._(PICKING_DESCRIPTOR);
	return (
		<div className={styles.person} data-flx="activities.band.flow.select-screen.seat-person.person">
			<BandAvatar
				userId={seat.userId}
				size={32}
				data-flx="activities.band.flow.select-screen.seat-person.band-avatar"
			/>
			<div className={styles.personText} data-flx="activities.band.flow.select-screen.seat-person.person-text">
				<b data-flx="activities.band.flow.select-screen.seat-person.b">
					<span data-flx="activities.band.flow.select-screen.seat-person.span">{bandDisplayName(seat.userId)}</span>
					{mine && (
						<span className={styles.youTag} data-flx="activities.band.flow.select-screen.seat-person.you-tag">
							{i18n._(YOU_TAG_DESCRIPTOR)}
						</span>
					)}
				</b>
				<span
					className={clsx(!seat.ready && !mine && styles.picking)}
					data-flx="activities.band.flow.select-screen.seat-person.picking"
				>
					{status}
				</span>
			</div>
		</div>
	);
});

interface SeatActionsProps {
	readonly room: BandRoom;
	readonly part: BandPart;
	readonly seat: BandSeat | undefined;
	readonly className?: string;
}

const SeatActions = observer(function SeatActions({room, part, seat, className}: SeatActionsProps) {
	const {i18n} = useLingui();
	if (!seat) {
		return (
			<div className={className} data-flx="activities.band.flow.select-screen.seat-actions.div">
				<button
					type="button"
					className={clsx(styles.readyButton, styles.readyYes)}
					onClick={() => room.send({t: 'band.claimSeat', part})}
					data-flx="activities.band.flow.select-screen.seat-actions.ready-button.send"
				>
					{i18n._(TAKE_PART_DESCRIPTOR)}
				</button>
			</div>
		);
	}
	if (seat.userId !== room.myUserId) {
		return (
			<div className={className} data-flx="activities.band.flow.select-screen.seat-actions.div--2">
				<span
					className={clsx(styles.readyButton, seat.ready ? styles.readyYes : styles.readyNo)}
					data-flx="activities.band.flow.select-screen.seat-actions.ready-button"
				>
					{seat.ready && (
						<CheckIcon size={16} weight="bold" data-flx="activities.band.flow.select-screen.seat-actions.check-icon" />
					)}
					<span data-flx="activities.band.flow.select-screen.seat-actions.span">
						{i18n._(seat.ready ? READY_DESCRIPTOR : NOT_READY_DESCRIPTOR)}
					</span>
				</span>
			</div>
		);
	}
	return (
		<div className={className} data-flx="activities.band.flow.select-screen.seat-actions.div--3">
			<button
				type="button"
				aria-pressed={seat.ready}
				className={clsx(styles.readyButton, seat.ready ? styles.readyYes : styles.readyNo)}
				onClick={() => room.send({t: 'band.ready', ready: !seat.ready})}
				data-flx="activities.band.flow.select-screen.seat-actions.ready-button.send--2"
			>
				{seat.ready && (
					<CheckIcon size={16} weight="bold" data-flx="activities.band.flow.select-screen.seat-actions.check-icon--2" />
				)}
				<span data-flx="activities.band.flow.select-screen.seat-actions.span--2">{i18n._(I_AM_READY_DESCRIPTOR)}</span>
			</button>
			<button
				type="button"
				className={styles.watch}
				onClick={() => room.send({t: 'band.claimSeat', part: null})}
				data-flx="activities.band.flow.select-screen.seat-actions.watch.send.button"
			>
				<EyeIcon size={16} weight="bold" data-flx="activities.band.flow.select-screen.seat-actions.eye-icon" />
				{i18n._(WATCH_DESCRIPTOR)}
			</button>
		</div>
	);
});

interface PartCardProps {
	readonly room: BandRoom;
	readonly song: BandSongSummary;
	readonly part: InstrumentPart;
	readonly seat: BandSeat | undefined;
}

const PartCard = observer(function PartCard({room, song, part, seat}: PartCardProps) {
	const {i18n} = useLingui();
	const mine = seat?.userId === room.myUserId;
	const name = i18n._(partDescriptor(part, song));
	return (
		<section
			className={clsx(styles.partCard, mine && styles.partCardMine)}
			aria-label={name}
			data-flx="activities.band.flow.select-screen.part-card.part-card"
		>
			<header className={styles.partHeader} data-flx="activities.band.flow.select-screen.part-card.part-header">
				<span className={styles.partName} data-flx="activities.band.flow.select-screen.part-card.part-name">
					<BandPartIcon
						part={part}
						className={styles.partIcon}
						data-flx="activities.band.flow.select-screen.part-card.part-icon"
					/>
					{name}
				</span>
				<PartKeys part={part} data-flx="activities.band.flow.select-screen.part-card.part-keys" />
			</header>
			{seat ? (
				<SeatPerson room={room} seat={seat} data-flx="activities.band.flow.select-screen.part-card.seat-person" />
			) : (
				<div
					className={clsx(styles.person, styles.personFree)}
					data-flx="activities.band.flow.select-screen.part-card.person"
				>
					{i18n._(FREE_PART_DESCRIPTOR)}
				</div>
			)}
			<DifficultyList
				room={room}
				offered={songPartDifficulties(song, part)}
				selected={seat?.difficulty ?? null}
				editable={mine}
				className={styles.difficulties}
				data-flx="activities.band.flow.select-screen.part-card.difficulties"
			/>
			<SeatActions
				room={room}
				part={part}
				seat={seat}
				className={styles.actions}
				data-flx="activities.band.flow.select-screen.part-card.actions"
			/>
		</section>
	);
});

const VocalsCard = observer(function VocalsCard({
	room,
	song,
	seat,
}: {
	readonly room: BandRoom;
	readonly song: BandSongSummary;
	readonly seat: BandSeat | undefined;
}) {
	const {i18n} = useLingui();
	const mine = seat?.userId === room.myUserId;
	return (
		<section
			className={clsx(styles.vocals, mine && styles.partCardMine)}
			aria-label={i18n._(PART_DESCRIPTORS.vocals)}
			data-flx="activities.band.flow.select-screen.vocals-card.vocals"
		>
			<div className={styles.vocalsTitle} data-flx="activities.band.flow.select-screen.vocals-card.vocals-title">
				<BandPartIcon
					part="vocals"
					className={styles.vocalsIcon}
					data-flx="activities.band.flow.select-screen.vocals-card.vocals-icon"
				/>
				<div data-flx="activities.band.flow.select-screen.vocals-card.div">
					<b data-flx="activities.band.flow.select-screen.vocals-card.b">{i18n._(PART_DESCRIPTORS.vocals)}</b>
					<span data-flx="activities.band.flow.select-screen.vocals-card.span">{i18n._(VOCALS_HINT_DESCRIPTOR)}</span>
				</div>
			</div>
			<div className={styles.vocalsPerson} data-flx="activities.band.flow.select-screen.vocals-card.vocals-person">
				{seat ? (
					<SeatPerson room={room} seat={seat} data-flx="activities.band.flow.select-screen.vocals-card.seat-person" />
				) : (
					<span className={styles.personFree} data-flx="activities.band.flow.select-screen.vocals-card.person-free">
						{i18n._(FREE_PART_DESCRIPTOR)}
					</span>
				)}
			</div>
			<DifficultyList
				room={room}
				offered={songPartDifficulties(song, 'vocals')}
				selected={seat?.difficulty ?? null}
				editable={mine}
				className={styles.vocalsDifficulties}
				optionClassName={styles.vocalsDifficulty}
				data-flx="activities.band.flow.select-screen.vocals-card.vocals-difficulties"
			/>
			<SeatActions
				room={room}
				part="vocals"
				seat={seat}
				className={styles.vocalsActions}
				data-flx="activities.band.flow.select-screen.vocals-card.vocals-actions"
			/>
		</section>
	);
});

const GroupDifficulty = observer(function GroupDifficulty({
	room,
	state,
}: {
	readonly room: BandRoom;
	readonly state: SelectState;
}) {
	const {i18n} = useLingui();
	const leader = room.session.leader;
	const isLeader = room.session.isLeader;
	return (
		<div className={styles.group} data-flx="activities.band.flow.select-screen.group-difficulty.group">
			<div className={styles.groupLabel} data-flx="activities.band.flow.select-screen.group-difficulty.group-label">
				{i18n._(GROUP_DIFFICULTY_DESCRIPTOR)}
			</div>
			<div
				className={styles.segmented}
				role="radiogroup"
				aria-label={i18n._(GROUP_DIFFICULTY_DESCRIPTOR)}
				data-flx="activities.band.flow.select-screen.group-difficulty.segmented"
			>
				{BAND_DIFFICULTIES.map((difficulty) => (
					<button
						key={difficulty}
						type="button"
						role="radio"
						aria-checked={difficulty === state.groupDifficulty}
						disabled={!isLeader}
						className={clsx(styles.segment, difficulty === state.groupDifficulty && styles.segmentOn)}
						onClick={() => room.send({t: 'band.groupDifficulty', difficulty})}
						data-flx="activities.band.flow.select-screen.group-difficulty.segment.send.button"
					>
						{i18n._(DIFFICULTY_DESCRIPTORS[difficulty])}
					</button>
				))}
			</div>
			{isLeader && (
				<p className={styles.groupHint} data-flx="activities.band.flow.select-screen.group-difficulty.group-hint">
					{i18n._(GROUP_DIFFICULTY_LEADER_HINT_DESCRIPTOR)}
				</p>
			)}
			{!isLeader && leader && (
				<p className={styles.groupHint} data-flx="activities.band.flow.select-screen.group-difficulty.group-hint--2">
					{i18n._(GROUP_DIFFICULTY_HINT_DESCRIPTOR, {name: bandDisplayName(leader.userId)})}
				</p>
			)}
		</div>
	);
});

interface SelectScreenProps {
	readonly room: BandRoom;
	readonly state: SelectState;
	readonly song: BandSongSummary;
}

export const SelectScreen = observer(function SelectScreen({room, state, song}: SelectScreenProps) {
	const {i18n} = useLingui();
	const rootRef = useRef<HTMLDivElement>(null);
	const now = useBandNow(room.session);
	const seatFor = (part: BandPart) => state.seats.find((seat) => seat.part === part);
	// Highways in stage order; vocals have their own card above.
	const highwayParts = STAGE_ORDER.filter((part) => songPartDifficulties(song, part).length > 0);
	const hasVocals = songPartDifficulties(song, 'vocals').length > 0;
	const mySeat = state.seats.find((seat) => seat.userId === room.myUserId);
	// The early start waits for everyone in the room, so the count does too: a ready seat or a choice to watch.
	const present = new Set(room.session.participants.map((participant) => participant.userId));
	const decided = new Set([...state.watching, ...state.seats.filter((seat) => seat.ready).map((seat) => seat.userId)]);
	const decidedCount = [...present].filter((userId) => decided.has(userId)).length;

	return (
		<div ref={rootRef} className={styles.screen} data-flx="activities.band.flow.select-screen.screen">
			<div className={styles.game} data-flx="activities.band.flow.select-screen.game">
				{hasVocals && (
					<VocalsCard
						room={room}
						song={song}
						seat={seatFor('vocals')}
						data-flx="activities.band.flow.select-screen.vocals-card"
					/>
				)}
				<div className={styles.songRow} data-flx="activities.band.flow.select-screen.song-row">
					<div className={styles.song} data-flx="activities.band.flow.select-screen.song">
						<BandSongCover
							song={song}
							sizeRem={3.75}
							showArtist={false}
							data-flx="activities.band.flow.select-screen.band-song-cover"
						/>
						<div data-flx="activities.band.flow.select-screen.div">
							<b data-flx="activities.band.flow.select-screen.b">{song.name}</b>
							<span data-flx="activities.band.flow.select-screen.span">
								{i18n._(SONG_SUBTITLE_DESCRIPTOR, {artist: song.artist, length: formatSongLength(song.lengthMs)})}
							</span>
						</div>
					</div>
					<GroupDifficulty room={room} state={state} data-flx="activities.band.flow.select-screen.group-difficulty" />
				</div>
				<BandTimer
					endsAt={state.endsAt}
					durationMs={BAND_PHASE_MS.select}
					now={now}
					data-flx="activities.band.flow.select-screen.band-timer"
				>
					<span className={styles.readyTally} data-flx="activities.band.flow.select-screen.ready-tally">
						{state.seats.length === 0
							? i18n._(PICK_A_PART_DESCRIPTOR)
							: i18n._(READY_TALLY_DESCRIPTOR, {ready: decidedCount, seated: present.size})}
					</span>
				</BandTimer>
				<div className={styles.stage} data-flx="activities.band.flow.select-screen.stage">
					<div className={styles.highways} aria-hidden="true" data-flx="activities.band.flow.select-screen.highways">
						{highwayParts.map((part) => (
							<span
								key={part}
								className={clsx(styles.highway, part === 'drums' && styles.highwayDrums)}
								data-flx="activities.band.flow.select-screen.highway"
							/>
						))}
					</div>
					{mySeat && (
						<KeyGuide
							scopeRef={rootRef}
							part={mySeat.part}
							keyboardCaptured={room.session.keyboardCaptured}
							compact={mySeat.ready}
							data-flx="activities.band.flow.select-screen.key-guide"
						/>
					)}
					<div className={styles.partCards} data-flx="activities.band.flow.select-screen.part-cards">
						{highwayParts.map((part) => (
							<PartCard
								key={part}
								room={room}
								song={song}
								part={part}
								seat={seatFor(part)}
								data-flx="activities.band.flow.select-screen.part-card"
							/>
						))}
					</div>
				</div>
			</div>
			<SpectatorStrip room={room} phase="select" data-flx="activities.band.flow.select-screen.spectator-strip" />
		</div>
	);
});
