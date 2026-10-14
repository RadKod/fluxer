// SPDX-License-Identifier: AGPL-3.0-or-later

import {BannedProfileSubstrings} from '@app/api/Tables';
import {describe, expect, it} from 'vitest';

describe('username dictionary partition metadata', () => {
	it('deletes one dictionary scope without requiring a substring key', () => {
		expect(BannedProfileSubstrings.partitionKey).toEqual(['scope']);
		const query = BannedProfileSubstrings.deletePartition({scope: 'uname_exact:g12'});
		expect(query.cql).toBe('DELETE FROM banned_profile_substrings WHERE scope = :scope;');
		expect(query.params).toEqual({scope: 'uname_exact:g12'});
		expect(query.kvMeta?.table.partitionKey).toEqual(['scope']);
	});
});
