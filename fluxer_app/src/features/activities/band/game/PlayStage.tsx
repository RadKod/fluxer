// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import type {BandSeat, BandSongSummary} from '@app/features/activities/band/BandProtocol';
import type {VocalsChart} from '@app/features/activities/band/engine/VocalsParser';
import {
	DIFFICULTY_LABELS,
	FEEDBACK_LABELS,
	partLabel,
	SEAT_DESCRIPTOR,
} from '@app/features/activities/band/game/BandGameLabels';
import BandSettings from '@app/features/activities/band/game/BandSettings';
import {
	DESIGN_HEIGHT,
	DESIGN_WIDTH,
	type HighwayKind,
	highwayAnchor,
	layoutStage,
	noteDistance,
	type StageLayout,
	strikeDistance,
	toFrame,
} from '@app/features/activities/band/game/HighwayGeometry';
import {type HighwayFrame, HighwayRenderer} from '@app/features/activities/band/game/HighwayRenderer';
import {MultiplierBadge} from '@app/features/activities/band/game/MultiplierBadge';
import type {FeedbackKind, PlayController, SeatTrack} from '@app/features/activities/band/game/PlayController';
import type {PlayRuntime} from '@app/features/activities/band/game/PlayRuntime';
import styles from '@app/features/activities/band/game/PlayScreen.module.css';
import {VocalsRenderer} from '@app/features/activities/band/game/VocalsRenderer';
import {formatNumber} from '@app/features/i18n/utils/IntlCache';
import {Avatar} from '@app/features/ui/components/Avatar';
import Users from '@app/features/user/state/Users';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {useVoiceParticipantAvatarEntries} from '@app/features/voice/components/VoiceParticipantAvatarList';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useEffect, useMemo, useRef, useState} from 'react';

const YOU_DESCRIPTOR = msg({
	message: 'You',
	context: 'band-player-self',
	comment: 'Band game: small tag next to my own name under my highway.',
});
const STAR_POWER_ON_DESCRIPTOR = msg({
	message: 'Star power on',
	comment: 'Band game: replaces part and difficulty under a player name while their star power doubles the score.',
});
const GROUP_METER_DESCRIPTOR = msg({
	message: 'Group',
	context: 'band-meter',
	comment: 'Band game: label under the vertical meter that shows how well the whole band is doing. Very short.',
});
const GROUP_METER_LABEL_DESCRIPTOR = msg({
	message: 'How the band is doing',
	comment: 'Band game: accessible name of the vertical band meter.',
});
const STARS_DESCRIPTOR = msg({
	message: '{stars} of 5 stars',
	comment: 'Band game: accessible text for the star rating next to the band score. {stars} may have one decimal.',
});
const FINALE_TITLE_DESCRIPTOR = msg({
	message: 'Big finale',
	comment: 'Band game: big title during the Big Rock Ending, the free-play section at the end of a song.',
});
const FINALE_HINT_DESCRIPTOR = msg({
	message: 'Every key plays. Hit the last note all together.',
	comment: 'Band game: line under the Big finale title explaining the free play and the shared final hit.',
});
const FINALE_COUNTDOWN_DESCRIPTOR = msg({
	message: 'Final hit in {seconds} s',
	comment: 'Band game: chip above the final hit bar counting down whole seconds until everyone must hit it.',
});
const FINALE_BONUS_DESCRIPTOR = msg({
	message: 'Finale bonus',
	comment: 'Band game: label for the points collected during the Big Rock Ending, shown under the band score.',
});
const VOLUME_DESCRIPTOR = msg({
	message: 'Song volume',
	comment: 'Band game: label of the slider that sets how loud the song plays on this device.',
});

const BADGE_OFFSET = 12;

function formatClock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function displayName(userId: string): string {
	const user = Users.getUser(userId);
	if (!user) return userId;
	return NicknameUtils.getNickname(user, MediaEngine.guildId, MediaEngine.channelId ?? undefined);
}

// Re-renders the caller every `intervalMs` with the heard song time; for the clock-driven parts of the HUD.
function useSongTime(runtime: PlayRuntime, intervalMs: number): number {
	const [songMs, setSongMs] = useState(() => runtime.heardMs());
	useEffect(() => {
		const timer = setInterval(() => setSongMs(runtime.heardMs()), intervalMs);
		return () => clearInterval(timer);
	}, [runtime, intervalMs]);
	return songMs;
}

function useElementSize(ref: RefObject<HTMLElement | null>): {width: number; height: number} {
	const [size, setSize] = useState({width: 0, height: 0});
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			const {width, height} = entry.contentRect;
			setSize((previous) => (previous.width === width && previous.height === height ? previous : {width, height}));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return size;
}

// `zoom` is any CSS scale the canvas sits under, so its pixels match the screen.
function resizeCanvas(
	canvas: HTMLCanvasElement,
	width: number,
	height: number,
	zoom = 1,
): CanvasRenderingContext2D | null {
	const ratio = (window.devicePixelRatio || 1) * zoom;
	canvas.width = Math.max(1, Math.round(width * ratio));
	canvas.height = Math.max(1, Math.round(height * ratio));
	const ctx = canvas.getContext('2d');
	ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
	return ctx;
}

// One requestAnimationFrame loop per stage: ticks the controller and draws highways and vocals from song time.
// While the page is hidden there are no frames, so a slow timer keeps judging and ends the song on time.
function useStageLoop(
	runtime: PlayRuntime,
	layout: StageLayout | null,
	canvasRef: RefObject<HTMLCanvasElement | null>,
	vocalsCanvasRef: RefObject<HTMLCanvasElement | null>,
	vocals: VocalsChart | null,
	feedbackLabels: Readonly<Record<FeedbackKind, string>>,
): void {
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !layout) return;
		const ctx = resizeCanvas(canvas, layout.width, layout.height);
		if (!ctx) return;
		const renderer = new HighwayRenderer(ctx);
		renderer.setLayout(layout);
		const vocalsCanvas = vocalsCanvasRef.current;
		const vocalsWidth = vocalsCanvas?.clientWidth ?? 0;
		const vocalsHeight = vocalsCanvas?.clientHeight ?? 0;
		const vocalsCtx = vocalsCanvas ? resizeCanvas(vocalsCanvas, vocalsWidth, vocalsHeight, layout.scale) : null;
		const vocalsRenderer = vocals && vocalsCtx ? new VocalsRenderer(vocalsCtx, vocals) : null;
		const {controller} = runtime;
		const fontFamily = getComputedStyle(canvas).fontFamily || 'sans-serif';

		let frameId = 0;
		const draw = () => {
			controller.tick(runtime.judgeMs());
			const nowMs = runtime.heardMs();
			const frame: HighwayFrame = {
				nowMs,
				tracks: controller.tracks,
				finale: controller.finale,
				reducedMotion: Accessibility.useReducedMotion,
				feedbackLabels,
				fontFamily,
			};
			renderer.draw(frame);
			vocalsRenderer?.draw(vocalsWidth, vocalsHeight, nowMs, fontFamily);
			frameId = requestAnimationFrame(draw);
		};
		let hiddenTimer: ReturnType<typeof setInterval> | null = null;
		const onVisibility = () => {
			cancelAnimationFrame(frameId);
			if (hiddenTimer) clearInterval(hiddenTimer);
			hiddenTimer = null;
			if (document.visibilityState === 'hidden') {
				hiddenTimer = setInterval(() => controller.tick(runtime.judgeMs()), 250);
			} else {
				frameId = requestAnimationFrame(draw);
			}
		};
		document.addEventListener('visibilitychange', onVisibility);
		onVisibility();
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			cancelAnimationFrame(frameId);
			if (hiddenTimer) clearInterval(hiddenTimer);
		};
	}, [runtime, layout, canvasRef, vocalsCanvasRef, vocals, feedbackLabels]);
}

const StarRating = observer(function StarRating({value}: {value: number}) {
	const {i18n} = useLingui();
	return (
		<span
			className={styles.stars}
			role="img"
			aria-label={i18n._(STARS_DESCRIPTOR, {stars: Math.floor(value * 10) / 10})}
			data-flx="activities.band.game.play-stage.star-rating.stars"
		>
			{[0, 1, 2, 3, 4].map((index) => {
				const fill = Math.min(1, Math.max(0, value - index));
				return (
					<span key={index} className={styles.star} data-flx="activities.band.game.play-stage.star-rating.star">
						<svg
							viewBox="0 0 24 24"
							className={styles.starBack}
							aria-hidden="true"
							data-flx="activities.band.game.play-stage.star-rating.star-back"
						>
							<path
								d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.5l-5.4 2.9 1.2-5.9L3.4 9.4l6-.7z"
								data-flx="activities.band.game.play-stage.star-rating.path"
							/>
						</svg>
						<span
							className={styles.starClip}
							style={{width: `${fill * 100}%`}}
							data-flx="activities.band.game.play-stage.star-rating.star-clip"
						>
							<svg
								viewBox="0 0 24 24"
								className={styles.starFront}
								aria-hidden="true"
								data-flx="activities.band.game.play-stage.star-rating.star-front"
							>
								<path
									d="M12 3.2l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L12 16.5l-5.4 2.9 1.2-5.9L3.4 9.4l6-.7z"
									data-flx="activities.band.game.play-stage.star-rating.path--2"
								/>
							</svg>
						</span>
					</span>
				);
			})}
		</span>
	);
});

const ScoreBox = observer(function ScoreBox({controller}: {controller: PlayController}) {
	const {i18n} = useLingui();
	const locale = getCurrentLocale();
	const bonus = controller.groupFinaleBonus;
	return (
		<div className={styles.score} data-flx="activities.band.game.play-stage.score-box.score">
			<b
				className={clsx(styles.scoreValue, styles.num)}
				data-flx="activities.band.game.play-stage.score-box.score-value"
			>
				{formatNumber(Math.round(controller.groupScore), locale)}
			</b>
			<StarRating value={controller.stars} data-flx="activities.band.game.play-stage.score-box.star-rating" />
			{controller.finale && bonus > 0 && (
				<div className={styles.bonus} data-flx="activities.band.game.play-stage.score-box.bonus">
					{i18n._(FINALE_BONUS_DESCRIPTOR)}{' '}
					<b className={styles.num} data-flx="activities.band.game.play-stage.score-box.num">
						+{formatNumber(bonus, locale)}
					</b>
				</div>
			)}
		</div>
	);
});

const SongInfo = observer(function SongInfo({runtime, entry}: {runtime: PlayRuntime; entry: BandSongSummary}) {
	const {i18n} = useLingui();
	const songMs = useSongTime(runtime, 500);
	const share = entry.lengthMs > 0 ? Math.min(1, Math.max(0, songMs / entry.lengthMs)) : 0;
	return (
		<div data-flx="activities.band.game.play-stage.song-info.div">
			<b className={styles.songName} data-flx="activities.band.game.play-stage.song-info.song-name">
				{entry.name}
			</b>
			<span className={styles.songArtist} data-flx="activities.band.game.play-stage.song-info.song-artist">
				{entry.artist}
			</span>
			<div className={styles.progress} data-flx="activities.band.game.play-stage.song-info.progress">
				<span className={styles.num} data-flx="activities.band.game.play-stage.song-info.num">
					{formatClock(songMs)}
				</span>
				<span className={styles.progressTrack} data-flx="activities.band.game.play-stage.song-info.progress-track">
					<i
						className={styles.progressFill}
						style={{width: `${share * 100}%`}}
						data-flx="activities.band.game.play-stage.song-info.progress-fill"
					/>
				</span>
				<span className={styles.num} data-flx="activities.band.game.play-stage.song-info.num--2">
					{formatClock(entry.lengthMs)}
				</span>
			</div>
			<label className={styles.volume} data-flx="activities.band.game.play-stage.song-info.volume">
				{i18n._(VOLUME_DESCRIPTOR)}
				<input
					type="range"
					min={0}
					max={1}
					step={0.05}
					value={BandSettings.volume}
					onChange={(event) => BandSettings.setVolume(Number(event.currentTarget.value))}
					data-flx="activities.band.game.play-stage.song-info.input.set-volume.range"
				/>
			</label>
		</div>
	);
});

const GroupMeter = observer(function GroupMeter({controller}: {controller: PlayController}) {
	const {i18n} = useLingui();
	const value = controller.groupPerformance;
	return (
		<>
			<div
				className={styles.meter}
				role="meter"
				aria-label={i18n._(GROUP_METER_LABEL_DESCRIPTOR)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(value * 100)}
				data-flx="activities.band.game.play-stage.group-meter.meter"
			>
				<i
					className={styles.meterFill}
					style={{height: `${value * 100}%`}}
					data-flx="activities.band.game.play-stage.group-meter.meter-fill"
				/>
			</div>
			<span className={styles.meterLabel} data-flx="activities.band.game.play-stage.group-meter.meter-label">
				{i18n._(GROUP_METER_DESCRIPTOR)}
			</span>
		</>
	);
});

const FinaleBanner = observer(function FinaleBanner({runtime, layout}: {runtime: PlayRuntime; layout: StageLayout}) {
	const {i18n} = useLingui();
	const songMs = useSongTime(runtime, 100);
	const {finale} = runtime.controller;
	if (!finale || songMs > finale.endMs + 1_000) return null;
	const leftMs = finale.endMs - songMs;
	const distance = noteDistance(layout, leftMs);
	const showCountdown = leftMs > 0 && distance <= layout.planeLength;
	const chip = toFrame(layout, layout.originX, highwayAnchor(layout, layout.highways[0], distance).y);
	return (
		<>
			<div className={styles.finale} data-flx="activities.band.game.play-stage.finale-banner.finale">
				<h2 data-flx="activities.band.game.play-stage.finale-banner.h2">{i18n._(FINALE_TITLE_DESCRIPTOR)}</h2>
				<p data-flx="activities.band.game.play-stage.finale-banner.p">{i18n._(FINALE_HINT_DESCRIPTOR)}</p>
			</div>
			{showCountdown && (
				<span
					className={clsx(styles.countdown, styles.num)}
					style={{left: chip.x, top: chip.y}}
					data-flx="activities.band.game.play-stage.finale-banner.countdown"
				>
					{i18n._(FINALE_COUNTDOWN_DESCRIPTOR, {seconds: Math.ceil(leftMs / 1000)})}
				</span>
			)}
		</>
	);
});

function useSpeakingUsers(channelId: string): ReadonlySet<string> {
	const entries = useVoiceParticipantAvatarEntries({guildId: MediaEngine.guildId, channelId});
	return useMemo(() => new Set(entries.filter((entry) => entry.speaking).map((entry) => entry.userId)), [entries]);
}

const PlayerIdentity = observer(function PlayerIdentity({
	entry,
	seat,
	isMine,
	speaking,
	starPower,
}: {
	entry: BandSongSummary;
	seat: BandSeat;
	isMine: boolean;
	speaking: boolean;
	starPower: boolean;
}) {
	const {i18n} = useLingui();
	const user = Users.getUser(seat.userId);
	return (
		<>
			{user && (
				<span
					className={clsx(styles.avatar, speaking && styles.speaking)}
					data-flx="activities.band.game.play-stage.player-identity.avatar"
				>
					<Avatar user={user} size={32} data-flx="activities.band.game.play-stage.player-identity.avatar--2" />
				</span>
			)}
			<div className={styles.who} data-flx="activities.band.game.play-stage.player-identity.who">
				<b data-flx="activities.band.game.play-stage.player-identity.b">
					{displayName(seat.userId)}
					{isMine && (
						<span className={styles.selfTag} data-flx="activities.band.game.play-stage.player-identity.self-tag">
							{i18n._(YOU_DESCRIPTOR)}
						</span>
					)}
				</b>
				{starPower ? (
					<span className={styles.starPowerOn} data-flx="activities.band.game.play-stage.player-identity.star-power-on">
						{i18n._(STAR_POWER_ON_DESCRIPTOR)}
					</span>
				) : (
					<span data-flx="activities.band.game.play-stage.player-identity.span">
						{i18n._(SEAT_DESCRIPTOR, {
							part: i18n._(partLabel(seat.part, entry)),
							difficulty: i18n._(DIFFICULTY_LABELS[seat.difficulty]),
						})}
					</span>
				)}
			</div>
		</>
	);
});

const HighwayHud = observer(function HighwayHud({
	entry,
	track,
	layout,
	index,
	speaking,
	finaleOn,
}: {
	entry: BandSongSummary;
	track: SeatTrack;
	layout: StageLayout;
	index: number;
	speaking: boolean;
	finaleOn: boolean;
}) {
	const highway = layout.highways[index];
	if (!highway) return null;
	const {hud} = track;
	const strike = highwayAnchor(layout, highway, strikeDistance(layout));
	const badge = toFrame(layout, strike.x, strike.y);
	const near = toFrame(layout, highway.left, 0);
	const locale = getCurrentLocale();
	return (
		<>
			<div
				className={styles.badge}
				style={{left: badge.x, top: badge.y + BADGE_OFFSET}}
				data-flx="activities.band.game.play-stage.highway-hud.badge"
			>
				<MultiplierBadge
					multiplier={hud.multiplier}
					starPower={hud.starPowerActive}
					label={finaleOn ? `+${formatNumber(hud.finaleBonus, locale)}` : undefined}
					energy={track.isMine ? hud.starPowerEnergy : undefined}
					data-flx="activities.band.game.play-stage.highway-hud.multiplier-badge"
				/>
			</div>
			<div
				className={styles.player}
				style={{left: near.x, width: highway.width / layout.scale}}
				data-flx="activities.band.game.play-stage.highway-hud.player"
			>
				<PlayerIdentity
					entry={entry}
					seat={track.seat}
					isMine={track.isMine}
					speaking={speaking}
					starPower={hud.starPowerActive}
					data-flx="activities.band.game.play-stage.highway-hud.player-identity"
				/>
			</div>
		</>
	);
});

const VocalsStrip = observer(function VocalsStrip({
	entry,
	seat,
	speaking,
	canvasRef,
}: {
	entry: BandSongSummary;
	seat: BandSeat;
	speaking: boolean;
	canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
	return (
		<div className={styles.vocals} data-flx="activities.band.game.play-stage.vocals-strip.vocals">
			<div className={styles.vocalsId} data-flx="activities.band.game.play-stage.vocals-strip.vocals-id">
				<PlayerIdentity
					entry={entry}
					seat={seat}
					isMine={false}
					speaking={speaking}
					starPower={false}
					data-flx="activities.band.game.play-stage.vocals-strip.player-identity"
				/>
			</div>
			<div className={styles.vocalsTrack} data-flx="activities.band.game.play-stage.vocals-strip.vocals-track">
				<canvas
					ref={canvasRef}
					className={styles.vocalsCanvas}
					data-flx="activities.band.game.play-stage.vocals-strip.vocals-canvas"
				/>
			</div>
		</div>
	);
});

interface PlayStageProps {
	readonly runtime: PlayRuntime;
	readonly entry: BandSongSummary;
	readonly channelId: string;
	readonly vocals: VocalsChart | null;
}

export const PlayStage = observer(function PlayStage({runtime, entry, channelId, vocals}: PlayStageProps) {
	const {i18n} = useLingui();
	const rootRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const vocalsCanvasRef = useRef<HTMLCanvasElement>(null);
	const {width, height} = useElementSize(rootRef);
	const {controller} = runtime;
	const kinds = useMemo(
		() => controller.tracks.map((track): HighwayKind => (track.part === 'drums' ? 'drums' : 'frets')),
		[controller],
	);
	const layout = useMemo(
		() => (width > 0 && height > 0 ? layoutStage(width, height, kinds) : null),
		[width, height, kinds],
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
	const vocalsSeat = vocals ? controller.vocalsSeat : null;
	useStageLoop(runtime, layout, canvasRef, vocalsCanvasRef, vocalsSeat ? vocals : null, feedbackLabels);
	const speaking = useSpeakingUsers(channelId);
	const finaleOn = controller.finaleActive;

	return (
		<div ref={rootRef} className={styles.stage} data-flx="activities.band.game.play-stage.stage">
			<canvas ref={canvasRef} className={styles.canvas} data-flx="activities.band.game.play-stage.canvas" />
			{layout && (
				<div
					className={styles.frame}
					style={{
						width: DESIGN_WIDTH,
						height: DESIGN_HEIGHT,
						transform: `translate(${layout.frameLeft}px, ${layout.frameTop}px) scale(${layout.scale})`,
					}}
					data-flx="activities.band.game.play-stage.frame"
				>
					{vocalsSeat && (
						<VocalsStrip
							entry={entry}
							seat={vocalsSeat}
							speaking={speaking.has(vocalsSeat.userId)}
							canvasRef={vocalsCanvasRef}
							data-flx="activities.band.game.play-stage.vocals-strip"
						/>
					)}
					<div
						className={clsx(styles.info, !vocalsSeat && styles.infoNoVocals)}
						data-flx="activities.band.game.play-stage.info"
					>
						<SongInfo runtime={runtime} entry={entry} data-flx="activities.band.game.play-stage.song-info" />
						<ScoreBox controller={controller} data-flx="activities.band.game.play-stage.score-box" />
					</div>
					<GroupMeter controller={controller} data-flx="activities.band.game.play-stage.group-meter" />
					{finaleOn && (
						<FinaleBanner runtime={runtime} layout={layout} data-flx="activities.band.game.play-stage.finale-banner" />
					)}
					{controller.tracks.map((track, index) => (
						<HighwayHud
							key={`${track.part}:${track.seat.userId}`}
							entry={entry}
							track={track}
							layout={layout}
							index={index}
							speaking={speaking.has(track.seat.userId)}
							finaleOn={finaleOn}
							data-flx="activities.band.game.play-stage.highway-hud"
						/>
					))}
				</div>
			)}
		</div>
	);
});
