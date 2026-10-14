// SPDX-License-Identifier: AGPL-3.0-or-later

import type {APICachePurgeConfig} from '@app/api/config/APIConfig';
import {createBunnyCachePurgeAdapter} from '@app/api/infrastructure/BunnyCachePurgeAdapter';
import {createControllerCachePurgeAdapter} from '@app/api/infrastructure/ControllerCachePurgeAdapter';
import {createHttpCachePurgeAdapter} from '@app/api/infrastructure/HttpCachePurgeAdapter';
import {createNoneCachePurgeAdapter} from '@app/api/infrastructure/NoneCachePurgeAdapter';
import type {CachePurgeAdapterName} from '@fluxer/config/src/MasterConfig';

export type CachePurgeOutcome =
	| {readonly kind: 'purged'}
	| {readonly kind: 'rejected'; readonly status: number}
	| {readonly kind: 'failed'; readonly status: number | null; readonly error: unknown};

export interface CachePurgeAdapter {
	purge(prefixes: ReadonlyArray<string>): Promise<CachePurgeOutcome>;
}

// Micup: a queue_only process holds no CDN credential and only fills the queue; the worker purges with its own adapter.
function refuseQueueOnlyPurge(): CachePurgeAdapter {
	throw new Error('FLUXER_CACHE_PURGE_ADAPTER is queue_only: this process queues purges and never sends them');
}

const CACHE_PURGE_ADAPTERS = {
	none: createNoneCachePurgeAdapter,
	http: createHttpCachePurgeAdapter,
	controller: createControllerCachePurgeAdapter,
	bunny: createBunnyCachePurgeAdapter,
	queue_only: refuseQueueOnlyPurge,
} satisfies Record<CachePurgeAdapterName, (config: APICachePurgeConfig) => CachePurgeAdapter>;

export function createCachePurgeAdapter(config: APICachePurgeConfig): CachePurgeAdapter {
	return CACHE_PURGE_ADAPTERS[config.adapter](config);
}
