// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandIntent, BandSongSummary} from '@app/features/activities/band/BandProtocol';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {BandDebugOverlay, useBandDebug} from '@app/features/activities/band/game/BandDebugOverlay';
import {BandKeyboard, type BandKeyMap, DEFAULT_BAND_KEY_MAP} from '@app/features/activities/band/game/BandInput';
import BandSettings from '@app/features/activities/band/game/BandSettings';
import {BandSettingsPanel} from '@app/features/activities/band/game/BandSettingsPanel';
import {FocusStage} from '@app/features/activities/band/game/FocusStage';
import {
	BandAudioUnavailableError,
	type BandPlayState,
	PlayRuntime,
} from '@app/features/activities/band/game/PlayRuntime';
import styles from '@app/features/activities/band/game/PlayScreen.module.css';
import {PlayStage} from '@app/features/activities/band/game/PlayStage';
import {hasFocusPart} from '@app/features/activities/band/game/PlayStageParts';
import ActivityViewDock from '@app/features/activities/components/ActivityViewDock';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {autorun} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useCallback, useEffect, useRef, useState} from 'react';

const logger = new Logger('BandPlayScreen');

const LOADING_DESCRIPTOR = msg({
	message: 'Getting the song ready...',
	comment: 'Band game: shown while the song audio is decoded, right before it starts.',
});
const NO_AUDIO_DESCRIPTOR = msg({
	message: 'This device cannot play the song audio.',
	comment: 'Band game: shown instead of the game when the browser has no Web Audio support.',
});
const LOAD_FAILED_DESCRIPTOR = msg({
	message: 'The song could not be loaded on this device.',
	comment: 'Band game: shown when the song audio or chart could not be read on this device.',
});

type LoadStatus = 'loading' | 'ready' | 'noAudio' | 'failed';

export interface PlayScreenProps {
	readonly session: ActivitySession;
	readonly state: BandPlayState;
	readonly entry: BandSongSummary;
	readonly songPackage: SongPackage;
	// My own messages never come back to me, so while I lead, the flow applies my result through this.
	readonly onOwnIntent?: (intent: BandIntent) => void;
	readonly keyMap?: BandKeyMap;
}

// The room is still on this run of the song: what goes away is only this View (a window made narrow, the panel closed).
function sameRunStillPlaying(session: ActivitySession, state: BandPlayState): boolean {
	const current = session.state as Partial<BandPlayState> | null;
	return current?.phase === 'play' && current.songId === state.songId && current.startAt === state.startAt;
}

// `quiet` holds the song silent on this device while a timing test listens for the player's taps.
function usePlayRuntime({session, state, entry, songPackage, onOwnIntent}: PlayScreenProps, quiet: boolean) {
	const [runtime, setRuntime] = useState<PlayRuntime | null>(null);
	const [status, setStatus] = useState<LoadStatus>('loading');
	const ownIntentRef = useRef(onOwnIntent);
	ownIntentRef.current = onOwnIntent;

	useEffect(() => {
		let cancelled = false;
		let started: PlayRuntime | null = null;
		setStatus('loading');
		setRuntime(null);
		PlayRuntime.start({
			session,
			state,
			entry,
			songPackage,
			inputLatencyMs: () => BandSettings.effectiveInputLatencyMs,
			visualOffsetMs: () => BandSettings.visualOffsetMs,
			missSound: () => BandSettings.missSound,
			duckDepth: () => BandSettings.duckDepth,
			submitIntent: (intent) => {
				if (session.isLeader) {
					ownIntentRef.current?.(intent);
					return;
				}
				const leader = session.leader;
				if (leader) void session.send(intent, {to: [leader.identity]});
			},
		}).then(
			(next) => {
				if (cancelled) {
					next.dispose();
					return;
				}
				started = next;
				setRuntime(next);
				setStatus('ready');
			},
			(error: unknown) => {
				if (cancelled) return;
				if (!(error instanceof BandAudioUnavailableError)) logger.warn('Song failed to start', {error});
				setStatus(error instanceof BandAudioUnavailableError ? 'noAudio' : 'failed');
			},
		);
		return () => {
			cancelled = true;
			// Once the room has left this run (the song ended or the leader stopped it) the leader gets what I scored;
			// a result already sent is not sent again. A View that goes while the song plays on reports nothing: a
			// partial score would count as my result, and as the last one missing it would end the song for everyone.
			if (started && !sameRunStillPlaying(session, state)) started.controller.finish({stopped: true});
			started?.dispose();
		};
		// A new play state for the same song (a seat change) must not restart the audio; startAt identifies the run.
	}, [session, state.startAt, state.songId, songPackage]);

	useEffect(() => {
		if (!runtime) return;
		return autorun(() => runtime.audio.setVolume(quiet ? 0 : BandSettings.volume));
	}, [runtime, quiet]);

	return {runtime, status};
}

// Keys go to the game only while the activity holds the keyboard. The root takes focus so they land here, unless
// focus is somewhere else the player chose (the message box) and the View is not on the stage. While the settings
// panel is open (`paused`) the keys are its own, and whatever the game held is let go.
function useBandKeyboard(
	rootRef: RefObject<HTMLDivElement | null>,
	runtime: PlayRuntime | null,
	session: ActivitySession,
	keyMap: BandKeyMap,
	paused: boolean,
): void {
	useEffect(() => {
		const root = rootRef.current;
		const track = runtime?.controller.myTrack;
		if (!root || !runtime || !track || paused) return;
		const keyboard = new BandKeyboard(keyMap, track.part, {
			onLane: (input) => runtime.lane(input),
			onStarPower: (timeStamp) => runtime.controller.deployStarPower(runtime.inputMs(timeStamp)),
			onWhammy: (input) => runtime.whammyKey(input),
		});
		const onKeyDown = (event: KeyboardEvent) => {
			if (session.keyboardCaptured && keyboard.keyDown(event)) event.preventDefault();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (keyboard.keyUp(event)) event.preventDefault();
		};
		const onFocusOut = (event: FocusEvent) => {
			if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) {
				keyboard.releaseAll(event.timeStamp);
			}
		};
		root.addEventListener('keydown', onKeyDown);
		root.addEventListener('keyup', onKeyUp);
		root.addEventListener('focusout', onFocusOut);
		if (ActivityViewDock.mayTakeFocus(root)) root.focus({preventScroll: true});
		return () => {
			root.removeEventListener('keydown', onKeyDown);
			root.removeEventListener('keyup', onKeyUp);
			root.removeEventListener('focusout', onFocusOut);
			keyboard.releaseAll(performance.now());
		};
	}, [rootRef, runtime, session, keyMap, paused]);
}

// The play phase: the highways, my input and audio. Players see the focus view unless they chose the band view;
// spectators, who have no part of their own to focus on, always watch the band view.
export const PlayScreen = observer(function PlayScreen(props: PlayScreenProps) {
	const {i18n} = useLingui();
	const rootRef = useRef<HTMLDivElement>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [testing, setTesting] = useState(false);
	const {runtime, status} = usePlayRuntime(props, testing);
	useBandKeyboard(rootRef, runtime, props.session, props.keyMap ?? DEFAULT_BAND_KEY_MAP, settingsOpen);
	const debug = useBandDebug(rootRef);
	const openSettings = useCallback(() => setSettingsOpen(true), []);
	const closeSettings = useCallback(() => {
		setSettingsOpen(false);
		setTesting(false);
	}, []);
	const vocals = runtime ? props.songPackage.chart().vocals : null;
	const focus = runtime !== null && hasFocusPart(runtime.controller, vocals) && BandSettings.highwayView === 'focus';
	const Stage = focus ? FocusStage : PlayStage;
	return (
		<div
			ref={rootRef}
			className={styles.root}
			role="application"
			aria-label={props.entry.name}
			tabIndex={-1}
			data-flx="activities.band.game.play-screen.root"
		>
			{runtime && status === 'ready' ? (
				<Stage
					runtime={runtime}
					entry={props.entry}
					channelId={props.session.channelId}
					vocals={vocals}
					onOpenSettings={openSettings}
					data-flx="activities.band.game.play-screen.play-stage"
				/>
			) : (
				<div className={styles.status} role="status" data-flx="activities.band.game.play-screen.status">
					{i18n._(
						status === 'noAudio'
							? NO_AUDIO_DESCRIPTOR
							: status === 'failed'
								? LOAD_FAILED_DESCRIPTOR
								: LOADING_DESCRIPTOR,
					)}
				</div>
			)}
			{runtime && debug && <BandDebugOverlay runtime={runtime} data-flx="activities.band.game.play-screen.debug" />}
			{settingsOpen && (
				<BandSettingsPanel
					onClose={closeSettings}
					onRunningChange={setTesting}
					data-flx="activities.band.game.play-screen.settings-panel"
				/>
			)}
		</div>
	);
});
