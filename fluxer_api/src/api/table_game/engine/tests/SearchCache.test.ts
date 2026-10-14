// SPDX-License-Identifier: AGPL-3.0-or-later

import {searchCache} from '@app/api/table_game/engine/SearchCache';
import {describe, expect, it, vi} from 'vitest';

describe('searchCache', () => {
	it('computes a key once, keeps the most recently used and drops the oldest past its size', () => {
		const compute = vi.fn((key: string) => key.toUpperCase());
		const cached = searchCache<string>(2);
		const get = (key: string) => cached(key, () => compute(key));
		expect([get('a'), get('b'), get('a'), get('c')]).toEqual(['A', 'B', 'A', 'C']); // c pushes b, the oldest, out
		expect(compute).toHaveBeenCalledTimes(3);
		get('a');
		get('c');
		expect(compute).toHaveBeenCalledTimes(3);
		get('b');
		expect(compute).toHaveBeenCalledTimes(4);
	});
});
