// SPDX-License-Identifier: AGPL-3.0-or-later

// The focus view of a song: my highway large in the middle with my HUD under it, the bandmates' highways smaller,
// blurred and dimmed at the sides. The side highways draw on their own low-resolution canvases at most 30 times a
// second, one side per frame, so they never take frame time from mine. The singer gets the vocal lane in the middle.

import Accessibility from '@app/features/accessibility/state/Accessibility';
import type {BandSeat, BandSongSummary} from '@app/features/activities/band/BandProtocol';
import type {VocalsChart} from '@app/features/activities/band/engine/VocalsParser';
import {VOICE_MIC_PORT} from '@app/features/activities/band/flow/BandMicPort';
import {BandAvatar, bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import {BandSongCover} from '@app/features/activities/band/flow/components/BandSongCover';
import {useElementSize} from '@app/features/activities/band/flow/components/useElementSize';
import {DIFFICULTY_LABELS, FEEDBACK_LABELS, partLabel} from '@app/features/activities/band/game/BandGameLabels';
import styles from '@app/features/activities/band/game/FocusStage.module.css';
import {
	FOCUS_HEIGHT,
	type FocusLayout,
	type FocusRect,
	type HighwayKind,
	layoutFocus,
} from '@app/features/activities/band/game/HighwayGeometry';
import {type HighwayFrame, HighwayRenderer} from '@app/features/activities/band/game/HighwayRenderer';
import type {FeedbackKind, PlayController, SeatTrack} from '@app/features/activities/band/game/PlayController';
import type {PlayRuntime} from '@app/features/activities/band/game/PlayRuntime';
import sharedStyles from '@app/features/activities/band/game/PlayScreen.module.css';
import {
	FINALE_BONUS_AT_STAKE_DESCRIPTOR,
	FinaleBanner,
	formatClock,
	type PlayerStatusKind,
	PlayerStatusText,
	playerStatusKind,
	resizeCanvas,
	runFrameLoop,
	SING_HINT_DESCRIPTOR,
	useSongTime,
	useSpeakingUsers,
	ViewSwitch,
	VolumeControl,
} from '@app/features/activities/band/game/PlayStageParts';
import {VocalsRenderer} from '@app/features/activities/band/game/VocalsRenderer';
import {formatNumber} from '@app/features/i18n/utils/IntlCache';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {MicrophoneIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type CSSProperties, type RefObject, useEffect, useMemo, useRef} from 'react';

const STREAK_DESCRIPTOR = msg({
	message: '{difficulty} · {streak} streak',
	comment:
		'Band game focus view: under my name, my difficulty and how many notes in a row I hit, e.g. "Expert · 127 streak".',
});
const SIDE_STATS_DESCRIPTOR = msg({
	message: '×{multiplier} · {streak} streak',
	comment:
		'Band game focus view: under a bandmate name beside their small highway, their score multiplier and notes in a row, e.g. "×2 · 41 streak".',
});
const STAR_POWER_DESCRIPTOR = msg({
	message: 'Star power',
	context: 'band-meter',
	comment: 'Band game focus view: label over my star power bar. Star power doubles the score once deployed.',
});
const BAND_SCORE_DESCRIPTOR = msg({
	message: 'Band',
	context: 'band-score',
	comment: 'Band game focus view: small label over the whole band score in the top right corner.',
});

// The side highways' redraw ceiling, and their share of the screen's pixel density: they are blurred anyway.
const SIDE_FRAME_MS = 1000 / 30;
const SIDE_RESOLUTION = 0.5;

const STATUS_CLASSES: Readonly<Record<PlayerStatusKind, string>> = {
	finale: styles.statusBright,
	finaleBanked: styles.statusBright,
	finaleLost: styles.statusMuted,
	starPower: styles.statusStar,
};

function highwayKind(track: SeatTrack): HighwayKind {
	return track.part === 'drums' ? 'drums' : 'frets';
}

interface SideCanvas {
	readonly renderer: HighwayRenderer;
	readonly tracks: ReadonlyArray<SeatTrack>;
	drawnAt: number;
}

function useFocusLoop(
	runtime: PlayRuntime,
	layout: FocusLayout | null,
	mainRef: RefObject<HTMLCanvasElement | null>,
	sideRefs: RefObject<Array<HTMLCanvasElement | null>>,
	vocalsRef: RefObject<HTMLCanvasElement | null>,
	others: ReadonlyArray<SeatTrack>,
	vocals: VocalsChart | null,
	feedbackLabels: Readonly<Record<FeedbackKind, string>>,
): void {
	useEffect(() => {
		const mainCanvas = mainRef.current;
		if (!layout || !mainCanvas) return;
		const {controller} = runtime;
		const mine = controller.myTrack;
		const mainCtx = resizeCanvas(mainCanvas, layout.width, layout.height);
		const main = layout.main && mainCtx && mine ? new HighwayRenderer(mainCtx) : null;
		if (main && layout.main) main.setLayout(layout.main);
		const sides: Array<SideCanvas> = [];
		layout.sides.forEach((side, index) => {
			const canvas = sideRefs.current?.[index];
			const ctx = canvas ? resizeCanvas(canvas, side.layout.width, side.layout.height, SIDE_RESOLUTION) : null;
			if (!ctx) return;
			const renderer = new HighwayRenderer(ctx, {shakeOnMiss: true});
			renderer.setLayout(side.layout);
			sides.push({renderer, tracks: side.others.map((other) => others[other]), drawnAt: Number.NEGATIVE_INFINITY});
		});
		const vocalsCanvas = vocalsRef.current;
		const vocalsWidth = vocalsCanvas?.clientWidth ?? 0;
		const vocalsHeight = vocalsCanvas?.clientHeight ?? 0;
		const vocalsCtx = vocalsCanvas ? resizeCanvas(vocalsCanvas, vocalsWidth, vocalsHeight, layout.scale) : null;
		const vocalsRenderer = vocals && vocalsCtx ? new VocalsRenderer(vocalsCtx, vocals) : null;
		const fontFamily = getComputedStyle(mainCanvas).fontFamily || 'sans-serif';
		const myTracks = mine ? [mine] : [];

		return runFrameLoop(runtime, (nowMs, frameTimestamp) => {
			const frame: HighwayFrame = {
				nowMs,
				tracks: myTracks,
				reducedMotion: Accessibility.useReducedMotion,
				feedbackLabels,
				fontFamily,
			};
			main?.draw(frame);
			vocalsRenderer?.draw(vocalsWidth, vocalsHeight, nowMs, fontFamily);
			let due: SideCanvas | null = null;
			for (const side of sides) {
				if (frameTimestamp - side.drawnAt >= SIDE_FRAME_MS && (!due || side.drawnAt < due.drawnAt)) due = side;
			}
			if (due) {
				due.renderer.draw({...frame, tracks: due.tracks});
				due.drawnAt = frameTimestamp;
			}
		});
	}, [runtime, layout, mainRef, sideRefs, vocalsRef, others, vocals, feedbackLabels]);
}

function rectStyle(rect: FocusRect): CSSProperties {
	return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
}

const PartLine = observer(function PartLine({entry, seat}: {entry: BandSongSummary; seat: BandSeat}) {
	const {i18n} = useLingui();
	return (
		<b className={styles.who} data-flx="activities.band.game.focus-stage.part-line.who">
			{bandDisplayName(seat.userId)} · {i18n._(partLabel(seat.part, entry))}
		</b>
	);
});

const Header = observer(function Header({
	runtime,
	entry,
	controller,
}: {
	runtime: PlayRuntime;
	entry: BandSongSummary;
	controller: PlayController;
}) {
	const {i18n} = useLingui();
	const songMs = useSongTime(runtime, 500);
	const locale = getCurrentLocale();
	const share = entry.lengthMs > 0 ? Math.min(1, Math.max(0, songMs / entry.lengthMs)) : 0;
	const bonus = controller.groupFinaleBonus;
	return (
		<header className={styles.header} data-flx="activities.band.game.focus-stage.header.header">
			<BandSongCover
				song={entry}
				sizeRem={2.75}
				showArtist={false}
				className={styles.cover}
				data-flx="activities.band.game.focus-stage.header.cover"
			/>
			<div className={styles.song} data-flx="activities.band.game.focus-stage.header.song">
				<b data-flx="activities.band.game.focus-stage.header.song-name">{entry.name}</b>
				<span data-flx="activities.band.game.focus-stage.header.song-artist">{entry.artist}</span>
			</div>
			<span className={styles.progress} data-flx="activities.band.game.focus-stage.header.progress">
				<i style={{width: `${share * 100}%`}} data-flx="activities.band.game.focus-stage.header.progress-fill" />
			</span>
			<span className={clsx(styles.clock, sharedStyles.num)} data-flx="activities.band.game.focus-stage.header.clock">
				{formatClock(songMs)} / {formatClock(entry.lengthMs)}
			</span>
			<div className={styles.headerControls} data-flx="activities.band.game.focus-stage.header.controls">
				<ViewSwitch data-flx="activities.band.game.focus-stage.header.view-switch" />
				<VolumeControl data-flx="activities.band.game.focus-stage.header.volume" />
			</div>
			<div className={styles.bandScore} data-flx="activities.band.game.focus-stage.header.band-score">
				<span data-flx="activities.band.game.focus-stage.header.band-score-label">{i18n._(BAND_SCORE_DESCRIPTOR)}</span>
				<b className={sharedStyles.num} data-flx="activities.band.game.focus-stage.header.band-score-value">
					{formatNumber(Math.round(controller.groupScore), locale)}
				</b>
				{controller.finaleActive && bonus > 0 && (
					<span className={styles.bonus} data-flx="activities.band.game.focus-stage.header.bonus">
						{i18n._(FINALE_BONUS_AT_STAKE_DESCRIPTOR)}{' '}
						<b className={sharedStyles.num} data-flx="activities.band.game.focus-stage.header.bonus-value">
							+{formatNumber(bonus, locale)}
						</b>
					</span>
				)}
			</div>
		</header>
	);
});

const Hud = observer(function Hud({
	entry,
	track,
	rect,
	speaking,
}: {
	entry: BandSongSummary;
	track: SeatTrack;
	rect: FocusRect;
	speaking: boolean;
}) {
	const {i18n} = useLingui();
	const {hud, seat} = track;
	const status = playerStatusKind(hud);
	return (
		<div className={styles.hud} style={rectStyle(rect)} data-flx="activities.band.game.focus-stage.hud.hud">
			<span
				className={clsx(styles.avatar, speaking && sharedStyles.speaking)}
				data-flx="activities.band.game.focus-stage.hud.avatar"
			>
				<BandAvatar userId={seat.userId} size={40} data-flx="activities.band.game.focus-stage.hud.band-avatar" />
			</span>
			<div className={styles.identity} data-flx="activities.band.game.focus-stage.hud.identity">
				<PartLine entry={entry} seat={seat} data-flx="activities.band.game.focus-stage.hud.part-line" />
				<span
					className={clsx(styles.line, status && STATUS_CLASSES[status])}
					data-flx="activities.band.game.focus-stage.hud.line"
				>
					{status ? (
						<PlayerStatusText kind={status} hud={hud} data-flx="activities.band.game.focus-stage.hud.status" />
					) : (
						i18n._(STREAK_DESCRIPTOR, {difficulty: i18n._(DIFFICULTY_LABELS[seat.difficulty]), streak: hud.combo})
					)}
				</span>
			</div>
			<div
				className={clsx(styles.energy, hud.starPowerActive && styles.energyOn)}
				data-flx="activities.band.game.focus-stage.hud.energy"
			>
				<span data-flx="activities.band.game.focus-stage.hud.energy-label">{i18n._(STAR_POWER_DESCRIPTOR)}</span>
				<i className={styles.energyTrack} data-flx="activities.band.game.focus-stage.hud.energy-track">
					<i
						className={styles.energyFill}
						style={{width: `${Math.min(1, hud.starPowerEnergy) * 100}%`}}
						data-flx="activities.band.game.focus-stage.hud.energy-fill"
					/>
				</i>
			</div>
			<b
				className={clsx(styles.multiplier, sharedStyles.num, hud.starPowerActive && styles.multiplierStar)}
				data-flx="activities.band.game.focus-stage.hud.multiplier"
			>
				×{hud.shownMultiplier}
			</b>
			<b className={clsx(styles.score, sharedStyles.num)} data-flx="activities.band.game.focus-stage.hud.score">
				{formatNumber(Math.round(hud.score + hud.bankedFinaleBonus), getCurrentLocale())}
			</b>
		</div>
	);
});

const SideLabel = observer(function SideLabel({
	entry,
	track,
	rect,
	align,
	pair,
	speaking,
}: {
	entry: BandSongSummary;
	track: SeatTrack;
	rect: FocusRect;
	align: 'left' | 'right';
	pair: boolean;
	speaking: boolean;
}) {
	const {i18n} = useLingui();
	const {hud, seat} = track;
	const status = playerStatusKind(hud);
	return (
		<div
			className={clsx(styles.sideLabel, align === 'right' && styles.sideLabelRight, pair && styles.sideLabelPair)}
			style={rectStyle(rect)}
			data-flx="activities.band.game.focus-stage.side-label.side-label"
		>
			<span
				className={clsx(
					styles.sideAvatar,
					hud.starPowerActive && styles.sideAvatarStar,
					speaking && sharedStyles.speaking,
				)}
				data-flx="activities.band.game.focus-stage.side-label.avatar"
			>
				<BandAvatar userId={seat.userId} size={30} data-flx="activities.band.game.focus-stage.side-label.band-avatar" />
			</span>
			<div className={styles.identity} data-flx="activities.band.game.focus-stage.side-label.identity">
				<PartLine entry={entry} seat={seat} data-flx="activities.band.game.focus-stage.side-label.part-line" />
				<span
					className={clsx(styles.line, status && STATUS_CLASSES[status])}
					data-flx="activities.band.game.focus-stage.side-label.line"
				>
					{status ? (
						<PlayerStatusText kind={status} hud={hud} data-flx="activities.band.game.focus-stage.side-label.status" />
					) : (
						i18n._(SIDE_STATS_DESCRIPTOR, {multiplier: hud.shownMultiplier, streak: hud.combo})
					)}
				</span>
			</div>
		</div>
	);
});

const SingerHud = observer(function SingerHud({
	entry,
	seat,
	rect,
	speaking,
}: {
	entry: BandSongSummary;
	seat: BandSeat;
	rect: FocusRect;
	speaking: boolean;
}) {
	const {i18n} = useLingui();
	return (
		<div className={styles.hud} style={rectStyle(rect)} data-flx="activities.band.game.focus-stage.singer-hud.hud">
			<span
				className={clsx(styles.avatar, speaking && sharedStyles.speaking)}
				data-flx="activities.band.game.focus-stage.singer-hud.avatar"
			>
				<BandAvatar userId={seat.userId} size={40} data-flx="activities.band.game.focus-stage.singer-hud.band-avatar" />
			</span>
			<div className={styles.identity} data-flx="activities.band.game.focus-stage.singer-hud.identity">
				<PartLine entry={entry} seat={seat} data-flx="activities.band.game.focus-stage.singer-hud.part-line" />
				{!VOICE_MIC_PORT.isMuted() && (
					<span
						className={clsx(styles.line, styles.singHint)}
						data-flx="activities.band.game.focus-stage.singer-hud.hint"
					>
						<MicrophoneIcon
							weight="fill"
							aria-hidden="true"
							data-flx="activities.band.game.focus-stage.singer-hud.icon"
						/>
						{i18n._(SING_HINT_DESCRIPTOR)}
					</span>
				)}
			</div>
		</div>
	);
});

// Small corner chip for the mini window and call tiles, which have no room for the HUD: my multiplier and score.
const CompactScore = observer(function CompactScore({track}: {track: SeatTrack}) {
	const {hud} = track;
	return (
		<span
			className={clsx(styles.compactScore, sharedStyles.num)}
			data-flx="activities.band.game.focus-stage.compact-score"
		>
			<b data-flx="activities.band.game.focus-stage.compact-score.multiplier">×{hud.shownMultiplier}</b>
			{formatNumber(Math.round(hud.score + hud.bankedFinaleBonus), getCurrentLocale())}
		</span>
	);
});

interface FocusStageProps {
	readonly runtime: PlayRuntime;
	readonly entry: BandSongSummary;
	readonly channelId: string;
	readonly vocals: VocalsChart | null;
}

export const FocusStage = observer(function FocusStage({runtime, entry, channelId, vocals}: FocusStageProps) {
	const {i18n} = useLingui();
	const rootRef = useRef<HTMLDivElement>(null);
	const mainRef = useRef<HTMLCanvasElement>(null);
	const sideRefs = useRef<Array<HTMLCanvasElement | null>>([]);
	const vocalsRef = useRef<HTMLCanvasElement>(null);
	const {width, height} = useElementSize(rootRef);
	const {controller} = runtime;
	const mine = controller.myTrack;
	const others = useMemo(() => controller.tracks.filter((track) => !track.isMine), [controller]);
	const vocalsSeat = vocals ? controller.vocalsSeat : null;
	const singing = vocalsSeat !== null && vocalsSeat.userId === controller.mySeat?.userId;
	const layout = useMemo(
		() =>
			width > 0 && height > 0
				? layoutFocus(width, height, {
						mine: mine ? highwayKind(mine) : null,
						others: others.map(highwayKind),
						lyrics: vocalsSeat !== null && !singing,
					})
				: null,
		[width, height, mine, others, vocalsSeat, singing],
	);
	const feedbackLabels = useMemo(
		() => ({
			perfect: i18n._(FEEDBACK_LABELS.perfect),
			good: i18n._(FEEDBACK_LABELS.good),
			ok: i18n._(FEEDBACK_LABELS.ok),
			miss: i18n._(FEEDBACK_LABELS.miss),
		}),
		[i18n],
	);
	const showsVocals = layout !== null && (layout.lyrics !== null || layout.vocalLane !== null);
	useFocusLoop(runtime, layout, mainRef, sideRefs, vocalsRef, others, showsVocals ? vocals : null, feedbackLabels);
	const speaking = useSpeakingUsers(channelId);
	const vocalsRect = layout?.vocalLane ?? layout?.lyrics ?? null;

	return (
		<div ref={rootRef} className={sharedStyles.stage} data-flx="activities.band.game.focus-stage.stage">
			<canvas ref={mainRef} className={sharedStyles.canvas} data-flx="activities.band.game.focus-stage.main-canvas" />
			{layout?.sides.map((side, index) => (
				<canvas
					key={side.side}
					ref={(canvas) => {
						sideRefs.current[index] = canvas;
					}}
					className={clsx(styles.side, side.pair && styles.sidePair)}
					style={{
						left: side.rect.left * layout.scale,
						top: side.rect.top * layout.scale,
						width: side.rect.width * layout.scale,
						height: side.rect.height * layout.scale,
					}}
					data-flx="activities.band.game.focus-stage.side-canvas"
				/>
			))}
			{layout && (
				<div
					className={sharedStyles.frame}
					style={{width: layout.frameWidth, height: FOCUS_HEIGHT, transform: `scale(${layout.scale})`}}
					data-flx="activities.band.game.focus-stage.frame"
				>
					{!layout.compact && (
						<Header
							runtime={runtime}
							entry={entry}
							controller={controller}
							data-flx="activities.band.game.focus-stage.header"
						/>
					)}
					{vocalsRect && vocalsSeat && (
						<div
							className={clsx(styles.vocals, layout.vocalLane && styles.vocalLane)}
							style={rectStyle(vocalsRect)}
							data-flx="activities.band.game.focus-stage.vocals"
						>
							{layout.lyrics && (
								<span className={styles.singer} data-flx="activities.band.game.focus-stage.singer">
									<BandAvatar
										userId={vocalsSeat.userId}
										size={22}
										data-flx="activities.band.game.focus-stage.singer-avatar"
									/>
									{bandDisplayName(vocalsSeat.userId)}
								</span>
							)}
							<canvas
								ref={vocalsRef}
								className={styles.vocalsCanvas}
								data-flx="activities.band.game.focus-stage.vocals-canvas"
							/>
						</div>
					)}
					{layout.sides.flatMap((side) =>
						side.others.map((other, slot) => (
							<SideLabel
								key={`${others[other].part}:${others[other].seat.userId}`}
								entry={entry}
								track={others[other]}
								rect={side.labels[slot]}
								align={side.side}
								pair={side.pair}
								speaking={speaking.has(others[other].seat.userId)}
								data-flx="activities.band.game.focus-stage.side-label"
							/>
						)),
					)}
					{layout.hud && mine && (
						<Hud
							entry={entry}
							track={mine}
							rect={layout.hud}
							speaking={speaking.has(mine.seat.userId)}
							data-flx="activities.band.game.focus-stage.hud"
						/>
					)}
					{layout.hud && singing && vocalsSeat && (
						<SingerHud
							entry={entry}
							seat={vocalsSeat}
							rect={layout.hud}
							speaking={speaking.has(vocalsSeat.userId)}
							data-flx="activities.band.game.focus-stage.singer-hud"
						/>
					)}
					{controller.finaleActive && layout.main && (
						<FinaleBanner
							runtime={runtime}
							layout={layout.main}
							toOverlay={(x, y) => ({x: x / layout.scale, y: y / layout.scale})}
							style={{left: layout.mainRect.left, width: layout.mainRect.width, top: layout.mainRect.top + 36}}
							data-flx="activities.band.game.focus-stage.finale-banner"
						/>
					)}
				</div>
			)}
			{layout?.compact && mine && (
				<CompactScore track={mine} data-flx="activities.band.game.focus-stage.compact-score" />
			)}
		</div>
	);
});
