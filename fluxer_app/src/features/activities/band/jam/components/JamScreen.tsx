// SPDX-License-Identifier: AGPL-3.0-or-later

import {RETRY_DESCRIPTOR} from '@app/features/activities/band/flow/BandFlowMessages';
import type {BandJamState} from '@app/features/activities/band/flow/BandJamMachine';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {type BandKeyMap, DEFAULT_BAND_KEY_MAP} from '@app/features/activities/band/game/BandInput';
import {JamBand} from '@app/features/activities/band/jam/components/JamBand';
import {JamInfoBox} from '@app/features/activities/band/jam/components/JamInfoBox';
import {JamInstrumentBar, JamInstrumentPrompt} from '@app/features/activities/band/jam/components/JamInstrumentBar';
import {JamPads} from '@app/features/activities/band/jam/components/JamPads';
import styles from '@app/features/activities/band/jam/components/JamScreen.module.css';
import {JamTopBar} from '@app/features/activities/band/jam/components/JamTopBar';
import {JamKeyboard} from '@app/features/activities/band/jam/JamKeyboard';
import {
	LOAD_FAILED_DESCRIPTOR,
	LOADING_DESCRIPTOR,
	MODE_JAM_DESCRIPTOR,
	NO_AUDIO_DESCRIPTOR,
} from '@app/features/activities/band/jam/JamLabels';
import {JamRuntime} from '@app/features/activities/band/jam/JamRuntime';
import JamSettings from '@app/features/activities/band/jam/JamSettings';
import ActivityViewDock from '@app/features/activities/components/ActivityViewDock';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {Spinner} from '@app/features/ui/components/Spinner';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type RefObject, useCallback, useEffect, useRef, useState} from 'react';

// One runtime per visit to jam mode; Retry after a failed load starts a fresh one.
function useJamRuntime(room: BandRoom): {readonly runtime: JamRuntime | null; readonly retry: () => void} {
	const [attempt, setAttempt] = useState(0);
	const [runtime, setRuntime] = useState<JamRuntime | null>(null);
	useEffect(() => {
		const next = new JamRuntime(room);
		setRuntime(next);
		next.start();
		return () => next.dispose();
	}, [room, attempt]);
	const retry = useCallback(() => setAttempt((count) => count + 1), []);
	return {runtime, retry};
}

function isFormField(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement
	);
}

// Keys reach the jam only while the activity holds the keyboard (ActivityViewFrame); a new instrument or rhythm tone
// lets go of whatever was held first, so nothing hangs on the old sound.
function useJamKeyboard(
	rootRef: RefObject<HTMLDivElement | null>,
	runtime: JamRuntime | null,
	session: ActivitySession,
	keyMap: BandKeyMap,
	sound: string,
): void {
	useEffect(() => {
		const root = rootRef.current;
		if (!root || !runtime) return;
		const keyboard = new JamKeyboard(keyMap, runtime);
		const onKeyDown = (event: KeyboardEvent) => {
			if (!session.keyboardCaptured || isFormField(event.target)) return;
			if (keyboard.keyDown(event)) event.preventDefault();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (keyboard.keyUp(event)) event.preventDefault();
		};
		// A click on a button hands the keys straight back to the lanes; pickers keep focus until they close.
		const onClick = (event: MouseEvent) => {
			if (event.target instanceof Element && event.target.closest('button')) root.focus({preventScroll: true});
		};
		const onFocusOut = (event: FocusEvent) => {
			if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) {
				keyboard.releaseAll(event.timeStamp);
			}
		};
		root.addEventListener('keydown', onKeyDown);
		root.addEventListener('keyup', onKeyUp);
		root.addEventListener('focusout', onFocusOut);
		root.addEventListener('click', onClick);
		if (!root.contains(document.activeElement) && ActivityViewDock.mayTakeFocus(root))
			root.focus({preventScroll: true});
		return () => {
			root.removeEventListener('keydown', onKeyDown);
			root.removeEventListener('keyup', onKeyUp);
			root.removeEventListener('focusout', onFocusOut);
			root.removeEventListener('click', onClick);
			keyboard.releaseAll(performance.now());
		};
	}, [rootRef, runtime, session, keyMap, sound]);
}

const JamStageContent = observer(function JamStageContent({
	room,
	runtime,
	keyMap,
	retry,
}: {
	readonly room: BandRoom;
	readonly runtime: JamRuntime | null;
	readonly keyMap: BandKeyMap;
	readonly retry: () => void;
}) {
	const {i18n} = useLingui();
	const instrument = room.myJamSeat?.instrument ?? null;
	if (!runtime || runtime.status === 'loading') {
		const percent =
			runtime && runtime.totalFiles > 0 ? Math.floor((runtime.loadedFiles / runtime.totalFiles) * 100) : 0;
		return (
			<div className={styles.notice} role="status" data-flx="activities.band.jam.jam-screen.jam-stage-content.notice">
				<Spinner data-flx="activities.band.jam.jam-screen.jam-stage-content.spinner" />
				<p className={styles.noticeText} data-flx="activities.band.jam.jam-screen.jam-stage-content.notice-text">
					{i18n._(LOADING_DESCRIPTOR, {percent})}
				</p>
			</div>
		);
	}
	if (runtime.status !== 'ready') {
		return (
			<div className={styles.notice} role="alert" data-flx="activities.band.jam.jam-screen.jam-stage-content.notice--2">
				<p className={styles.noticeText} data-flx="activities.band.jam.jam-screen.jam-stage-content.notice-text--2">
					{i18n._(runtime.status === 'noAudio' ? NO_AUDIO_DESCRIPTOR : LOAD_FAILED_DESCRIPTOR)}
				</p>
				{runtime.status === 'failed' && (
					<button
						type="button"
						className={styles.retry}
						onClick={retry}
						data-flx="activities.band.jam.jam-screen.jam-stage-content.retry.button"
					>
						{i18n._(RETRY_DESCRIPTOR)}
					</button>
				)}
			</div>
		);
	}
	if (!instrument)
		return (
			<JamInstrumentPrompt
				room={room}
				data-flx="activities.band.jam.jam-screen.jam-stage-content.jam-instrument-prompt"
			/>
		);
	return (
		<JamPads
			runtime={runtime}
			instrument={instrument}
			keyMap={keyMap}
			data-flx="activities.band.jam.jam-screen.jam-stage-content.jam-pads"
		/>
	);
});

interface JamScreenProps {
	readonly room: BandRoom;
	readonly state: BandJamState;
	readonly keyMap?: BandKeyMap;
}

// Jam mode: my five lanes in the middle, the bandmates above them lighting up as they play, the room's key and backing
// in the top bar (the leader sets them), my instrument under it and the key box on the right.
export const JamScreen = observer(function JamScreen({room, state, keyMap = DEFAULT_BAND_KEY_MAP}: JamScreenProps) {
	const {i18n} = useLingui();
	const rootRef = useRef<HTMLDivElement>(null);
	const {runtime, retry} = useJamRuntime(room);
	const instrument = room.myJamSeat?.instrument ?? null;
	useJamKeyboard(rootRef, runtime, room.session, keyMap, `${instrument}:${JamSettings.rhythmTone}`);
	return (
		<div
			ref={rootRef}
			className={styles.screen}
			role="application"
			aria-label={i18n._(MODE_JAM_DESCRIPTOR)}
			tabIndex={-1}
			data-flx="activities.band.jam.jam-screen.screen.take-keys-back"
		>
			<JamTopBar
				room={room}
				state={state}
				onPicked={() => rootRef.current?.focus({preventScroll: true})}
				data-flx="activities.band.jam.jam-screen.jam-top-bar"
			/>
			<JamInstrumentBar
				room={room}
				instrument={instrument}
				data-flx="activities.band.jam.jam-screen.jam-instrument-bar"
			/>
			<div
				className={clsx(styles.body, JamSettings.infoCollapsed && styles.infoCollapsed)}
				data-flx="activities.band.jam.jam-screen.body"
			>
				<main className={styles.main} data-flx="activities.band.jam.jam-screen.main">
					<JamBand room={room} state={state} runtime={runtime} data-flx="activities.band.jam.jam-screen.jam-band" />
					<div className={styles.stage} data-flx="activities.band.jam.jam-screen.stage">
						<JamStageContent
							room={room}
							runtime={runtime}
							keyMap={keyMap}
							retry={retry}
							data-flx="activities.band.jam.jam-screen.jam-stage-content"
						/>
					</div>
				</main>
				<JamInfoBox
					state={state}
					instrument={instrument}
					keyMap={keyMap}
					data-flx="activities.band.jam.jam-screen.jam-info-box"
				/>
			</div>
		</div>
	);
});
