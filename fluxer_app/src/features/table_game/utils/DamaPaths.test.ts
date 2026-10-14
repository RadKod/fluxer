// SPDX-License-Identifier: AGPL-3.0-or-later

import {parsePaths, pathsFor} from '@app/features/table_game/utils/DamaPaths';
import {describe, expect, it} from 'vitest';

describe('DamaPaths', () => {
	it('paths for from/to; several → choose', () => {
		const paths = parsePaths(['c3-c4', 'c3-c5-e5', 'c3-e3-e5', 'f2-f3']);
		expect(paths).toEqual([
			['c3', 'c4'],
			['c3', 'c5', 'e5'],
			['c3', 'e3', 'e5'],
			['f2', 'f3'],
		]);
		expect(pathsFor(paths, 'c3', 'c4')).toEqual([['c3', 'c4']]);
		expect(pathsFor(paths, 'c3', 'e5')).toEqual([
			['c3', 'c5', 'e5'],
			['c3', 'e3', 'e5'],
		]);
		expect(pathsFor(paths, 'c3', 'c5')).toEqual([]);
	});

	it('no legal moves (not my turn) → no paths', () => {
		expect(parsePaths(null)).toEqual([]);
	});
});
