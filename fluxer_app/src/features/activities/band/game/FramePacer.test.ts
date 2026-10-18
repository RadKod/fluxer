// SPDX-License-Identifier: AGPL-3.0-or-later

import {FramePacer} from '@app/features/activities/band/game/FramePacer';
import {describe, expect, it} from 'vitest';

describe('FramePacer', () => {
	it('expects the first frame one 60 Hz refresh after its timestamp', () => {
		expect(new FramePacer().presentAt(1000)).toBeCloseTo(1000 + 1000 / 60);
	});

	it('learns a faster screen from the frame timestamps', () => {
		const pacer = new FramePacer();
		for (let frame = 0; frame < 120; frame++) pacer.presentAt(frame * (1000 / 144));
		expect(pacer.refreshIntervalMs).toBeCloseTo(1000 / 144, 1);
	});

	it('ignores a stall instead of treating it as the refresh rate', () => {
		const pacer = new FramePacer();
		pacer.presentAt(0);
		pacer.presentAt(400);
		expect(pacer.refreshIntervalMs).toBeCloseTo(1000 / 60);
	});
});
