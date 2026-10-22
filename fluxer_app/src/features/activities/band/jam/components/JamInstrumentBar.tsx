// SPDX-License-Identifier: AGPL-3.0-or-later

import {BAND_JAM_INSTRUMENTS, type BandJamInstrument} from '@app/features/activities/band/BandProtocol';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {BandPartIcon} from '@app/features/activities/band/flow/components/BandPartIcon';
import styles from '@app/features/activities/band/jam/components/JamControls.module.css';
import {
	INSTRUMENT_LABEL_DESCRIPTOR,
	JAM_INSTRUMENT_DESCRIPTORS,
	LISTEN_DESCRIPTOR,
	PICK_PROMPT_BODY_DESCRIPTOR,
	PICK_PROMPT_TITLE_DESCRIPTOR,
	RHYTHM_TONE_DESCRIPTORS,
} from '@app/features/activities/band/jam/JamLabels';
import JamSettings, {type JamRhythmTone} from '@app/features/activities/band/jam/JamSettings';
import {useLingui} from '@lingui/react/macro';
import {HeadphonesIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

const RHYTHM_TONES: ReadonlyArray<JamRhythmTone> = ['power', 'clean'];

function pickInstrument(room: BandRoom, instrument: BandJamInstrument | null): void {
	room.send({t: 'band.jamInstrument', instrument});
}

// My instrument, under the room settings. Anyone can play anything; two guitarists are fine.
export const JamInstrumentBar = observer(function JamInstrumentBar({
	room,
	instrument,
}: {
	readonly room: BandRoom;
	readonly instrument: BandJamInstrument | null;
}) {
	const {i18n} = useLingui();
	return (
		<div className={styles.bar} data-flx="activities.band.jam.jam-instrument-bar.bar">
			<span className={styles.barLabel} data-flx="activities.band.jam.jam-instrument-bar.bar-label">
				{i18n._(INSTRUMENT_LABEL_DESCRIPTOR)}
			</span>
			<div
				className={styles.instruments}
				role="radiogroup"
				aria-label={i18n._(INSTRUMENT_LABEL_DESCRIPTOR)}
				data-flx="activities.band.jam.jam-instrument-bar.instruments"
			>
				{BAND_JAM_INSTRUMENTS.map((option) => {
					const name = i18n._(JAM_INSTRUMENT_DESCRIPTORS[option]);
					return (
						<button
							key={option}
							type="button"
							role="radio"
							aria-checked={option === instrument}
							aria-label={name}
							title={name}
							className={clsx(styles.instrument, option === instrument && styles.instrumentOn)}
							onClick={() => pickInstrument(room, option)}
							data-flx="activities.band.jam.jam-instrument-bar.instrument.button"
						>
							<BandPartIcon
								part={option}
								className={styles.instrumentIcon}
								data-flx="activities.band.jam.jam-instrument-bar.instrument-icon"
							/>
							<span className={styles.instrumentName} data-flx="activities.band.jam.jam-instrument-bar.instrument-name">
								{name}
							</span>
						</button>
					);
				})}
				<button
					type="button"
					role="radio"
					aria-checked={instrument === null}
					aria-label={i18n._(LISTEN_DESCRIPTOR)}
					title={i18n._(LISTEN_DESCRIPTOR)}
					className={clsx(styles.instrument, styles.listen, instrument === null && styles.instrumentOn)}
					onClick={() => pickInstrument(room, null)}
					data-flx="activities.band.jam.jam-instrument-bar.instrument.button--2"
				>
					<HeadphonesIcon
						size={16}
						weight="bold"
						className={styles.instrumentIcon}
						aria-hidden="true"
						data-flx="activities.band.jam.jam-instrument-bar.instrument-icon--2"
					/>
					<span className={styles.instrumentName} data-flx="activities.band.jam.jam-instrument-bar.instrument-name--2">
						{i18n._(LISTEN_DESCRIPTOR)}
					</span>
				</button>
			</div>
			{instrument === 'rhythm' && (
				<div
					className={clsx(styles.segmented, styles.tone)}
					role="radiogroup"
					aria-label={i18n._(JAM_INSTRUMENT_DESCRIPTORS.rhythm)}
					data-flx="activities.band.jam.jam-instrument-bar.segmented"
				>
					{RHYTHM_TONES.map((tone) => (
						<button
							key={tone}
							type="button"
							role="radio"
							aria-checked={JamSettings.rhythmTone === tone}
							className={clsx(styles.segment, JamSettings.rhythmTone === tone && styles.segmentOn)}
							onClick={() => JamSettings.setRhythmTone(tone)}
							data-flx="activities.band.jam.jam-instrument-bar.segment.set-rhythm-tone.button"
						>
							{i18n._(RHYTHM_TONE_DESCRIPTORS[tone])}
						</button>
					))}
				</div>
			)}
		</div>
	);
});

// In the middle of the stage while I have no instrument: the same choice, large.
export const JamInstrumentPrompt = observer(function JamInstrumentPrompt({room}: {readonly room: BandRoom}) {
	const {i18n} = useLingui();
	return (
		<div className={styles.prompt} data-flx="activities.band.jam.jam-instrument-bar.jam-instrument-prompt.prompt">
			<h3
				className={styles.promptTitle}
				data-flx="activities.band.jam.jam-instrument-bar.jam-instrument-prompt.prompt-title"
			>
				{i18n._(PICK_PROMPT_TITLE_DESCRIPTOR)}
			</h3>
			<p
				className={styles.promptBody}
				data-flx="activities.band.jam.jam-instrument-bar.jam-instrument-prompt.prompt-body"
			>
				{i18n._(PICK_PROMPT_BODY_DESCRIPTOR)}
			</p>
			<div
				className={styles.promptChoices}
				data-flx="activities.band.jam.jam-instrument-bar.jam-instrument-prompt.prompt-choices"
			>
				{BAND_JAM_INSTRUMENTS.map((option) => (
					<button
						key={option}
						type="button"
						className={styles.promptChoice}
						onClick={() => pickInstrument(room, option)}
						data-flx="activities.band.jam.jam-instrument-bar.jam-instrument-prompt.prompt-choice.pick-instrument.button"
					>
						<BandPartIcon
							part={option}
							className={styles.promptIcon}
							data-flx="activities.band.jam.jam-instrument-bar.jam-instrument-prompt.prompt-icon"
						/>
						{i18n._(JAM_INSTRUMENT_DESCRIPTORS[option])}
					</button>
				))}
			</div>
		</div>
	);
});
