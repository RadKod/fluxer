// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAND_JAM_BPM_MAX,
	BAND_JAM_BPM_MIN,
	type BandJamSettingsPatch,
} from '@app/features/activities/band/BandProtocol';
import type {BandJamState} from '@app/features/activities/band/flow/BandJamMachine';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {BandModeSwitch} from '@app/features/activities/band/flow/components/BandModeSwitch';
import {bandDisplayName} from '@app/features/activities/band/flow/components/BandPeople';
import BandSettings from '@app/features/activities/band/game/BandSettings';
import styles from '@app/features/activities/band/jam/components/JamControls.module.css';
import {JAM_KEY_NAMES} from '@app/features/activities/band/jam/components/JamNoteNames';
import {JAM_BACKING_STYLES} from '@app/features/activities/band/jam/JamBacking';
import {
	BACKING_LABEL_DESCRIPTOR,
	BACKING_ON_DESCRIPTOR,
	BACKING_PARTS_DESCRIPTORS,
	BACKING_STYLE_DESCRIPTORS,
	BPM_DESCRIPTOR,
	KEY_LABEL_DESCRIPTOR,
	KEY_SCALE_DESCRIPTOR,
	LEADER_SETS_DESCRIPTOR,
	SCALE_DESCRIPTORS,
	SCALE_LABEL_DESCRIPTOR,
	TEMPO_DOWN_DESCRIPTOR,
	TEMPO_LABEL_DESCRIPTOR,
	TEMPO_UP_DESCRIPTOR,
	VOLUME_DESCRIPTOR,
} from '@app/features/activities/band/jam/JamLabels';
import {JAM_SCALES, type JamScale} from '@app/features/activities/band/jam/JamScales';
import {useLingui} from '@lingui/react/macro';
import {CaretDownIcon, MinusIcon, PlusIcon, RepeatIcon, SpeakerHighIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const TEMPO_STEP = 5;
const SCALES = Object.keys(JAM_SCALES) as ReadonlyArray<JamScale>;

function backingPartsKey(state: BandJamState): keyof typeof BACKING_PARTS_DESCRIPTORS {
	const played = new Set(state.seats.map((seat) => seat.instrument));
	const drums = !played.has('drums');
	const bass = !played.has('bass');
	if (drums && bass) return 'drumsAndBass';
	if (drums) return 'drums';
	return bass ? 'bass' : 'none';
}

function Field({label, children}: {readonly label: string; readonly children: React.ReactNode}) {
	return (
		<div className={styles.field} data-flx="activities.band.jam.jam-top-bar.field.field">
			<span className={styles.fieldLabel} data-flx="activities.band.jam.jam-top-bar.field.field-label">
				{label}
			</span>
			<div className={styles.fieldBody} data-flx="activities.band.jam.jam-top-bar.field.field-body">
				{children}
			</div>
		</div>
	);
}

function Picker<T extends string | number>({
	label,
	value,
	options,
	format,
	disabled,
	onPick,
	wide = false,
}: {
	readonly label: string;
	readonly value: T;
	readonly options: ReadonlyArray<T>;
	readonly format: (value: T) => string;
	readonly disabled: boolean;
	readonly onPick: (value: T) => void;
	readonly wide?: boolean;
}) {
	return (
		<span
			className={clsx(styles.picker, wide && styles.pickerWide)}
			data-flx="activities.band.jam.jam-top-bar.picker.picker"
		>
			<select
				aria-label={label}
				value={String(value)}
				disabled={disabled}
				onChange={(event) => {
					const picked = options.find((option) => String(option) === event.target.value);
					if (picked !== undefined) onPick(picked);
				}}
				data-flx="activities.band.jam.jam-top-bar.picker.select"
			>
				{options.map((option) => (
					<option key={String(option)} value={String(option)} data-flx="activities.band.jam.jam-top-bar.picker.option">
						{format(option)}
					</option>
				))}
			</select>
			<CaretDownIcon
				size={12}
				weight="bold"
				className={styles.pickerCaret}
				aria-hidden="true"
				data-flx="activities.band.jam.jam-top-bar.picker.picker-caret"
			/>
		</span>
	);
}

// The room's key, scale and backing loop (the leader's to change, everyone sees them) and my volume.
export const JamTopBar = observer(function JamTopBar({
	room,
	state,
	onPicked,
}: {
	readonly room: BandRoom;
	readonly state: BandJamState;
	// A picker closed: the keys go back to the lanes.
	readonly onPicked: () => void;
}) {
	const {i18n} = useLingui();
	const isLeader = room.session.isLeader;
	const leader = room.session.leader;
	const readOnlyHint =
		!isLeader && leader ? i18n._(LEADER_SETS_DESCRIPTOR, {name: bandDisplayName(leader.userId)}) : undefined;
	const change = (patch: BandJamSettingsPatch) => {
		room.send({t: 'band.jamSettings', ...patch});
	};
	const pick = (patch: BandJamSettingsPatch) => {
		change(patch);
		onPicked();
	};
	const {backing} = state;
	const keyScale = i18n._(KEY_SCALE_DESCRIPTOR, {
		key: JAM_KEY_NAMES[state.key],
		scale: i18n._(SCALE_DESCRIPTORS[state.scale]),
	});
	return (
		<header className={styles.header} data-flx="activities.band.jam.jam-top-bar.header">
			<BandModeSwitch room={room} mode="jam" data-flx="activities.band.jam.jam-top-bar.band-mode-switch" />
			<div className={styles.settings} title={readOnlyHint} data-flx="activities.band.jam.jam-top-bar.settings">
				<Field label={i18n._(KEY_LABEL_DESCRIPTOR)} data-flx="activities.band.jam.jam-top-bar.field">
					<Picker
						label={i18n._(KEY_LABEL_DESCRIPTOR)}
						value={state.key}
						options={JAM_KEY_NAMES.map((_, key) => key)}
						format={(key) => JAM_KEY_NAMES[key]}
						disabled={!isLeader}
						onPick={(key) => pick({key})}
						data-flx="activities.band.jam.jam-top-bar.picker"
					/>
				</Field>
				<Field label={i18n._(SCALE_LABEL_DESCRIPTOR)} data-flx="activities.band.jam.jam-top-bar.field--2">
					<Picker
						label={i18n._(SCALE_LABEL_DESCRIPTOR)}
						value={state.scale}
						options={SCALES}
						format={(scale) => i18n._(SCALE_DESCRIPTORS[scale])}
						disabled={!isLeader}
						onPick={(scale) => pick({scale})}
						wide
						data-flx="activities.band.jam.jam-top-bar.picker--2"
					/>
				</Field>
				<Field label={i18n._(TEMPO_LABEL_DESCRIPTOR)} data-flx="activities.band.jam.jam-top-bar.field--3">
					<div className={styles.stepper} data-flx="activities.band.jam.jam-top-bar.stepper">
						<button
							type="button"
							className={styles.stepButton}
							aria-label={i18n._(TEMPO_DOWN_DESCRIPTOR)}
							title={isLeader ? i18n._(TEMPO_DOWN_DESCRIPTOR) : undefined}
							disabled={!isLeader || backing.bpm <= BAND_JAM_BPM_MIN}
							onClick={() => change({bpm: backing.bpm - TEMPO_STEP})}
							data-flx="activities.band.jam.jam-top-bar.step-button.change"
						>
							<MinusIcon
								size={12}
								weight="bold"
								aria-hidden="true"
								data-flx="activities.band.jam.jam-top-bar.minus-icon"
							/>
						</button>
						<span className={styles.bpm} data-flx="activities.band.jam.jam-top-bar.bpm">
							{i18n._(BPM_DESCRIPTOR, {bpm: backing.bpm})}
						</span>
						<button
							type="button"
							className={styles.stepButton}
							aria-label={i18n._(TEMPO_UP_DESCRIPTOR)}
							title={isLeader ? i18n._(TEMPO_UP_DESCRIPTOR) : undefined}
							disabled={!isLeader || backing.bpm >= BAND_JAM_BPM_MAX}
							onClick={() => change({bpm: backing.bpm + TEMPO_STEP})}
							data-flx="activities.band.jam.jam-top-bar.step-button.change--2"
						>
							<PlusIcon
								size={12}
								weight="bold"
								aria-hidden="true"
								data-flx="activities.band.jam.jam-top-bar.plus-icon"
							/>
						</button>
					</div>
				</Field>
				<Field label={i18n._(BACKING_LABEL_DESCRIPTOR)} data-flx="activities.band.jam.jam-top-bar.field--4">
					<div
						className={styles.segmented}
						role="radiogroup"
						aria-label={i18n._(BACKING_LABEL_DESCRIPTOR)}
						data-flx="activities.band.jam.jam-top-bar.segmented"
					>
						{JAM_BACKING_STYLES.map((style) => (
							<button
								key={style}
								type="button"
								role="radio"
								aria-checked={style === backing.style}
								disabled={!isLeader}
								className={clsx(styles.segment, style === backing.style && styles.segmentOn)}
								onClick={() => change({style})}
								data-flx="activities.band.jam.jam-top-bar.segment.change.button"
							>
								{i18n._(BACKING_STYLE_DESCRIPTORS[style])}
							</button>
						))}
					</div>
					<button
						type="button"
						className={clsx(styles.loop, backing.on && styles.loopOn)}
						aria-pressed={backing.on}
						disabled={!isLeader}
						title={i18n._(BACKING_PARTS_DESCRIPTORS[backingPartsKey(state)])}
						onClick={() => change({backing: !backing.on})}
						data-flx="activities.band.jam.jam-top-bar.loop.change.button"
					>
						<RepeatIcon
							size={14}
							weight="bold"
							aria-hidden="true"
							data-flx="activities.band.jam.jam-top-bar.repeat-icon"
						/>
						{i18n._(BACKING_ON_DESCRIPTOR)}
					</button>
				</Field>
			</div>
			<p className={styles.summary} data-flx="activities.band.jam.jam-top-bar.summary">
				<b data-flx="activities.band.jam.jam-top-bar.b">{keyScale}</b>
				<span data-flx="activities.band.jam.jam-top-bar.span">{i18n._(BPM_DESCRIPTOR, {bpm: backing.bpm})}</span>
			</p>
			<label className={styles.volume} data-flx="activities.band.jam.jam-top-bar.volume">
				<SpeakerHighIcon
					size={16}
					weight="bold"
					aria-hidden="true"
					data-flx="activities.band.jam.jam-top-bar.speaker-high-icon"
				/>
				<span className={styles.volumeLabel} data-flx="activities.band.jam.jam-top-bar.volume-label">
					{i18n._(VOLUME_DESCRIPTOR)}
				</span>
				<input
					type="range"
					min={0}
					max={1}
					step={0.01}
					value={BandSettings.volume}
					onChange={(event) => BandSettings.setVolume(Number(event.currentTarget.value))}
					data-flx="activities.band.jam.jam-top-bar.input.set-volume.range"
				/>
			</label>
		</header>
	);
});
