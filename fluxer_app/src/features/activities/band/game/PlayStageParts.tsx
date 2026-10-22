// SPDX-License-Identifier: AGPL-3.0-or-later

// What the band view (PlayStage) and the focus view (FocusStage) share: the frame loop, the song clock for the HUD,
// the Big Rock Ending banner, player status lines, the volume slider and the switch between the two views.

import type {VocalsChart} from '@app/features/activities/band/engine/VocalsParser';
import BandSettings, {type BandHighwayView} from '@app/features/activities/band/game/BandSettings';
import {FramePacer} from '@app/features/activities/band/game/FramePacer';
import {highwayAnchor, noteDistance, type StageLayout} from '@app/features/activities/band/game/HighwayGeometry';
import type {PlayController, SeatHud} from '@app/features/activities/band/game/PlayController';
import type {PlayRuntime} from '@app/features/activities/band/game/PlayRuntime';
import styles from '@app/features/activities/band/game/PlayScreen.module.css';
import {formatNumber} from '@app/features/i18n/utils/IntlCache';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import {useVoiceParticipantAvatarEntries} from '@app/features/voice/components/VoiceParticipantAvatarList';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useId, useMemo, useState} from 'react';

export const STAR_POWER_ON_DESCRIPTOR = msg({
	message: 'Star power on',
	comment: 'Band game: replaces part and difficulty under a player name while their star power doubles the score.',
});
export const FINALE_TITLE_DESCRIPTOR = msg({
	message: 'Big finale',
	comment:
		'Band game: title during the Big Rock Ending, the free-play section at the end of a song; big over the stage and small under each player name while they free-play.',
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
	comment:
		'Band game: under a player name after they landed the final hit of the Big Rock Ending, with the bonus now added to the score.',
});
export const FINALE_BONUS_AT_STAKE_DESCRIPTOR = msg({
	message: 'Finale bonus at stake',
	comment:
		'Band game: under the band score during the Big Rock Ending, the bonus the band has collected so far. It is not in the score yet; each player keeps their share only by landing the final hit.',
});
const FINALE_BONUS_LOST_DESCRIPTOR = msg({
	message: 'Finale bonus lost',
	comment:
		'Band game: under a player name once they missed the final hit of the Big Rock Ending, so the points they collected in it do not count.',
});
export const SING_HINT_DESCRIPTOR = msg({
	message: 'Your mic is open, sing!',
	comment:
		'Band game: small hint on the lyrics strip for the singer; their mic stays open in the call during the song.',
});
const VOLUME_DESCRIPTOR = msg({
	message: 'Song volume',
	comment: 'Band game: label of the slider that sets how loud the song plays on this device.',
});
const VIEW_DESCRIPTOR = msg({
	message: 'View',
	context: 'band-highway-view',
	comment: 'Band game: accessible name of the switch between the focus view and the band view during a song.',
});
const VIEW_DESCRIPTORS: Readonly<Record<BandHighwayView, MessageDescriptor>> = {
	focus: msg({
		message: 'Focus',
		context: 'band-highway-view',
		comment:
			'Band game: view option during a song; my own highway large in the middle, the bandmates smaller and blurred at the sides.',
	}),
	group: msg({
		message: 'Band',
		context: 'band-highway-view',
		comment: 'Band game: view option during a song; every highway the same size side by side.',
	}),
};

// The far end of the highway sits under the banner's hint, so the countdown chip waits until the bar is clear of it.
const COUNTDOWN_MAX_SHARE = 0.8;
// Hidden pages get no animation frames; this keeps judging and ends the song on time.
const HIDDEN_TICK_MS = 250;

export function formatClock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Re-renders the caller every `intervalMs` with the heard song time; for the clock-driven parts of the HUD.
export function useSongTime(runtime: PlayRuntime, intervalMs: number): number {
	const [songMs, setSongMs] = useState(() => runtime.heardMs());
	useEffect(() => {
		const timer = setInterval(() => setSongMs(runtime.heardMs()), intervalMs);
		return () => clearInterval(timer);
	}, [runtime, intervalMs]);
	return songMs;
}

export function useSpeakingUsers(channelId: string): ReadonlySet<string> {
	const entries = useVoiceParticipantAvatarEntries({guildId: MediaEngine.guildId, channelId});
	return useMemo(() => new Set(entries.filter((entry) => entry.speaking).map((entry) => entry.userId)), [entries]);
}

// `zoom` is the share of the screen's pixel density to draw at: a CSS scale the canvas sits under, or less than one
// for a canvas that is blurred anyway.
export function resizeCanvas(
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

// One requestAnimationFrame loop: ticks the controller, then hands the frame its song time (the time the frame will
// be seen at) and its rAF timestamp. While the page is hidden a slow timer only judges. Returns the stop function.
export function runFrameLoop(
	runtime: PlayRuntime,
	onFrame: (nowMs: number, frameTimestamp: number) => void,
): () => void {
	const {controller} = runtime;
	const pacer = new FramePacer();
	let frameId = 0;
	const draw = (frameTimestamp: number) => {
		controller.tick(runtime.judgeMs());
		onFrame(runtime.heardMsAt(pacer.presentAt(frameTimestamp)), frameTimestamp);
		frameId = requestAnimationFrame(draw);
	};
	let hiddenTimer: ReturnType<typeof setInterval> | null = null;
	const onVisibility = () => {
		cancelAnimationFrame(frameId);
		if (hiddenTimer) clearInterval(hiddenTimer);
		hiddenTimer = null;
		if (document.visibilityState === 'hidden') {
			hiddenTimer = setInterval(() => controller.tick(runtime.judgeMs()), HIDDEN_TICK_MS);
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
}

interface FinaleBannerProps {
	readonly runtime: PlayRuntime;
	// The plane the countdown chip rides on, and how its canvas points map into the overlay the banner sits in.
	readonly layout: StageLayout;
	readonly toOverlay: (x: number, y: number) => {readonly x: number; readonly y: number};
	readonly className?: string;
	readonly style?: React.CSSProperties;
}

// "Big finale" over the highways during the Big Rock Ending, and the seconds left to the shared final hit.
export const FinaleBanner = observer(function FinaleBanner({
	runtime,
	layout,
	toOverlay,
	className,
	style,
}: FinaleBannerProps) {
	const {i18n} = useLingui();
	const songMs = useSongTime(runtime, 100);
	const {finalHitMs} = runtime.controller;
	const [highway] = layout.highways;
	if (finalHitMs === null || !highway) return null;
	const leftMs = finalHitMs - songMs;
	const distance = noteDistance(layout, leftMs);
	const showCountdown = leftMs > 0 && distance <= layout.planeLength * COUNTDOWN_MAX_SHARE;
	const chip = toOverlay(layout.originX, highwayAnchor(layout, highway, distance).y);
	return (
		<>
			<div
				className={clsx(styles.finale, className)}
				style={style}
				data-flx="activities.band.game.play-stage.finale-banner.finale"
			>
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

export type PlayerStatusKind = 'finale' | 'finaleBanked' | 'finaleLost' | 'starPower';

// What replaces a player's usual line under their name, most important first; null for the usual line.
export function playerStatusKind(hud: SeatHud | null): PlayerStatusKind | null {
	if (!hud) return null;
	if (hud.finaleOn) return 'finale';
	if (hud.finalHit === true && hud.bankedFinaleBonus > 0) return 'finaleBanked';
	if (hud.finalHit === false && hud.finaleBonus > 0) return 'finaleLost';
	return hud.starPowerActive ? 'starPower' : null;
}

export const PlayerStatusText = observer(function PlayerStatusText({
	kind,
	hud,
}: {
	kind: PlayerStatusKind;
	hud: SeatHud;
}) {
	const {i18n} = useLingui();
	switch (kind) {
		case 'finale':
			return <>{i18n._(FINALE_TITLE_DESCRIPTOR)}</>;
		case 'finaleBanked':
			return (
				<>
					{i18n._(FINALE_BONUS_DESCRIPTOR)}{' '}
					<b className={styles.num} data-flx="activities.band.game.play-stage-parts.player-status-text.bonus">
						+{formatNumber(hud.bankedFinaleBonus, getCurrentLocale())}
					</b>
				</>
			);
		case 'finaleLost':
			return <>{i18n._(FINALE_BONUS_LOST_DESCRIPTOR)}</>;
		case 'starPower':
			return <>{i18n._(STAR_POWER_ON_DESCRIPTOR)}</>;
	}
});

export const VolumeControl = observer(function VolumeControl({className}: {className?: string}) {
	const {i18n} = useLingui();
	return (
		<label
			className={clsx(styles.volume, className)}
			data-flx="activities.band.game.play-stage-parts.volume-control.volume"
		>
			{i18n._(VOLUME_DESCRIPTOR)}
			<input
				type="range"
				min={0}
				max={1}
				step={0.05}
				value={BandSettings.volume}
				onChange={(event) => BandSettings.setVolume(Number(event.currentTarget.value))}
				data-flx="activities.band.game.play-stage-parts.volume-control.input.set-volume.range"
			/>
		</label>
	);
});

// Something of my own to put in the middle: my highway, or the vocal lane when I sing a song that has one.
export function hasFocusPart(controller: PlayController, vocals: VocalsChart | null): boolean {
	return controller.myTrack !== null || (controller.mySeat?.part === 'vocals' && vocals !== null);
}

// Focus or band view, for players; spectators always watch the band view.
export const ViewSwitch = observer(function ViewSwitch({className}: {className?: string}) {
	const {i18n} = useLingui();
	const labelId = useId();
	return (
		<div
			className={clsx(styles.viewSwitch, className)}
			role="radiogroup"
			aria-labelledby={labelId}
			data-flx="activities.band.game.play-stage-parts.view-switch.view-switch"
		>
			<span
				id={labelId}
				className={styles.viewSwitchLabel}
				data-flx="activities.band.game.play-stage-parts.view-switch.label"
			>
				{i18n._(VIEW_DESCRIPTOR)}
			</span>
			{(['focus', 'group'] as const).map((view) => (
				<button
					key={view}
					type="button"
					role="radio"
					aria-checked={BandSettings.highwayView === view}
					className={styles.viewOption}
					// The game keeps the keyboard: a click must not leave the focus on a button that Space would press.
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => BandSettings.setHighwayView(view)}
					data-flx="activities.band.game.play-stage-parts.view-switch.option.button"
				>
					{i18n._(VIEW_DESCRIPTORS[view])}
				</button>
			))}
		</div>
	);
});
