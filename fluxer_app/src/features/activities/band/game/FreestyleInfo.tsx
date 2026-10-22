// SPDX-License-Identifier: AGPL-3.0-or-later

// The small box beside my highway during a freestyle solo: the key I am playing in, what the cues mean and what the
// keys do. There is no tutorial (Abdullah's call); this box is the whole explanation, and it folds to its title.

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import {FREESTYLE_SOLO_DESCRIPTOR} from '@app/features/activities/band/flow/BandFlowMessages';
import {keyCapLabel} from '@app/features/activities/band/flow/BandKeyGuide';
import {DEFAULT_BAND_KEY_MAP} from '@app/features/activities/band/game/BandInput';
import BandSettings from '@app/features/activities/band/game/BandSettings';
import styles from '@app/features/activities/band/game/FreestyleInfo.module.css';
import type {PlayRuntime} from '@app/features/activities/band/game/PlayRuntime';
import type {JamScale} from '@app/features/activities/band/jam/JamScales';
import {soloKeyFor} from '@app/features/activities/band/jam/SoloKey';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CaretDownIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

const KEY_DESCRIPTOR = msg({
	message: '{tonic} {scale}',
	context: 'band-freestyle-key',
	comment:
		'Band game freestyle solo info box: the key and scale my keys play, e.g. "A minor pentatonic". {tonic} is a note name like A, F# or Bb; {scale} is one of the scale names.',
});
const SCALE_DESCRIPTORS: Readonly<Record<JamScale, MessageDescriptor>> = {
	minorPentatonic: msg({
		message: 'minor pentatonic',
		context: 'band-freestyle-key',
		comment: 'Band game freestyle solo info box: scale name, shown after the key note, e.g. "A minor pentatonic".',
	}),
	majorPentatonic: msg({
		message: 'major pentatonic',
		context: 'band-freestyle-key',
		comment: 'Band game freestyle solo info box: scale name, shown after the key note, e.g. "C major pentatonic".',
	}),
	blues: msg({
		message: 'blues',
		context: 'band-freestyle-key',
		comment: 'Band game freestyle solo info box: the blues scale, shown after the key note, e.g. "E blues".',
	}),
	naturalMinor: msg({
		message: 'natural minor',
		context: 'band-freestyle-key',
		comment: 'Band game freestyle solo info box: scale name, shown after the key note, e.g. "D natural minor".',
	}),
};
const CUES_DESCRIPTOR = msg({
	message: 'Cues',
	context: 'band-freestyle-info',
	comment: 'Band game freestyle solo info box: heading over what the shapes on the lane mean.',
});
const KEYS_DESCRIPTOR = msg({
	message: 'Keys',
	context: 'band-freestyle-info',
	comment: 'Band game freestyle solo info box: heading over what each keyboard key does in the solo.',
});

type CueSwatch = 'high' | 'low' | 'sustain' | 'strum' | 'tap' | 'free';

const CUES: ReadonlyArray<{readonly swatch: CueSwatch; readonly descriptor: MessageDescriptor}> = [
	{
		swatch: 'high',
		descriptor: msg({
			message: 'Blue: high notes, the right-hand keys',
			context: 'band-freestyle-info',
			comment: 'Band game freestyle solo info box: a blue band on the lane means play high, on the right-hand keys.',
		}),
	},
	{
		swatch: 'low',
		descriptor: msg({
			message: 'Orange: low notes, the left-hand keys',
			context: 'band-freestyle-info',
			comment: 'Band game freestyle solo info box: an orange band on the lane means play low, on the left-hand keys.',
		}),
	},
	{
		swatch: 'sustain',
		descriptor: msg({
			message: 'Solid: one long note, held',
			context: 'band-freestyle-info',
			comment: 'Band game freestyle solo info box: a solid band means hold a single note.',
		}),
	},
	{
		swatch: 'strum',
		descriptor: msg({
			message: 'Striped: play fast',
			context: 'band-freestyle-info',
			comment: 'Band game freestyle solo info box: a striped band means play many notes quickly.',
		}),
	},
	{
		swatch: 'tap',
		descriptor: msg({
			message: 'Dotted: tap two keys in turn',
			context: 'band-freestyle-info',
			comment:
				'Band game freestyle solo info box: a dotted band means tapping, two keys pressed one after the other quickly.',
		}),
	},
	{
		swatch: 'free',
		descriptor: msg({
			message: 'Stars: play anything',
			context: 'band-freestyle-info',
			comment: 'Band game freestyle solo info box: a band of stars means free play, anything counts.',
		}),
	},
];

const LANES_KEYS_DESCRIPTOR = msg({
	message: '{keys}: the notes of the scale',
	context: 'band-freestyle-info',
	comment: 'Band game freestyle solo info box: the five lane keys, e.g. "A S D F G", each play one note of the scale.',
});
const BEND_KEY_DESCRIPTOR = msg({
	message: 'Space: bend, with Shift a step and a half',
	context: 'band-freestyle-info',
	comment:
		'Band game freestyle solo info box: holding Space bends the ringing note up a whole step; with Shift held too, a step and a half. Use the local name of the Space key.',
});
const PINCH_KEY_DESCRIPTOR = msg({
	message: 'Two neighbouring keys together: pinch harmonic',
	context: 'band-freestyle-info',
	comment:
		'Band game freestyle solo info box, guitar only: pressing two keys next to each other at once plays a pinch harmonic, the high squeal of rock solos. Keep "pinch harmonic" if there is no common local term.',
});
const HOLD_KEY_DESCRIPTOR = msg({
	message: 'Hold a key: the note rings on, then feeds back',
	context: 'band-freestyle-info',
	comment:
		'Band game freestyle solo info box: keeping a key down sustains the note, and on guitar it turns into amp feedback after a moment.',
});

const SWATCH_CLASSES: Readonly<Record<CueSwatch, string>> = {
	high: styles.swatchHigh,
	low: styles.swatchLow,
	sustain: styles.swatchSustain,
	strum: styles.swatchStrum,
	tap: styles.swatchTap,
	free: styles.swatchFree,
};

interface FreestyleInfoProps {
	readonly runtime: PlayRuntime;
	readonly entry: BandSongSummary;
	readonly className?: string;
}

export const FreestyleInfo = observer(function FreestyleInfo({runtime, entry, className}: FreestyleInfoProps) {
	const {i18n} = useLingui();
	const {controller} = runtime;
	const track = controller.myTrack;
	if (!track?.hud.freestyleOn) return null;
	const section = controller.mySoloSectionAt(runtime.heardMs());
	const choice = soloKeyFor(entry.key, section?.startMs ?? 0, section?.endMs ?? 0);
	const open = BandSettings.freestyleInfoOpen;
	const title = i18n._(FREESTYLE_SOLO_DESCRIPTOR);
	const laneKeys = DEFAULT_BAND_KEY_MAP.frets.map(keyCapLabel).join(' ');
	const guitar = track.part !== 'keys';
	return (
		<aside
			className={clsx(styles.box, className)}
			aria-label={title}
			data-flx="activities.band.game.freestyle-info.box"
		>
			<button
				type="button"
				aria-expanded={open}
				className={styles.head}
				// The game keeps the keyboard: a click must not leave the focus on a button that Space would press.
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => BandSettings.setFreestyleInfoOpen(!open)}
				data-flx="activities.band.game.freestyle-info.head.set-freestyle-info-open.button"
			>
				<span className={styles.title} data-flx="activities.band.game.freestyle-info.title">
					<b data-flx="activities.band.game.freestyle-info.title-text">{title}</b>
					<span className={styles.key} data-flx="activities.band.game.freestyle-info.key">
						{i18n._(KEY_DESCRIPTOR, {tonic: choice.tonic, scale: i18n._(SCALE_DESCRIPTORS[choice.scale])})}
					</span>
				</span>
				<CaretDownIcon
					weight="bold"
					aria-hidden="true"
					className={clsx(styles.caret, open && styles.caretOpen)}
					data-flx="activities.band.game.freestyle-info.caret"
				/>
			</button>
			{open && (
				<div className={styles.body} data-flx="activities.band.game.freestyle-info.body">
					<h3 className={styles.heading} data-flx="activities.band.game.freestyle-info.cues-heading">
						{i18n._(CUES_DESCRIPTOR)}
					</h3>
					<ul className={styles.list} data-flx="activities.band.game.freestyle-info.cues">
						{CUES.map(({swatch, descriptor}) => (
							<li key={swatch} className={styles.item} data-flx="activities.band.game.freestyle-info.cue">
								<span
									className={clsx(styles.swatch, SWATCH_CLASSES[swatch])}
									aria-hidden="true"
									data-flx="activities.band.game.freestyle-info.swatch"
								/>
								{i18n._(descriptor)}
							</li>
						))}
					</ul>
					<h3 className={styles.heading} data-flx="activities.band.game.freestyle-info.keys-heading">
						{i18n._(KEYS_DESCRIPTOR)}
					</h3>
					<ul className={styles.list} data-flx="activities.band.game.freestyle-info.keys">
						<li className={styles.item} data-flx="activities.band.game.freestyle-info.lanes-key">
							{i18n._(LANES_KEYS_DESCRIPTOR, {keys: laneKeys})}
						</li>
						<li className={styles.item} data-flx="activities.band.game.freestyle-info.bend-key">
							{i18n._(BEND_KEY_DESCRIPTOR)}
						</li>
						{guitar && (
							<li className={styles.item} data-flx="activities.band.game.freestyle-info.pinch-key">
								{i18n._(PINCH_KEY_DESCRIPTOR)}
							</li>
						)}
						{guitar && (
							<li className={styles.item} data-flx="activities.band.game.freestyle-info.hold-key">
								{i18n._(HOLD_KEY_DESCRIPTOR)}
							</li>
						)}
					</ul>
				</div>
			)}
		</aside>
	);
});
