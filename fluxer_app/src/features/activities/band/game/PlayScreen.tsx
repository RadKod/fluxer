// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandIntent, BandSongSummary} from '@app/features/activities/band/BandProtocol';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {BandKeyboard, type BandKeyMap, DEFAULT_BAND_KEY_MAP} from '@app/features/activities/band/game/BandInput';
import BandSettings from '@app/features/activities/band/game/BandSettings';
import {
	BandAudioUnavailableError,
	type BandPlayState,
	PlayRuntime,
} from '@app/features/activities/band/game/PlayRuntime';
import styles from '@app/features/activities/band/game/PlayScreen.module.css';
import {PlayStage} from '@app/features/activities/band/game/PlayStage';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {autorun} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useEffect, useRef, useState} from 'react';

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

function usePlayRuntime({session, state, entry, songPackage, onOwnIntent}: PlayScreenProps) {
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
			// The screen goes when the phase leaves play (the song ended or was stopped) or the panel closes; either
			// way the leader gets what I scored. A result already sent is not sent again.
			started?.controller.finish({stopped: true});
			started?.dispose();
		};
		// A new play state for the same song (a seat change) must not restart the audio; startAt identifies the run.
	}, [session, state.startAt, state.songId, songPackage]);

	useEffect(() => {
		if (!runtime) return;
		return autorun(() => runtime.audio.setVolume(BandSettings.volume));
	}, [runtime]);

	return {runtime, status};
}

// Keys go to the game only while the activity holds the keyboard; the root takes focus so they land here.
function useBandKeyboard(
	rootRef: RefObject<HTMLDivElement | null>,
	runtime: PlayRuntime | null,
	session: ActivitySession,
	keyMap: BandKeyMap,
): void {
	useEffect(() => {
		const root = rootRef.current;
		const track = runtime?.controller.myTrack;
		if (!root || !runtime || !track) return;
		const {controller} = runtime;
		const keyboard = new BandKeyboard(keyMap, track.part, {
			onLane: ({kind, lane, timeStamp}) => {
				const songMs = runtime.inputMs(timeStamp);
				if (kind === 'press') controller.press(lane, songMs);
				else controller.release(lane, songMs);
			},
			onStarPower: (timeStamp) => controller.deployStarPower(runtime.inputMs(timeStamp)),
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
		root.focus({preventScroll: true});
		return () => {
			root.removeEventListener('keydown', onKeyDown);
			root.removeEventListener('keyup', onKeyUp);
			root.removeEventListener('focusout', onFocusOut);
			keyboard.releaseAll(performance.now());
		};
	}, [rootRef, runtime, session, keyMap]);
}

// The play phase: every seated highway, my input and audio. Spectators get the same stage without input.
export const PlayScreen = observer(function PlayScreen(props: PlayScreenProps) {
	const {i18n} = useLingui();
	const rootRef = useRef<HTMLDivElement>(null);
	const {runtime, status} = usePlayRuntime(props);
	useBandKeyboard(rootRef, runtime, props.session, props.keyMap ?? DEFAULT_BAND_KEY_MAP);
	const vocals = runtime ? props.songPackage.chart().vocals : null;
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
				<PlayStage
					runtime={runtime}
					entry={props.entry}
					channelId={props.session.channelId}
					vocals={vocals}
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
		</div>
	);
});
