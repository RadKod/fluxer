// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandJamInstrument} from '@app/features/activities/band/BandProtocol';
import {keyCapLabel} from '@app/features/activities/band/flow/BandKeyGuide';
import type {BandKeyMap} from '@app/features/activities/band/game/BandInput';
import {jamNoteName} from '@app/features/activities/band/jam/components/JamNoteNames';
import styles from '@app/features/activities/band/jam/components/JamPads.module.css';
import {
	BEND_DESCRIPTOR,
	DRUM_LANE_DESCRIPTORS,
	FEEDBACK_DESCRIPTOR,
	OCTAVE_DESCRIPTOR,
	PINCH_DESCRIPTOR,
} from '@app/features/activities/band/jam/JamLabels';
import type {JamRuntime} from '@app/features/activities/band/jam/JamRuntime';
import {JAM_LANE_COUNT} from '@app/features/activities/band/jam/JamScales';
import JamSettings from '@app/features/activities/band/jam/JamSettings';
import {FEEDBACK} from '@app/features/activities/band/jam/JamTechniques';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

export const JAM_LANE_CLASSES: ReadonlyArray<string> = [
	styles.laneGreen,
	styles.laneRed,
	styles.laneYellow,
	styles.laneBlue,
	styles.laneOrange,
];

// Bend amounts in whole steps, as guitarists say them.
const BEND_STEPS: Readonly<Record<number, string>> = {1: '+½', 2: '+1', 3: '+1½'};

function signed(octave: number): string {
	return octave > 0 ? `+${octave}` : String(octave);
}

interface LaneFace {
	readonly main: string;
	readonly sub: string | null;
	readonly alternate: string | null;
}

// My five lanes on the strike line, the same rings the highway ends in: they fill when pressed, a held note draws its
// sustain up the lane, and the lead guitar's tail turns to feedback once the amp starts to howl.
export const JamPads = observer(function JamPads({
	runtime,
	instrument,
	keyMap,
}: {
	readonly runtime: JamRuntime;
	readonly instrument: BandJamInstrument;
	readonly keyMap: BandKeyMap;
}) {
	const {i18n} = useLingui();
	const drums = instrument === 'drums';
	const powerChords = instrument === 'rhythm' && JamSettings.rhythmTone === 'power';
	const notes = runtime.laneNotes;
	const faces: ReadonlyArray<LaneFace> = Array.from({length: JAM_LANE_COUNT}, (_, lane) => {
		if (drums) {
			const {piece, alternate} = DRUM_LANE_DESCRIPTORS[lane];
			return {main: i18n._(piece), sub: null, alternate: alternate ? i18n._(alternate) : null};
		}
		const note = notes?.[lane];
		if (note === undefined) return {main: '', sub: null, alternate: null};
		const {letter, octave} = jamNoteName(note);
		// A power chord goes by its chord name, E5, rather than a note and octave.
		return powerChords
			? {main: `${letter}5`, sub: null, alternate: null}
			: {main: letter, sub: String(octave), alternate: null};
	});
	const bending = runtime.bend > 0 && runtime.lanes.some((light) => light.down);
	const style = {
		'--jam-bend': bending ? runtime.bend : 0,
		'--jam-feedback-after': `${FEEDBACK.bloomAfterS}s`,
	} as React.CSSProperties;
	return (
		<div
			className={clsx(styles.pads, drums && styles.drums, instrument === 'guitar' && styles.lead)}
			style={style}
			data-flx="activities.band.jam.jam-pads.pads"
		>
			<div className={styles.tags} data-flx="activities.band.jam.jam-pads.tags">
				{!drums && runtime.octaveChoices.length > 1 && (
					<span className={styles.tag} data-flx="activities.band.jam.jam-pads.tag">
						{i18n._(OCTAVE_DESCRIPTOR, {octave: signed(runtime.effectiveOctave)})}
					</span>
				)}
				{bending && (
					<span className={clsx(styles.tag, styles.tagHot)} data-flx="activities.band.jam.jam-pads.tag--2">
						{i18n._(BEND_DESCRIPTOR)} {BEND_STEPS[runtime.bend]}
					</span>
				)}
			</div>
			<div className={styles.lanes} data-flx="activities.band.jam.jam-pads.lanes">
				{faces.map((face, lane) => {
					const light = runtime.lanes[lane];
					const code = keyMap.frets[lane];
					return (
						<div
							key={code ?? lane}
							className={clsx(
								styles.lane,
								JAM_LANE_CLASSES[lane],
								light?.down && styles.down,
								light?.pinch && styles.pinch,
							)}
							data-flx="activities.band.jam.jam-pads.lane"
						>
							{!drums && (
								<span className={styles.tail} aria-hidden="true" data-flx="activities.band.jam.jam-pads.tail" />
							)}
							{light?.pinch && (
								<span className={styles.flag} data-flx="activities.band.jam.jam-pads.flag">
									{i18n._(PINCH_DESCRIPTOR)}
								</span>
							)}
							{instrument === 'guitar' && !light?.pinch && (
								<span
									className={clsx(styles.flag, styles.feedbackFlag)}
									data-flx="activities.band.jam.jam-pads.flag--2"
								>
									{i18n._(FEEDBACK_DESCRIPTOR)}
								</span>
							)}
							<span className={styles.ring} data-flx="activities.band.jam.jam-pads.ring">
								<span className={clsx(styles.note, drums && styles.piece)} data-flx="activities.band.jam.jam-pads.note">
									{face.main}
									{face.sub && (
										<sub className={styles.octave} data-flx="activities.band.jam.jam-pads.octave">
											{face.sub}
										</sub>
									)}
								</span>
							</span>
							{code && (
								<kbd className={styles.cap} data-flx="activities.band.jam.jam-pads.cap">
									{keyCapLabel(code)}
								</kbd>
							)}
							<span className={styles.alternate} data-flx="activities.band.jam.jam-pads.alternate">
								{face.alternate ? `⇧ ${face.alternate}` : ''}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
});
