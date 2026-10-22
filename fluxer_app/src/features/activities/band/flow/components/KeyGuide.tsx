// SPDX-License-Identifier: AGPL-3.0-or-later

import {PART_DESCRIPTORS} from '@app/features/activities/band/BandPartNames';
import type {BandPart, InstrumentPart} from '@app/features/activities/band/engine/ChartModel';
import {
	KEY_GUIDE_CHORD_DESCRIPTOR,
	KEY_GUIDE_HOLD_TIP_DESCRIPTOR,
	KEY_GUIDE_KICK_TIP_DESCRIPTOR,
	KEY_GUIDE_STAR_POWER_TIP_DESCRIPTOR,
	KEY_GUIDE_TITLE_DESCRIPTOR,
	KEY_GUIDE_TRY_DESCRIPTOR,
	KEY_GUIDE_VOCALS_TIP_DESCRIPTOR,
	KEY_GUIDE_WHAMMY_TIP_DESCRIPTOR,
} from '@app/features/activities/band/flow/BandFlowMessages';
import {
	type BandGuideKey,
	type BandLaneColour,
	bandPartKeys,
	heldLaneCount,
} from '@app/features/activities/band/flow/BandKeyGuide';
import {isBandPanelKey} from '@app/features/activities/band/flow/components/BandPanelKeys';
import {BandPartIcon} from '@app/features/activities/band/flow/components/BandPartIcon';
import styles from '@app/features/activities/band/flow/components/KeyGuide.module.css';
import {actionForKey, type BandKeyMap, DEFAULT_BAND_KEY_MAP} from '@app/features/activities/band/game/BandInput';
import type {MessageDescriptor} from '@lingui/core';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import type React from 'react';
import {useEffect, useState} from 'react';

const LANE_CLASSES: Readonly<Record<BandLaneColour, string>> = {
	green: styles.laneGreen,
	red: styles.laneRed,
	yellow: styles.laneYellow,
	blue: styles.laneBlue,
	orange: styles.laneOrange,
};

const TIPS: Readonly<Record<InstrumentPart, ReadonlyArray<MessageDescriptor>>> = {
	guitar: [KEY_GUIDE_HOLD_TIP_DESCRIPTOR, KEY_GUIDE_WHAMMY_TIP_DESCRIPTOR, KEY_GUIDE_STAR_POWER_TIP_DESCRIPTOR],
	rhythm: [KEY_GUIDE_HOLD_TIP_DESCRIPTOR, KEY_GUIDE_WHAMMY_TIP_DESCRIPTOR, KEY_GUIDE_STAR_POWER_TIP_DESCRIPTOR],
	bass: [KEY_GUIDE_HOLD_TIP_DESCRIPTOR, KEY_GUIDE_WHAMMY_TIP_DESCRIPTOR, KEY_GUIDE_STAR_POWER_TIP_DESCRIPTOR],
	keys: [KEY_GUIDE_HOLD_TIP_DESCRIPTOR, KEY_GUIDE_STAR_POWER_TIP_DESCRIPTOR],
	drums: [KEY_GUIDE_KICK_TIP_DESCRIPTOR, KEY_GUIDE_STAR_POWER_TIP_DESCRIPTOR],
};

// Keeps Space and Enter working on a focused button or radio; elsewhere they would only scroll the screen.
function isControl(target: EventTarget | null): boolean {
	return (
		target instanceof Element && target.closest('button, a[href], select, [role="radio"], [role="button"]') !== null
	);
}

// The game keys held right now while the panel has the keyboard. Only lights the drawing: nothing is sent.
function useHeldKeys(
	scopeRef: React.RefObject<HTMLElement | null>,
	enabled: boolean,
	keyMap: BandKeyMap,
	part: InstrumentPart,
): ReadonlySet<string> {
	const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
	useEffect(() => {
		setHeld(new Set());
		if (!enabled) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isBandPanelKey(scopeRef.current, event)) return;
			if (actionForKey(keyMap, part, event.code).kind === 'none') return;
			if (!isControl(event.target)) event.preventDefault();
			if (event.repeat) return;
			setHeld((current) => (current.has(event.code) ? current : new Set(current).add(event.code)));
		};
		const onKeyUp = (event: KeyboardEvent) => {
			setHeld((current) => {
				if (!current.has(event.code)) return current;
				const next = new Set(current);
				next.delete(event.code);
				return next;
			});
		};
		const releaseAll = () => setHeld(new Set());
		document.addEventListener('keydown', onKeyDown, true);
		document.addEventListener('keyup', onKeyUp, true);
		window.addEventListener('blur', releaseAll);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
			document.removeEventListener('keyup', onKeyUp, true);
			window.removeEventListener('blur', releaseAll);
		};
	}, [scopeRef, enabled, keyMap, part]);
	return held;
}

interface KeyCapProps {
	readonly guideKey: BandGuideKey;
	readonly lit: boolean;
	readonly showLane: boolean;
	readonly className?: string;
}

function KeyCap({guideKey, lit, showLane, className}: KeyCapProps) {
	return (
		<span
			className={clsx(styles.key, guideKey.colour && LANE_CLASSES[guideKey.colour], lit && styles.lit, className)}
			data-flx="activities.band.flow.key-guide.key-cap.key"
		>
			{showLane && (
				<span className={styles.lane} aria-hidden="true" data-flx="activities.band.flow.key-guide.key-cap.lane" />
			)}
			<kbd
				className={clsx(styles.cap, !guideKey.colour && styles.capPlain)}
				data-flx="activities.band.flow.key-guide.key-cap.cap"
			>
				{guideKey.label}
			</kbd>
		</span>
	);
}

interface KeyGuideProps {
	// The screen the guide sits on; keys count while focus is anywhere in the activity panel around it.
	readonly scopeRef: React.RefObject<HTMLElement | null>;
	readonly part: BandPart;
	readonly keyboardCaptured: boolean;
	// After "I'm ready" the guide folds into one line of keys.
	readonly compact: boolean;
	readonly keyMap?: BandKeyMap;
}

function InstrumentKeyGuide({
	scopeRef,
	part,
	keyboardCaptured,
	compact,
	keyMap = DEFAULT_BAND_KEY_MAP,
}: KeyGuideProps & {readonly part: InstrumentPart}) {
	const {i18n} = useLingui();
	const held = useHeldKeys(scopeRef, keyboardCaptured, keyMap, part);
	const keys = bandPartKeys(keyMap, part);
	const heldActions = [...held].map((code) => actionForKey(keyMap, part, code));
	const isLit = (guideKey: BandGuideKey) => {
		const action = actionForKey(keyMap, part, guideKey.code);
		return heldActions.some((heldAction) =>
			heldAction.kind === 'lane' && action.kind === 'lane'
				? heldAction.lane === action.lane
				: heldAction.kind === action.kind,
		);
	};
	const chord = heldLaneCount(keyMap, part, held);
	const title = i18n._(KEY_GUIDE_TITLE_DESCRIPTOR);

	const pads = keys.lanes.map((guideKey) => (
		<KeyCap
			key={guideKey.code}
			guideKey={guideKey}
			lit={isLit(guideKey)}
			showLane={!compact}
			data-flx="activities.band.flow.key-guide.instrument-key-guide.key-cap"
		/>
	));
	const kick = keys.kick && (
		<KeyCap
			guideKey={keys.kick}
			lit={isLit(keys.kick)}
			showLane={!compact}
			className={styles.kickKey}
			data-flx="activities.band.flow.key-guide.instrument-key-guide.key-cap--2"
		/>
	);
	const starPower = keys.starPower && (
		<KeyCap
			guideKey={keys.starPower}
			lit={isLit(keys.starPower)}
			showLane={false}
			className={styles.starKey}
			data-flx="activities.band.flow.key-guide.instrument-key-guide.key-cap--3"
		/>
	);

	if (compact) {
		return (
			<div
				className={clsx(styles.guide, styles.compact)}
				role="group"
				aria-label={title}
				data-flx="activities.band.flow.key-guide.instrument-key-guide.compact"
			>
				{pads}
				{kick}
				{starPower}
			</div>
		);
	}

	return (
		<div
			className={styles.guide}
			role="group"
			aria-label={title}
			data-flx="activities.band.flow.key-guide.instrument-key-guide.guide"
		>
			<div className={styles.head} data-flx="activities.band.flow.key-guide.instrument-key-guide.head">
				<b data-flx="activities.band.flow.key-guide.instrument-key-guide.b">{title}</b>
				<span
					className={clsx(styles.status, chord >= 2 && styles.statusChord)}
					data-flx="activities.band.flow.key-guide.instrument-key-guide.status"
				>
					{chord >= 2 ? i18n._(KEY_GUIDE_CHORD_DESCRIPTOR, {count: chord}) : i18n._(KEY_GUIDE_TRY_DESCRIPTOR)}
				</span>
			</div>
			<div className={styles.board} data-flx="activities.band.flow.key-guide.instrument-key-guide.board">
				<div className={styles.pads} data-flx="activities.band.flow.key-guide.instrument-key-guide.pads">
					<div className={styles.row} data-flx="activities.band.flow.key-guide.instrument-key-guide.row">
						{pads}
					</div>
					{kick}
				</div>
				{starPower}
			</div>
			<ul className={styles.tips} data-flx="activities.band.flow.key-guide.instrument-key-guide.tips">
				{TIPS[part].map((tip) => (
					<li key={tip.id} data-flx="activities.band.flow.key-guide.instrument-key-guide.li">
						{i18n._(tip)}
					</li>
				))}
			</ul>
		</div>
	);
}

// Under the cards on the select screen: the keys for the part I hold, which I can press to try while I wait.
export function KeyGuide(props: KeyGuideProps) {
	const {i18n} = useLingui();
	const {part, compact} = props;
	if (part !== 'vocals')
		return <InstrumentKeyGuide {...props} part={part} data-flx="activities.band.flow.key-guide.instrument-key-guide" />;
	return (
		<div
			className={clsx(styles.guide, styles.mic, compact && styles.compact)}
			role="group"
			aria-label={i18n._(PART_DESCRIPTORS.vocals)}
			data-flx="activities.band.flow.key-guide.mic"
		>
			<BandPartIcon part="vocals" className={styles.micIcon} data-flx="activities.band.flow.key-guide.mic-icon" />
			<span data-flx="activities.band.flow.key-guide.span">{i18n._(KEY_GUIDE_VOCALS_TIP_DESCRIPTOR)}</span>
		</div>
	);
}
