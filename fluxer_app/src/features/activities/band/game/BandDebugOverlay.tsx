// SPDX-License-Identifier: AGPL-3.0-or-later

// Timing readout for chasing input and sync problems on a player's machine. Off unless localStorage has
// `sanalyer:band-debug` = '1' or Ctrl+Alt+D is pressed while the game has the keyboard (which also remembers it).
// A developer tool: its labels stay in English and are not translated.

import styles from '@app/features/activities/band/game/BandDebugOverlay.module.css';
import BandSettings from '@app/features/activities/band/game/BandSettings';
import type {PressRecord} from '@app/features/activities/band/game/BandTimingProbe';
import type {PlayRuntime} from '@app/features/activities/band/game/PlayRuntime';
import {type RefObject, useEffect, useState} from 'react';

export const BAND_DEBUG_STORAGE_KEY = 'sanalyer:band-debug';
const REFRESH_MS = 100;

function readFlag(): boolean {
	try {
		return window.localStorage.getItem(BAND_DEBUG_STORAGE_KEY) === '1';
	} catch {
		return false;
	}
}

function writeFlag(on: boolean): void {
	try {
		if (on) window.localStorage.setItem(BAND_DEBUG_STORAGE_KEY, '1');
		else window.localStorage.removeItem(BAND_DEBUG_STORAGE_KEY);
	} catch {
		// Storage blocked: the toggle lasts for this song only.
	}
}

export function isBandDebugToggle(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'metaKey'>): boolean {
	return event.code === 'KeyD' && event.ctrlKey && event.altKey && !event.metaKey;
}

// Whether the readout is on; Ctrl+Alt+D on `rootRef` flips it.
export function useBandDebug(rootRef: RefObject<HTMLElement | null>): boolean {
	const [enabled, setEnabled] = useState(readFlag);
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!isBandDebugToggle(event)) return;
			event.preventDefault();
			setEnabled((on) => {
				writeFlag(!on);
				return !on;
			});
		};
		root.addEventListener('keydown', onKeyDown);
		return () => root.removeEventListener('keydown', onKeyDown);
	}, [rootRef]);
	return enabled;
}

function ms(value: number | null | undefined, digits = 1): string {
	return value === null || value === undefined || !Number.isFinite(value) ? '–' : value.toFixed(digits);
}

function signed(value: number): string {
	return `${value > 0 ? '+' : ''}${value.toFixed(0)}`;
}

function PressRow({press}: {press: PressRecord}) {
	const offset = press.nearestNoteMs === null ? null : press.judgeMs - press.nearestNoteMs;
	return (
		<tr data-flx="activities.band.game.band-debug-overlay.press-row.row">
			<td data-flx="activities.band.game.band-debug-overlay.press-row.lane">{press.lane}</td>
			<td data-flx="activities.band.game.band-debug-overlay.press-row.stamp">{ms(press.eventTimeStamp)}</td>
			<td data-flx="activities.band.game.band-debug-overlay.press-row.now">{ms(press.handledAt)}</td>
			<td data-flx="activities.band.game.band-debug-overlay.press-row.delay">
				{ms(press.handledAt - press.eventTimeStamp)}
			</td>
			<td data-flx="activities.band.game.band-debug-overlay.press-row.judge">{ms(press.judgeMs, 0)}</td>
			<td data-flx="activities.band.game.band-debug-overlay.press-row.note">{ms(press.nearestNoteMs, 0)}</td>
			<td data-flx="activities.band.game.band-debug-overlay.press-row.offset">
				{offset === null ? '–' : signed(offset)}
			</td>
			<td data-flx="activities.band.game.band-debug-overlay.press-row.verdict">{press.verdict ?? '…'}</td>
		</tr>
	);
}

export function BandDebugOverlay({runtime}: {runtime: PlayRuntime}) {
	const [, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((tick) => tick + 1), REFRESH_MS);
		return () => clearInterval(timer);
	}, []);
	const {context} = runtime.audio;
	const {probe} = runtime;
	return (
		<div className={styles.overlay} aria-hidden="true" data-flx="activities.band.game.band-debug-overlay.overlay">
			<div className={styles.stats} data-flx="activities.band.game.band-debug-overlay.stats">
				<span data-flx="activities.band.game.band-debug-overlay.output">
					outputLatency {ms((context.outputLatency ?? Number.NaN) * 1000)} · baseLatency{' '}
					{ms((context.baseLatency ?? Number.NaN) * 1000)} · heard behind render {ms(runtime.audio.outputDelayMs())}
				</span>
				<span data-flx="activities.band.game.band-debug-overlay.clock">
					session clock offset {ms(runtime.clockOffsetMs)} · input offset {BandSettings.effectiveInputLatencyMs} ·
					visual offset {BandSettings.visualOffsetMs}
				</span>
				<span data-flx="activities.band.game.band-debug-overlay.frames">
					frame {ms(probe.frameMs, 2)} · pacer interval {ms(probe.refreshIntervalMs, 2)}
				</span>
			</div>
			<table className={styles.presses} data-flx="activities.band.game.band-debug-overlay.presses">
				<thead data-flx="activities.band.game.band-debug-overlay.head">
					<tr data-flx="activities.band.game.band-debug-overlay.head-row">
						<th data-flx="activities.band.game.band-debug-overlay.head-lane">lane</th>
						<th data-flx="activities.band.game.band-debug-overlay.head-stamp">event.timeStamp</th>
						<th data-flx="activities.band.game.band-debug-overlay.head-now">now</th>
						<th data-flx="activities.band.game.band-debug-overlay.head-delay">Δ</th>
						<th data-flx="activities.band.game.band-debug-overlay.head-judge">judge</th>
						<th data-flx="activities.band.game.band-debug-overlay.head-note">note</th>
						<th data-flx="activities.band.game.band-debug-overlay.head-offset">offset</th>
						<th data-flx="activities.band.game.band-debug-overlay.head-verdict">verdict</th>
					</tr>
				</thead>
				<tbody data-flx="activities.band.game.band-debug-overlay.body">
					{probe.presses.map((press) => (
						<PressRow
							key={`${press.handledAt}:${press.lane}`}
							press={press}
							data-flx="activities.band.game.band-debug-overlay.press-row"
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}
