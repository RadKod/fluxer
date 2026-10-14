// SPDX-License-Identifier: AGPL-3.0-or-later

import {BatchBuilder, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {BannedProfileSubstringRow} from '@app/api/database/types/AdminArchiveTypes';
import {ProfileSubstringBlocklistCache} from '@app/api/middleware/ProfileSubstringBlocklistCache';
import {BannedProfileSubstrings} from '@app/api/Tables';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('ProfileSubstringBlocklistCache', () => {
	let cache: ProfileSubstringBlocklistCache;
	beforeEach(() => {
		cache = new ProfileSubstringBlocklistCache();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		cache.resetForTesting();
	});
	it('refresh replaces every scope while preserving name widening and normalized matches', async () => {
		cache.add('bio', 'oldbio');
		// Micup: the cache reads each profile scope's partition, so the rows are stored rather than mocked.
		const rows: Array<BannedProfileSubstringRow> = [
			{scope: 'username', substring: 'Unban Tor', added_at: null, added_by: null, notes: null},
			{scope: 'bio', substring: 'blockedbio', added_at: null, added_by: null, notes: null},
		];
		for (const row of rows) await upsertOne(BannedProfileSubstrings.upsertAll(row));
		try {
			await cache.refresh();
		} finally {
			const cleanup = new BatchBuilder();
			for (const {scope, substring} of rows)
				cleanup.addPrepared(BannedProfileSubstrings.deleteByPk({scope, substring}));
			await cleanup.execute();
		}
		expect(cache.containsBannedSubstring('nickname', 'ｕｎｂａｎ　ｔｏｒ')).toBe(true);
		expect(cache.containsBannedSubstring('global_name', 'u n b a n t o r')).toBe(true);
		expect(cache.containsBannedSubstring('bio', 'unban tor')).toBe(false);
		expect(cache.containsBannedSubstring('username', 'blockedbio')).toBe(false);
		expect(cache.containsBannedSubstring('bio', 'blockedbio')).toBe(true);
		expect(cache.containsBannedSubstring('bio', 'oldbio')).toBe(false);
		cache.remove('username', 'UNBAN TOR');
		expect(cache.containsBannedSubstring('nickname', 'u n b a n t o r')).toBe(false);
	});
	it('shares banned substrings across profile name scopes', () => {
		cache.add('username', 'blockedslug');
		expect(cache.containsBannedSubstring('global_name', 'BlockedSlug Display')).toBe(true);
		expect(cache.containsBannedSubstring('nickname', 'BlockedSlug Nick')).toBe(true);
		expect(cache.isSubstringBanned('global_name', 'blockedslug')).toBe(true);
	});
	it('keeps bio and pronoun scopes separate from profile names', () => {
		cache.add('username', 'blockedslug');
		expect(cache.containsBannedSubstring('bio', 'bio with blockedslug')).toBe(false);
		expect(cache.containsBannedSubstring('pronouns', 'blockedslug')).toBe(false);
	});
});
