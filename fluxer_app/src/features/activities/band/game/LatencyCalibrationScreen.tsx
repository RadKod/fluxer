// SPDX-License-Identifier: AGPL-3.0-or-later

import {performanceToContextTime} from '@app/features/activities/band/engine/SessionClock';
import {BandAudio} from '@app/features/activities/band/game/BandAudio';
import BandSettings, {type DuckDepth} from '@app/features/activities/band/game/BandSettings';
import {
	CALIBRATION_LEAD_IN_CLICKS,
	CALIBRATION_TAPS,
	type CalibrationOutcome,
	type CalibrationPlan,
	calibrationOutcome,
	planCalibration,
} from '@app/features/activities/band/game/LatencyCalibration';
import styles from '@app/features/activities/band/game/LatencyCalibrationScreen.module.css';
import {Button} from '@app/features/ui/button/Button';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import {RadioGroup} from '@app/features/ui/radio_group/RadioGroup';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useId, useRef, useState} from 'react';

const TITLE_DESCRIPTOR = msg({
	message: 'Rhythm test',
	comment: 'Band game: title of the short test that measures keyboard and audio delay on this device.',
});
const INTRO_DESCRIPTOR = msg({
	message: 'Tap any key on every click. The first {count} clicks count you in.',
	comment: 'Band game rhythm test: instructions. {count} is a small number of metronome clicks before tapping starts.',
});
const CURRENT_DESCRIPTOR = msg({
	message: 'Current offset: {offset} ms',
	comment: 'Band game rhythm test: the stored delay correction for this device, in milliseconds.',
});
const NOT_MEASURED_DESCRIPTOR = msg({
	message: 'Not measured on this device yet.',
	comment: 'Band game rhythm test: shown when the test has never been run on this device.',
});
const START_DESCRIPTOR = msg({
	message: 'Start',
	context: 'band-rhythm-test',
	comment: 'Band game rhythm test: button that starts the metronome.',
});
const TAP_DESCRIPTOR = msg({
	message: 'Tap',
	context: 'band-rhythm-test',
	comment: 'Band game rhythm test: big button to tap along with the clicks (keys work too).',
});
const PROGRESS_DESCRIPTOR = msg({
	message: '{count} of {total} taps',
	comment: 'Band game rhythm test: how many taps have been counted so far. Both are numbers.',
});
const RESULT_DESCRIPTOR = msg({
	message: 'Your offset: {offset} ms',
	comment: 'Band game rhythm test: the measured delay correction, in milliseconds; can be negative.',
});
const TOO_FEW_DESCRIPTOR = msg({
	message: 'Too few taps landed on the clicks. Try again.',
	comment: 'Band game rhythm test: the player missed most clicks, so nothing was measured.',
});
const UNSTEADY_DESCRIPTOR = msg({
	message: 'The taps were too uneven to measure. Try again.',
	comment: 'Band game rhythm test: the taps were scattered, so the delay could not be measured.',
});
const SAVE_DESCRIPTOR = msg({
	message: 'Save',
	context: 'band-rhythm-test',
	comment: 'Band game rhythm test: stores the measured offset for this device.',
});
const RETRY_DESCRIPTOR = msg({
	message: 'Try again',
	context: 'band-rhythm-test',
	comment: 'Band game rhythm test: runs the test again.',
});
const CLOSE_DESCRIPTOR = msg({
	message: 'Close',
	context: 'band-rhythm-test',
	comment: 'Band game rhythm test: leaves the test without changing anything.',
});
const MISS_SOUND_DESCRIPTOR = msg({
	message: 'Sound effect on a miss',
	comment: 'Band game settings: switch for a short muted-string or drum thud sound when I miss a note.',
});
const DUCK_DEPTH_DESCRIPTOR = msg({
	message: 'Song dip on a miss',
	comment: 'Band game settings: how much a missed part of the song drops in volume. Options are Light and Strong.',
});
const DUCK_LIGHT_DESCRIPTOR = msg({
	message: 'Light',
	context: 'band-miss-dip',
	comment: 'Band game settings: the missed part gets a little quieter for a moment.',
});
const DUCK_STRONG_DESCRIPTOR = msg({
	message: 'Strong',
	context: 'band-miss-dip',
	comment: 'Band game settings: the missed part goes almost silent for a moment.',
});
const NO_AUDIO_DESCRIPTOR = msg({
	message: 'This device cannot play the test clicks.',
	comment: 'Band game rhythm test: shown when the browser has no Web Audio support.',
});

type Phase =
	| {readonly kind: 'idle'}
	| {readonly kind: 'running'; readonly taps: number}
	| {readonly kind: 'done'; readonly outcome: CalibrationOutcome}
	| {readonly kind: 'noAudio'};

const IGNORED_KEYS = new Set(['Escape', 'Tab']);

interface LatencyCalibrationScreenProps {
	readonly onClose: () => void;
}

// "Ritme bas": a metronome through the song's own audio path, eight taps, the median gap becomes this device's
// input latency.
export const LatencyCalibrationScreen = observer(function LatencyCalibrationScreen({
	onClose,
}: LatencyCalibrationScreenProps) {
	const {i18n} = useLingui();
	const titleId = useId();
	const [phase, setPhase] = useState<Phase>({kind: 'idle'});
	const audioRef = useRef<BandAudio | null>(null);
	const runRef = useRef<{plan: CalibrationPlan; taps: Array<number>; timer: ReturnType<typeof setTimeout>} | null>(
		null,
	);

	const finish = useCallback(() => {
		const run = runRef.current;
		if (!run) return;
		clearTimeout(run.timer);
		runRef.current = null;
		setPhase({kind: 'done', outcome: calibrationOutcome(run.plan, run.taps)});
	}, []);

	const start = useCallback(() => {
		const audio = audioRef.current ?? BandAudio.create();
		if (!audio) {
			setPhase({kind: 'noAudio'});
			return;
		}
		audioRef.current = audio;
		void audio.context.resume().catch(() => {});
		const plan = planCalibration(audio.context.currentTime + 0.4);
		plan.clickTimes.forEach((time, index) => audio.playClick(time, index % 4 === 0));
		const timer = setTimeout(finish, (plan.endTime - audio.context.currentTime) * 1000);
		runRef.current = {plan, taps: [], timer};
		setPhase({kind: 'running', taps: 0});
	}, [finish]);

	const tap = useCallback(
		(timeStamp: number) => {
			const run = runRef.current;
			const audio = audioRef.current;
			if (!run || !audio) return;
			const time = performanceToContextTime(timeStamp, audio.readAnchor());
			run.taps.push(time);
			const firstCounted = run.plan.clickTimes[run.plan.firstTapClick];
			const counted = run.taps.filter((tapTime) => tapTime > firstCounted - 0.25).length;
			setPhase({kind: 'running', taps: counted});
			if (counted >= CALIBRATION_TAPS) finish();
		},
		[finish],
	);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.repeat || IGNORED_KEYS.has(event.key) || !runRef.current) return;
			event.preventDefault();
			tap(event.timeStamp);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [tap]);

	useEffect(
		() => () => {
			if (runRef.current) clearTimeout(runRef.current.timer);
			audioRef.current?.dispose();
		},
		[],
	);

	const save = (latencyMs: number) => {
		BandSettings.setInputLatencyMs(latencyMs);
		onClose();
	};

	return (
		<section
			className={styles.root}
			aria-labelledby={titleId}
			data-flx="activities.band.game.latency-calibration-screen.root"
		>
			<h3 id={titleId} className={styles.title} data-flx="activities.band.game.latency-calibration-screen.title">
				{i18n._(TITLE_DESCRIPTOR)}
			</h3>
			<p className={styles.text} data-flx="activities.band.game.latency-calibration-screen.text">
				{i18n._(INTRO_DESCRIPTOR, {count: CALIBRATION_LEAD_IN_CLICKS})}
			</p>
			<p className={styles.muted} data-flx="activities.band.game.latency-calibration-screen.muted">
				{BandSettings.inputLatencyMs === null
					? i18n._(NOT_MEASURED_DESCRIPTOR)
					: i18n._(CURRENT_DESCRIPTOR, {offset: BandSettings.inputLatencyMs})}
			</p>
			{phase.kind === 'running' && (
				<>
					<button
						type="button"
						className={styles.pad}
						onPointerDown={(event) => tap(event.timeStamp)}
						data-flx="activities.band.game.latency-calibration-screen.pad.tap.button"
					>
						{i18n._(TAP_DESCRIPTOR)}
					</button>
					<p
						className={styles.text}
						aria-live="polite"
						data-flx="activities.band.game.latency-calibration-screen.text--2"
					>
						{i18n._(PROGRESS_DESCRIPTOR, {count: phase.taps, total: CALIBRATION_TAPS})}
					</p>
				</>
			)}
			{phase.kind === 'done' && (
				<p className={styles.text} role="status" data-flx="activities.band.game.latency-calibration-screen.text--3">
					{phase.outcome.kind === 'ok'
						? i18n._(RESULT_DESCRIPTOR, {offset: phase.outcome.latencyMs})
						: i18n._(phase.outcome.kind === 'tooFewTaps' ? TOO_FEW_DESCRIPTOR : UNSTEADY_DESCRIPTOR)}
				</p>
			)}
			{phase.kind === 'noAudio' && (
				<p className={styles.text} role="alert" data-flx="activities.band.game.latency-calibration-screen.text--4">
					{i18n._(NO_AUDIO_DESCRIPTOR)}
				</p>
			)}
			<MissFeedbackSettings data-flx="activities.band.game.latency-calibration-screen.miss-feedback-settings" />
			<div className={styles.actions} data-flx="activities.band.game.latency-calibration-screen.actions">
				{phase.kind === 'idle' && (
					<Button small onClick={start} data-flx="activities.band.game.latency-calibration-screen.button.start">
						{i18n._(START_DESCRIPTOR)}
					</Button>
				)}
				{phase.kind === 'done' && phase.outcome.kind === 'ok' && (
					<Button
						small
						onClick={() => phase.outcome.kind === 'ok' && save(phase.outcome.latencyMs)}
						data-flx="activities.band.game.latency-calibration-screen.button"
					>
						{i18n._(SAVE_DESCRIPTOR)}
					</Button>
				)}
				{phase.kind === 'done' && (
					<Button
						small
						variant="secondary"
						onClick={start}
						data-flx="activities.band.game.latency-calibration-screen.button.start--2"
					>
						{i18n._(RETRY_DESCRIPTOR)}
					</Button>
				)}
				<Button
					small
					variant="secondary"
					onClick={onClose}
					data-flx="activities.band.game.latency-calibration-screen.button.close"
				>
					{i18n._(CLOSE_DESCRIPTOR)}
				</Button>
			</div>
		</section>
	);
});

// How a miss sounds on this device; per device like the offset, since it is about these speakers.
const MissFeedbackSettings = observer(function MissFeedbackSettings() {
	const {i18n} = useLingui();
	const depthLabel = i18n._(DUCK_DEPTH_DESCRIPTOR);
	return (
		<div
			className={styles.settings}
			data-flx="activities.band.game.latency-calibration-screen.miss-feedback-settings.settings"
		>
			<Switch
				compact
				label={i18n._(MISS_SOUND_DESCRIPTOR)}
				value={BandSettings.missSound}
				onChange={BandSettings.setMissSound}
				data-flx="activities.band.game.latency-calibration-screen.miss-feedback-settings.switch"
			/>
			<p
				className={styles.settingLabel}
				data-flx="activities.band.game.latency-calibration-screen.miss-feedback-settings.setting-label"
			>
				{depthLabel}
			</p>
			<RadioGroup<DuckDepth>
				aria-label={depthLabel}
				value={BandSettings.duckDepth}
				onChange={BandSettings.setDuckDepth}
				options={[
					{value: 'light', name: i18n._(DUCK_LIGHT_DESCRIPTOR)},
					{value: 'strong', name: i18n._(DUCK_STRONG_DESCRIPTOR)},
				]}
				data-flx="activities.band.game.latency-calibration-screen.miss-feedback-settings.radio-group"
			/>
		</div>
	);
});
