// SPDX-License-Identifier: AGPL-3.0-or-later

import {FeedDiscoverRepository} from '@app/api/feed/discover/FeedDiscoverRepository';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {normalizeScoreBound, parseRangeByScoreArguments} from '@pkgs/kv_client/src/KVCommandArguments';
import {describe, expect, it} from 'vitest';

// The mock KV reads Redis' exclusive '(' bounds; the real KVClient rejects them before Redis sees them. Check the
// arguments exactly as KVClient.zrangebyscore does.
class ValidatingKVProvider extends MockKVProvider {
	override async zrangebyscore(
		key: string,
		min: string | number,
		max: string | number,
		...args: Array<string | number>
	): Promise<Array<string>> {
		parseRangeByScoreArguments(args);
		return super.zrangebyscore(key, normalizeScoreBound(min), normalizeScoreBound(max), ...args);
	}
}

describe('FeedDiscoverRepository evictions', () => {
	it('prunes the evictions older than the bound and keeps the rest, through the real KV argument checks', async () => {
		const repository = new FeedDiscoverRepository(new ValidatingKVProvider());
		await repository.publishEvict('post', '1', 1000);
		await repository.publishEvict('post', '2', 1999);
		await repository.publishEvict('post', '3', 2000);
		await repository.publishEvict('author', '4', 2001);

		await repository.pruneEvictionsBefore(2000);

		expect(await repository.listEvictionsSince(0)).toEqual(new Set(['post:3', 'author:4']));
		expect(await repository.countEvictions()).toBe(2);
	});
});
