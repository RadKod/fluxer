// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandJamInstrument} from '@app/features/activities/band/BandProtocol';
import type {BandJamState} from '@app/features/activities/band/flow/BandJamMachine';
import {keyCapLabel} from '@app/features/activities/band/flow/BandKeyGuide';
import type {BandKeyMap} from '@app/features/activities/band/game/BandInput';
import styles from '@app/features/activities/band/jam/components/JamInfoBox.module.css';
import {JAM_KEY_NAMES} from '@app/features/activities/band/jam/components/JamNoteNames';
import {JAM_LANE_CLASSES} from '@app/features/activities/band/jam/components/JamPads';
import {JAM_OCTAVE_DOWN_CODE, JAM_OCTAVE_UP_CODE} from '@app/features/activities/band/jam/JamKeyboard';
import {
	BACKING_STYLE_DESCRIPTORS,
	BPM_DESCRIPTOR,
	INFO_BEND_DESCRIPTOR,
	INFO_COLLAPSE_DESCRIPTOR,
	INFO_DRUM_ALTERNATE_DESCRIPTOR,
	INFO_DRUM_KICK_DESCRIPTOR,
	INFO_DRUM_LANES_DESCRIPTOR,
	INFO_EXPAND_DESCRIPTOR,
	INFO_FEEDBACK_DESCRIPTOR,
	INFO_HOLD_DESCRIPTOR,
	INFO_LANES_DESCRIPTOR,
	INFO_NO_INSTRUMENT_DESCRIPTOR,
	INFO_OCTAVE_DESCRIPTOR,
	INFO_PINCH_DESCRIPTOR,
	INFO_TITLE_DESCRIPTOR,
	INFO_WIDE_BEND_DESCRIPTOR,
	SCALE_DESCRIPTORS,
} from '@app/features/activities/band/jam/JamLabels';
import JamSettings from '@app/features/activities/band/jam/JamSettings';
import {useLingui} from '@lingui/react/macro';
import {CaretRightIcon, KeyboardIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const SHIFT_LABEL = keyCapLabel('ShiftLeft');
// The drum lanes Shift changes: hi-hat, tom, crash.
const DRUM_ALTERNATE_LANES = [2, 3, 4] as const;

function Cap({label, lane}: {readonly label: string; readonly lane?: number}) {
	return (
		<kbd
			className={clsx(styles.cap, lane !== undefined && JAM_LANE_CLASSES[lane], lane !== undefined && styles.laneCap)}
			data-flx="activities.band.jam.jam-info-box.cap.cap"
		>
			{label}
		</kbd>
	);
}

function Row({
	keys,
	children,
	quiet = false,
}: {
	readonly keys: React.ReactNode;
	readonly children: string;
	readonly quiet?: boolean;
}) {
	return (
		<li className={clsx(styles.row, quiet && styles.quiet)} data-flx="activities.band.jam.jam-info-box.row.row">
			<span className={styles.keys} data-flx="activities.band.jam.jam-info-box.row.keys">
				{keys}
			</span>
			<span className={styles.what} data-flx="activities.band.jam.jam-info-box.row.what">
				{children}
			</span>
		</li>
	);
}

const KeyRows = observer(function KeyRows({
	instrument,
	keyMap,
}: {
	readonly instrument: BandJamInstrument | null;
	readonly keyMap: BandKeyMap;
}) {
	const {i18n} = useLingui();
	if (!instrument)
		return (
			<p className={styles.empty} data-flx="activities.band.jam.jam-info-box.key-rows.empty">
				{i18n._(INFO_NO_INSTRUMENT_DESCRIPTOR)}
			</p>
		);
	const lanes = keyMap.frets.map((code, lane) => (
		<Cap key={code} label={keyCapLabel(code)} lane={lane} data-flx="activities.band.jam.jam-info-box.lanes.cap" />
	));
	const [bendCode] = keyMap.kick;
	const bend = bendCode ? keyCapLabel(bendCode) : null;
	if (instrument === 'drums') {
		return (
			<ul className={styles.rows} data-flx="activities.band.jam.jam-info-box.key-rows.rows">
				<Row keys={lanes} data-flx="activities.band.jam.jam-info-box.key-rows.row">
					{i18n._(INFO_DRUM_LANES_DESCRIPTOR)}
				</Row>
				<Row
					keys={
						<>
							<Cap label={SHIFT_LABEL} data-flx="activities.band.jam.jam-info-box.key-rows.cap" />
							{DRUM_ALTERNATE_LANES.map((lane) => {
								const code = keyMap.frets[lane];
								return code ? (
									<Cap
										key={code}
										label={keyCapLabel(code)}
										lane={lane}
										data-flx="activities.band.jam.jam-info-box.key-rows.cap--2"
									/>
								) : null;
							})}
						</>
					}
					data-flx="activities.band.jam.jam-info-box.key-rows.row--2"
				>
					{i18n._(INFO_DRUM_ALTERNATE_DESCRIPTOR)}
				</Row>
				{bend && (
					<Row
						keys={<Cap label={bend} data-flx="activities.band.jam.jam-info-box.key-rows.cap--3" />}
						data-flx="activities.band.jam.jam-info-box.key-rows.row--3"
					>
						{i18n._(INFO_DRUM_KICK_DESCRIPTOR)}
					</Row>
				)}
			</ul>
		);
	}
	const [first, second] = keyMap.frets;
	return (
		<ul className={styles.rows} data-flx="activities.band.jam.jam-info-box.key-rows.rows--2">
			<Row keys={lanes} data-flx="activities.band.jam.jam-info-box.key-rows.row--4">
				{i18n._(INFO_LANES_DESCRIPTOR)}
			</Row>
			<Row
				keys={
					<span className={styles.hold} data-flx="activities.band.jam.jam-info-box.key-rows.hold">
						{first && (
							<Cap label={keyCapLabel(first)} lane={0} data-flx="activities.band.jam.jam-info-box.key-rows.cap--4" />
						)}
						<span
							className={clsx(styles.holdTail, JAM_LANE_CLASSES[0])}
							data-flx="activities.band.jam.jam-info-box.key-rows.hold-tail"
						/>
					</span>
				}
				data-flx="activities.band.jam.jam-info-box.key-rows.row--5"
			>
				{i18n._(INFO_HOLD_DESCRIPTOR)}
			</Row>
			{instrument === 'guitar' && (
				<Row keys={null} quiet data-flx="activities.band.jam.jam-info-box.key-rows.row--6">
					{i18n._(INFO_FEEDBACK_DESCRIPTOR)}
				</Row>
			)}
			{bend && (
				<Row
					keys={<Cap label={bend} data-flx="activities.band.jam.jam-info-box.key-rows.cap--5" />}
					data-flx="activities.band.jam.jam-info-box.key-rows.row--7"
				>
					{i18n._(INFO_BEND_DESCRIPTOR)}
				</Row>
			)}
			{bend && (
				<Row
					keys={
						<>
							<Cap label={SHIFT_LABEL} data-flx="activities.band.jam.jam-info-box.key-rows.cap--6" />
							<Cap label={bend} data-flx="activities.band.jam.jam-info-box.key-rows.cap--7" />
						</>
					}
					data-flx="activities.band.jam.jam-info-box.key-rows.row--8"
				>
					{i18n._(INFO_WIDE_BEND_DESCRIPTOR)}
				</Row>
			)}
			{instrument === 'guitar' && first && second && (
				<Row
					keys={
						<>
							<Cap label={keyCapLabel(first)} lane={0} data-flx="activities.band.jam.jam-info-box.key-rows.cap--8" />
							<Cap label={keyCapLabel(second)} lane={1} data-flx="activities.band.jam.jam-info-box.key-rows.cap--9" />
						</>
					}
					data-flx="activities.band.jam.jam-info-box.key-rows.row--9"
				>
					{i18n._(INFO_PINCH_DESCRIPTOR)}
				</Row>
			)}
			<Row
				keys={
					<>
						<Cap
							label={keyCapLabel(JAM_OCTAVE_DOWN_CODE)}
							data-flx="activities.band.jam.jam-info-box.key-rows.cap--10"
						/>
						<Cap label={keyCapLabel(JAM_OCTAVE_UP_CODE)} data-flx="activities.band.jam.jam-info-box.key-rows.cap--11" />
					</>
				}
				data-flx="activities.band.jam.jam-info-box.key-rows.row--10"
			>
				{i18n._(INFO_OCTAVE_DESCRIPTOR)}
			</Row>
		</ul>
	);
});

// The small box on the right in place of a tutorial: the room's key and scale and what each of my keys does. Folding
// it is remembered on this device.
export const JamInfoBox = observer(function JamInfoBox({
	state,
	instrument,
	keyMap,
}: {
	readonly state: BandJamState;
	readonly instrument: BandJamInstrument | null;
	readonly keyMap: BandKeyMap;
}) {
	const {i18n} = useLingui();
	const collapsed = JamSettings.infoCollapsed;
	const toggleLabel = i18n._(collapsed ? INFO_EXPAND_DESCRIPTOR : INFO_COLLAPSE_DESCRIPTOR);
	return (
		<aside
			className={clsx(styles.box, collapsed && styles.collapsed)}
			aria-label={i18n._(INFO_TITLE_DESCRIPTOR)}
			data-flx="activities.band.jam.jam-info-box.box"
		>
			<header className={styles.header} data-flx="activities.band.jam.jam-info-box.header">
				{!collapsed && (
					<h3 className={styles.title} data-flx="activities.band.jam.jam-info-box.title">
						{i18n._(INFO_TITLE_DESCRIPTOR)}
					</h3>
				)}
				<button
					type="button"
					className={styles.toggle}
					aria-expanded={!collapsed}
					aria-label={toggleLabel}
					title={toggleLabel}
					onClick={() => JamSettings.setInfoCollapsed(!collapsed)}
					data-flx="activities.band.jam.jam-info-box.toggle.set-info-collapsed.button"
				>
					{collapsed ? (
						<KeyboardIcon
							size={18}
							weight="bold"
							aria-hidden="true"
							data-flx="activities.band.jam.jam-info-box.keyboard-icon"
						/>
					) : (
						<CaretRightIcon
							size={14}
							weight="bold"
							aria-hidden="true"
							data-flx="activities.band.jam.jam-info-box.caret-right-icon"
						/>
					)}
				</button>
			</header>
			{!collapsed && (
				<>
					<div className={styles.room} data-flx="activities.band.jam.jam-info-box.room">
						<span className={styles.roomKey} data-flx="activities.band.jam.jam-info-box.room-key">
							{JAM_KEY_NAMES[state.key]}
						</span>
						<span className={styles.roomScale} data-flx="activities.band.jam.jam-info-box.room-scale">
							{i18n._(SCALE_DESCRIPTORS[state.scale])}
							<span className={styles.roomTempo} data-flx="activities.band.jam.jam-info-box.room-tempo">
								{i18n._(BPM_DESCRIPTOR, {bpm: state.backing.bpm})}
								{state.backing.on && ` · ${i18n._(BACKING_STYLE_DESCRIPTORS[state.backing.style])}`}
							</span>
						</span>
					</div>
					<KeyRows instrument={instrument} keyMap={keyMap} data-flx="activities.band.jam.jam-info-box.key-rows" />
				</>
			)}
		</aside>
	);
});
