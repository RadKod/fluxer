// SPDX-License-Identifier: AGPL-3.0-or-later

import {noteGroup} from '@app/features/activities/band/engine/BandTestFixtures';
import {FretLane} from '@app/features/activities/band/engine/ChartModel';
import {BandTimingProbe} from '@app/features/activities/band/game/BandTimingProbe';
import type {SeatTrack} from '@app/features/activities/band/game/PlayController';
import {describe, expect, it} from 'vitest';

function track(feedback: SeatTrack['feedback'] = null): SeatTrack {
	const groups = [noteGroup(0, [FretLane.Green]), noteGroup(500, [FretLane.Green]), noteGroup(600, [FretLane.Red])];
	return {
		chart: {groups},
		finale: null,
		freestyle: [],
		noteStates: new Uint8Array(groups.length),
		feedback,
	} as unknown as SeatTrack;
}

const PRESS = {lane: FretLane.Green, eventTimeStamp: 1_000, handledAt: 1_004};

describe('BandTimingProbe', () => {
	it('keeps each press with the nearest note of its lane and what the judge said', () => {
		const probe = new BandTimingProbe();
		probe.recordPress(track({kind: 'good', atMs: 452}), {...PRESS, judgeMs: 452}, []);
		probe.recordPress(track(), {...PRESS, judgeMs: 230}, [
			{kind: 'overhit', lane: FretLane.Green, timeMs: 230, comboBroken: true},
		]);
		expect(probe.presses.map(({judgeMs, nearestNoteMs, verdict}) => [judgeMs, nearestNoteMs, verdict])).toEqual([
			[230, 0, 'stray'],
			[452, 500, 'good'],
		]);
	});

	it('fills in a fret note judged after its slop, matched by the press time', () => {
		const probe = new BandTimingProbe();
		probe.recordPress(track(), {...PRESS, judgeMs: 498}, []);
		expect(probe.presses[0].verdict).toBeNull();
		probe.observe({kind: 'perfect', atMs: 498});
		expect(probe.presses[0].verdict).toBe('perfect');
	});

	it('smooths the frame time and leaves stalls out', () => {
		const probe = new BandTimingProbe();
		for (const timestamp of [0, 16, 32, 48, 400, 416]) probe.recordFrame(timestamp, 16.4);
		expect(probe.frameMs).toBeCloseTo(16);
		expect(probe.refreshIntervalMs).toBe(16.4);
	});
});
