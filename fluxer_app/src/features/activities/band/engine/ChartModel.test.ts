// SPDX-License-Identifier: AGPL-3.0-or-later

import {isLeadPart} from '@app/features/activities/band/engine/ChartModel';
import {describe, expect, it} from 'vitest';

describe('isLeadPart', () => {
	it('names guitar the lead only when the song also has rhythm guitar', () => {
		expect(isLeadPart('guitar', {guitar: ['expert'], rhythm: ['expert']})).toBe(true);
		expect(isLeadPart('guitar', {guitar: ['expert'], bass: ['expert']})).toBe(false);
		expect(isLeadPart('guitar', {guitar: ['expert'], rhythm: []})).toBe(false);
		expect(isLeadPart('rhythm', {guitar: ['expert'], rhythm: ['expert']})).toBe(false);
	});
});
