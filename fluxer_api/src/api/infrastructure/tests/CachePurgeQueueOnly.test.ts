// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {createCachePurgeAdapter} from '@app/api/infrastructure/CachePurgeAdapter';
import {setInjectedKVProvider} from '@app/api/middleware/ServiceRegistry';
import {getPurgeQueue, resetServiceSingletonsForTesting} from '@app/api/middleware/ServiceSingletons';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

describe('queue_only cache purge adapter', () => {
	let previousAdapter: typeof Config.cachePurge.adapter;
	let previousMedia: string;
	let kvClient: MockKVProvider;

	beforeEach(() => {
		previousAdapter = Config.cachePurge.adapter;
		previousMedia = Config.endpoints.media;
		Config.cachePurge.adapter = 'queue_only';
		Config.endpoints.media = 'https://media.test';
		kvClient = new MockKVProvider();
		setInjectedKVProvider(kvClient);
		resetServiceSingletonsForTesting();
	});

	afterEach(() => {
		Config.cachePurge.adapter = previousAdapter;
		Config.endpoints.media = previousMedia;
		setInjectedKVProvider(new MockKVProvider());
		resetServiceSingletonsForTesting();
	});

	it('queues the purge of a deleted asset for the worker', async () => {
		await getPurgeQueue().addUrls(['https://media.test/attachments/1/2/a.png']);

		expect(await kvClient.smembers('cache_purge:{q}:queue')).toEqual(['media.test/attachments/1/2/a']);
	});

	it('builds no purge adapter, so a batch can never be marked purged in this process', () => {
		expect(() => createCachePurgeAdapter(Config.cachePurge)).toThrow(
			'FLUXER_CACHE_PURGE_ADAPTER is queue_only: this process queues purges and never sends them',
		);
	});
});
