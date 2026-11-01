// SPDX-License-Identifier: AGPL-3.0-or-later

import {performanceToContextTime} from '@app/features/activities/band/engine/SessionClock';
import {BandAudio} from '@app/features/activities/band/game/BandAudio';
import {TIMING_TITLE_DESCRIPTOR} from '@app/features/activities/band/game/BandGameLabels';
import {trustedTimeStamp} from '@app/features/activities/band/game/BandInput';
import BandSettings, {type DuckDepth} from '@app/features/activities/band/game/BandSettings';
import {FramePacer} from '@app/features/activities/band/game/FramePacer';
import {
	CALIBRATION_INTERVAL_S,
	CALIBRATION_LEAD_IN_CLICKS,
	CALIBRATION_TAPS,
	type CalibrationOutcome,
	type CalibrationPlan,
	calibrationOutcome,
	planCalibration,
} from '@app/features/activities/band/game/LatencyCalibration';
import styles from '@app/features/activities/band/game/LatencyCalibrationScreen.module.css';
import {resizeCanvas} from '@app/features/activities/band/game/PlayStageParts';
import {Button} from '@app/features/ui/button/Button';
import {Switch} from '@app/features/ui/components/form/FormSwitch';
import {RadioGroup} from '@app/features/ui/radio_group/RadioGroup';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useId, useRef, useState} from 'react';

const INTRO_DESCRIPTOR = msg({
	message: 'Tap any key on every click. The first {count} clicks count you in.',
	comment: 'Band game rhythm test: instructions. {count} is a small number of metronome clicks before tapping starts.',
});
const VISUAL_INTRO_DESCRIPTOR = msg({
	message: 'Tap any key each time the line crosses the ring. The first {count} lines count you in.',
	comment:
		'Band game visual timing test: instructions. A bright line moves down onto a ring again and again; the player taps as it crosses. {count} is a small number of lines before tapping starts.',
});
const AUDIO_HEADING_DESCRIPTOR = msg({
	message: 'Audio offset',
	context: 'band-rhythm-test',
	comment:
		'Band game settings: heading of the test that measures how late keys and sound arrive on this device, by tapping along to clicks.',
});
const VISUAL_HEADING_DESCRIPTOR = msg({
	message: 'Visual offset',
	context: 'band-rhythm-test',
	comment:
		'Band game settings: heading of the test that measures how late this screen shows the notes, by tapping when a line crosses a ring.',
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
	message: 'Too few taps landed on the beat. Try again.',
	comment:
		'Band game timing tests: the player missed most clicks or lines, so nothing was measured. "The beat" is the clicks or the line crossing the ring.',
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
	message: 'Miss sound',
	comment:
		'Band game settings: switch for the short pick scrape, muted string or drumstick click I hear when I miss a note or press a wrong key. Only I hear it.',
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

// The audio test plays clicks; the visual one moves a line onto a ring. Both count taps against the same plan.
type CalibrationTest = 'audio' | 'visual';

type Phase =
	| {readonly kind: 'idle'}
	| {readonly kind: 'running'; readonly test: CalibrationTest; readonly plan: CalibrationPlan; readonly taps: number}
	| {readonly kind: 'done'; readonly test: CalibrationTest; readonly outcome: CalibrationOutcome}
	| {readonly kind: 'noAudio'};

interface Run {
	readonly test: CalibrationTest;
	readonly plan: CalibrationPlan;
	readonly taps: Array<number>;
	readonly timer: ReturnType<typeof setTimeout>;
}

// The first click or line comes this long after Start, so the player is ready for it.
const START_LEAD_S = 0.4;
const IGNORED_KEYS = new Set(['Escape', 'Tab']);
// The line takes one click interval to fall onto the ring, and the ring lights up this long after each crossing.
const LINE_TRAVEL_S = CALIBRATION_INTERVAL_S;
const RING_FLASH_S = 0.12;
const TARGET_WIDTH = 160;
const TARGET_HEIGHT = 180;

const HEADINGS: Readonly<Record<CalibrationTest, MessageDescriptor>> = {
	audio: AUDIO_HEADING_DESCRIPTOR,
	visual: VISUAL_HEADING_DESCRIPTOR,
};

// The offset each test stands for, as the game applies it: the visual one is what the screen adds on top of the input
// latency, since taps to the line carry both.
function appliedOffsetMs(test: CalibrationTest, measuredMs: number): number {
	return test === 'audio' ? measuredMs : measuredMs - BandSettings.effectiveInputLatencyMs;
}

function storedOffsetMs(test: CalibrationTest): number | null {
	if (test === 'audio') return BandSettings.inputLatencyMs;
	return BandSettings.visualLatencyMs === null ? null : BandSettings.visualOffsetMs;
}

interface LatencyCalibrationScreenProps {
	readonly onClose: () => void;
	// A test started or ended; the song, if one plays, should keep quiet meanwhile.
	readonly onRunningChange?: (running: boolean) => void;
}

// The timing tests for this device. The audio one is a metronome through the song's own audio path: eight taps, the
// median gap is this device's input latency. The visual one draws a line onto a ring on the frame clock the highway
// uses: the median gap there, less the input latency, is how late the screen shows a frame.
export const LatencyCalibrationScreen = observer(function LatencyCalibrationScreen({
	onClose,
	onRunningChange,
}: LatencyCalibrationScreenProps) {
	const {i18n} = useLingui();
	const titleId = useId();
	const [phase, setPhase] = useState<Phase>({kind: 'idle'});
	const audioRef = useRef<BandAudio | null>(null);
	const runRef = useRef<Run | null>(null);
	const unmountedRef = useRef(false);
	const running = phase.kind === 'running';

	useEffect(() => {
		onRunningChange?.(running);
	}, [running, onRunningChange]);

	const finish = useCallback(() => {
		const run = runRef.current;
		if (!run) return;
		clearTimeout(run.timer);
		runRef.current = null;
		setPhase({kind: 'done', test: run.test, outcome: calibrationOutcome(run.plan, run.taps)});
	}, []);

	const begin = useCallback(
		(test: CalibrationTest, plan: CalibrationPlan, lastsMs: number) => {
			const timer = setTimeout(finish, lastsMs);
			runRef.current = {test, plan, taps: [], timer};
			setPhase({kind: 'running', test, plan, taps: 0});
		},
		[finish],
	);

	const start = useCallback(
		async (test: CalibrationTest) => {
			if (runRef.current) return;
			if (test === 'visual') {
				const plan = planCalibration(performance.now() / 1000 + START_LEAD_S);
				begin(test, plan, plan.endTime * 1000 - performance.now());
				return;
			}
			const audio = audioRef.current ?? BandAudio.create();
			if (!audio) {
				setPhase({kind: 'noAudio'});
				return;
			}
			audioRef.current = audio;
			// A suspended context does not move its clock; clicks planned on it would all sound at once on resume.
			await audio.context.resume().catch(() => {});
			if (unmountedRef.current || runRef.current) return;
			const plan = planCalibration(audio.context.currentTime + START_LEAD_S);
			plan.clickTimes.forEach((time, index) => audio.playClick(time, index % 4 === 0));
			begin(test, plan, (plan.endTime - audio.context.currentTime) * 1000);
		},
		[begin],
	);

	const tap = useCallback(
		(timeStamp: number) => {
			const run = runRef.current;
			if (!run) return;
			const stamp = trustedTimeStamp(timeStamp, performance.now());
			const audio = audioRef.current;
			if (run.test === 'audio') {
				if (!audio) return;
				run.taps.push(performanceToContextTime(stamp, audio.readAnchor()));
			} else {
				run.taps.push(stamp / 1000);
			}
			const firstCounted = run.plan.clickTimes[run.plan.firstTapClick];
			const counted = run.taps.filter((tapTime) => tapTime > firstCounted - 0.25).length;
			setPhase({kind: 'running', test: run.test, plan: run.plan, taps: counted});
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
			unmountedRef.current = true;
			if (runRef.current) clearTimeout(runRef.current.timer);
			runRef.current = null;
			audioRef.current?.dispose();
		},
		[],
	);

	const save = (test: CalibrationTest, measuredMs: number) => {
		if (test === 'audio') BandSettings.setInputLatencyMs(measuredMs);
		else BandSettings.setVisualLatencyMs(measuredMs);
		setPhase({kind: 'idle'});
	};

	const current = (test: CalibrationTest) => {
		const offset = storedOffsetMs(test);
		return offset === null ? i18n._(NOT_MEASURED_DESCRIPTOR) : i18n._(CURRENT_DESCRIPTOR, {offset});
	};

	return (
		<section
			className={styles.root}
			aria-labelledby={titleId}
			data-flx="activities.band.game.latency-calibration-screen.root"
		>
			<h3 id={titleId} className={styles.title} data-flx="activities.band.game.latency-calibration-screen.title">
				{i18n._(TIMING_TITLE_DESCRIPTOR)}
			</h3>
			<div className={styles.tests} data-flx="activities.band.game.latency-calibration-screen.tests">
				{(['audio', 'visual'] as const).map((test) => (
					<div key={test} className={styles.test} data-flx="activities.band.game.latency-calibration-screen.test">
						<h4 className={styles.heading} data-flx="activities.band.game.latency-calibration-screen.heading">
							{i18n._(HEADINGS[test])}
						</h4>
						<p className={styles.text} data-flx="activities.band.game.latency-calibration-screen.text">
							{test === 'audio'
								? i18n._(INTRO_DESCRIPTOR, {count: CALIBRATION_LEAD_IN_CLICKS})
								: i18n._(VISUAL_INTRO_DESCRIPTOR, {count: CALIBRATION_LEAD_IN_CLICKS})}
						</p>
						<p className={styles.muted} data-flx="activities.band.game.latency-calibration-screen.muted">
							{current(test)}
						</p>
						<Button
							small
							variant="secondary"
							disabled={running}
							onClick={() => void start(test)}
							data-flx="activities.band.game.latency-calibration-screen.button.start"
						>
							{i18n._(START_DESCRIPTOR)}
						</Button>
					</div>
				))}
			</div>
			{phase.kind === 'running' && (
				<div className={styles.run} data-flx="activities.band.game.latency-calibration-screen.run">
					{phase.test === 'visual' && (
						<VisualTarget plan={phase.plan} data-flx="activities.band.game.latency-calibration-screen.visual-target" />
					)}
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
				</div>
			)}
			{phase.kind === 'done' && (
				<div className={styles.run} data-flx="activities.band.game.latency-calibration-screen.result">
					<p className={styles.text} role="status" data-flx="activities.band.game.latency-calibration-screen.text--3">
						{phase.outcome.kind === 'ok'
							? i18n._(RESULT_DESCRIPTOR, {offset: appliedOffsetMs(phase.test, phase.outcome.latencyMs)})
							: i18n._(phase.outcome.kind === 'tooFewTaps' ? TOO_FEW_DESCRIPTOR : UNSTEADY_DESCRIPTOR)}
					</p>
					<div className={styles.actions} data-flx="activities.band.game.latency-calibration-screen.actions">
						{phase.outcome.kind === 'ok' && (
							<Button
								small
								onClick={() => phase.outcome.kind === 'ok' && save(phase.test, phase.outcome.latencyMs)}
								data-flx="activities.band.game.latency-calibration-screen.button"
							>
								{i18n._(SAVE_DESCRIPTOR)}
							</Button>
						)}
						<Button
							small
							variant="secondary"
							onClick={() => void start(phase.test)}
							data-flx="activities.band.game.latency-calibration-screen.button.start--2"
						>
							{i18n._(RETRY_DESCRIPTOR)}
						</Button>
					</div>
				</div>
			)}
			{phase.kind === 'noAudio' && (
				<p className={styles.text} role="alert" data-flx="activities.band.game.latency-calibration-screen.text--4">
					{i18n._(NO_AUDIO_DESCRIPTOR)}
				</p>
			)}
			<MissFeedbackSettings data-flx="activities.band.game.latency-calibration-screen.miss-feedback-settings" />
			<div className={styles.actions} data-flx="activities.band.game.latency-calibration-screen.actions--2">
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

// The line the visual test is tapped to: it falls onto the ring once per click interval, timed for when the frame
// reaches the screen, exactly as the highway is.
function VisualTarget({plan}: {plan: CalibrationPlan}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas ? resizeCanvas(canvas, TARGET_WIDTH, TARGET_HEIGHT) : null;
		if (!ctx) return;
		const pacer = new FramePacer();
		const ringY = TARGET_HEIGHT - 36;
		const travel = ringY - 12;
		let frameId = 0;
		const draw = (frameTimestamp: number) => {
			const now = pacer.presentAt(frameTimestamp) / 1000;
			ctx.clearRect(0, 0, TARGET_WIDTH, TARGET_HEIGHT);
			const flash = plan.clickTimes.some((time) => now >= time && now - time < RING_FLASH_S);
			ctx.lineWidth = 3;
			ctx.strokeStyle = '#f7f5f0';
			ctx.fillStyle = flash ? '#b5179e' : 'rgba(12, 13, 15, 0.85)';
			ctx.beginPath();
			ctx.ellipse(TARGET_WIDTH / 2, ringY, 26, 22, 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
			ctx.strokeStyle = '#d64bbf';
			ctx.shadowColor = '#b5179e';
			ctx.shadowBlur = 10;
			ctx.lineWidth = 4;
			for (const time of plan.clickTimes) {
				const ahead = time - now;
				if (ahead < -RING_FLASH_S || ahead > LINE_TRAVEL_S) continue;
				const y = ringY - (ahead / LINE_TRAVEL_S) * travel;
				ctx.beginPath();
				ctx.moveTo(12, y);
				ctx.lineTo(TARGET_WIDTH - 12, y);
				ctx.stroke();
			}
			ctx.shadowBlur = 0;
			frameId = requestAnimationFrame(draw);
		};
		frameId = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frameId);
	}, [plan]);
	return (
		<canvas
			ref={canvasRef}
			className={styles.target}
			style={{width: TARGET_WIDTH, height: TARGET_HEIGHT}}
			data-flx="activities.band.game.latency-calibration-screen.visual-target.target"
		/>
	);
}

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
