// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import type {APICachePurgeConfig} from '@app/api/config/APIConfig';
import {CachePurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {server} from '@app/api/test/msw/server';
import processCachePurgeQueue from '@app/api/worker/tasks/ProcessCachePurgeQueue';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {computeHashSlot} from '@pkgs/kv_client/src/KVHashSlots';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {delay, HttpResponse, http} from 'msw';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const HELPERS = {logger: new NoopLogger()} as unknown as WorkerTaskHelpers;
const ENDPOINT = 'https://cache-purge.test/__cache/purge';
const MEDIA = 'https://media.test';
const QUEUE_KEY = 'cache_purge:{q}:queue';
const BUDGET_KEY = 'cache_purge:{q}:budget';
const LEGACY_QUEUE_KEY = 'cache_purge:queue';
const PRIORITY_KEY = 'cache_purge:{q}:priority';
const REJECTED_KEY = 'cache_purge:rejected';
const BUNNY: APICachePurgeConfig['bunny'] = {
	apiBase: 'https://bunny-api.test',
	apiKey: 'bunny-key',
	timeoutMs: 50,
	concurrency: 8,
	mode: 'prefix',
	pullZoneId: 0,
	ratePerMinute: 30,
	burst: 20,
};

interface PurgeBody {
	prefixes: Array<string>;
}

interface RecordedRequest {
	authorization: string | null;
	contentType: string | null;
	body: PurgeBody;
}

function createHarness() {
	const kvClient = new MockKVProvider();
	setWorkerDependenciesForTest({kvClient});
	return {kvClient, queue: new CachePurgeQueue(kvClient)};
}

function recordPurges(respond: (body: PurgeBody) => Response | Promise<Response>): Array<RecordedRequest> {
	const requests: Array<RecordedRequest> = [];
	server.use(
		http.post(ENDPOINT, async ({request}) => {
			const body = (await request.json()) as PurgeBody;
			requests.push({
				authorization: request.headers.get('authorization'),
				contentType: request.headers.get('content-type'),
				body,
			});
			return respond(body);
		}),
	);
	return requests;
}

async function members(kvClient: MockKVProvider, key: string): Promise<Array<string>> {
	return (await kvClient.smembers(key)).sort();
}

function sorted(values: Array<string>): Array<string> {
	return [...values].sort();
}

function recordBunnyPurges(): Array<string> {
	const purged: Array<string> = [];
	server.use(
		http.post('https://bunny-api.test/purge', ({request}) => {
			purged.push(new URL(request.url).searchParams.get('url') ?? '');
			return new HttpResponse(null, {status: 200});
		}),
	);
	return purged;
}

function ordinaryBacklog(size: number): Array<string> {
	return Array.from({length: size}, (_, index) => `media.test/attachments/1/${index}/a`);
}

describe('processCachePurgeQueue', () => {
	let previousCachePurge: APICachePurgeConfig;
	let previousMedia: string;

	beforeEach(() => {
		previousCachePurge = {...Config.cachePurge};
		previousMedia = Config.endpoints.media;
		Config.endpoints.media = MEDIA;
		Config.cachePurge.adapter = 'http';
		Config.cachePurge.http = {endpoint: ENDPOINT, token: 'test-token', timeoutMs: 50};
	});

	afterEach(() => {
		Config.cachePurge.adapter = previousCachePurge.adapter;
		Config.cachePurge.http = previousCachePurge.http;
		Config.cachePurge.bunny = previousCachePurge.bunny;
		Config.endpoints.media = previousMedia;
		clearWorkerDependencies();
		vi.useRealTimers();
	});

	it('sends host qualified prefixes in one request and drains the queue', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([
			`${MEDIA}/avatars/1/a_b35cc3d3`,
			`${MEDIA}/emojis/9.webp`,
			`${MEDIA}/attachments/1/2/ação.png`,
		]);
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(requests[0]!.authorization).toBe('Bearer test-token');
		expect(requests[0]!.contentType).toBe('application/json');
		expect(sorted(requests[0]!.body.prefixes)).toEqual(
			sorted([
				'media.test/avatars/1/a_b35cc3d3',
				'media.test/avatars/1/b35cc3d3',
				'media.test/emojis/9',
				'media.test/attachments/1/2/ação',
			]),
		);
		expect(await members(kvClient, QUEUE_KEY)).toEqual([]);
	});

	it('collapses every extension of one asset into a single prefix', async () => {
		const {queue} = createHarness();
		await queue.addUrls([`${MEDIA}/stickers/7.webp`, `${MEDIA}/stickers/7.gif`, `${MEDIA}/stickers/7.png`]);
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(requests[0]!.body.prefixes).toEqual(['media.test/stickers/7']);
	});

	it.each([200, 202, 204])('treats %i as accepted and drops the batch', async (status) => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const requests = recordPurges(() => new HttpResponse(null, {status}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(await members(kvClient, QUEUE_KEY)).toEqual([]);
		expect(await members(kvClient, REJECTED_KEY)).toEqual([]);
	});

	it('never queues a URL that is not a media CDN object', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls(['https://elsewhere.test/avatars/1/b35cc3d3', `${MEDIA}/avatars`, 'not-a-url']);
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toEqual([]);
		expect(await members(kvClient, QUEUE_KEY)).toEqual([]);
	});

	it('requeues the whole batch after a server error', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`, `${MEDIA}/attachments/1/3/b.png`]);
		const requests = recordPurges(() => new HttpResponse(null, {status: 503}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(await members(kvClient, QUEUE_KEY)).toEqual([
			'media.test/attachments/1/2/a',
			'media.test/attachments/1/3/b',
		]);
		expect(await members(kvClient, REJECTED_KEY)).toEqual([]);
	});

	it('requeues the batch when the endpoint does not answer in time', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const requests = recordPurges(async () => {
			await delay('infinite');
			return new HttpResponse(null, {status: 204});
		});

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(await members(kvClient, QUEUE_KEY)).toEqual(['media.test/attachments/1/2/a']);
	});

	it('requeues the batch when the endpoint is unreachable', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const requests = recordPurges(() => HttpResponse.error());

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(await members(kvClient, QUEUE_KEY)).toEqual(['media.test/attachments/1/2/a']);
	});

	it('requeues the batch on a redirect without following it', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const redirectTarget = 'https://cache-purge.test/elsewhere';
		const redirectedRequests: Array<string> = [];
		server.use(
			http.all(redirectTarget, ({request}) => {
				redirectedRequests.push(request.method);
				return new HttpResponse(null, {status: 204});
			}),
		);
		const requests = recordPurges(() => new HttpResponse(null, {status: 302, headers: {Location: redirectTarget}}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(redirectedRequests).toEqual([]);
		expect(await members(kvClient, QUEUE_KEY)).toEqual(['media.test/attachments/1/2/a']);
	});

	it('requeues rather than discards when the bearer token is refused', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const requests = recordPurges(() => new HttpResponse(null, {status: 401}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(await members(kvClient, QUEUE_KEY)).toEqual(['media.test/attachments/1/2/a']);
		expect(await members(kvClient, REJECTED_KEY)).toEqual([]);
	});

	it.each([400, 422])('sets the batch aside when the endpoint answers %i', async (status) => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`, `${MEDIA}/emojis/9.webp`]);
		const requests = recordPurges(() => new HttpResponse(null, {status}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(await members(kvClient, QUEUE_KEY)).toEqual([]);
		expect(await members(kvClient, REJECTED_KEY)).toEqual(['media.test/attachments/1/2/a', 'media.test/emojis/9']);
	});

	it('leaves the queue untouched when the adapter is none', async () => {
		Config.cachePurge.adapter = 'none';
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toEqual([]);
		expect(await members(kvClient, QUEUE_KEY)).toEqual(['media.test/attachments/1/2/a']);
		expect(await kvClient.get(BUDGET_KEY)).toBeNull();
	});

	it('leaves both queues and the budget untouched when the process only queues purges', async () => {
		Config.cachePurge.adapter = 'queue_only';
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		await queue.addUrls([`${MEDIA}/attachments/9/9/removed.png`], {priority: true});
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));
		const bunnyPurges = recordBunnyPurges();

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toEqual([]);
		expect(bunnyPurges).toEqual([]);
		expect(await members(kvClient, QUEUE_KEY)).toEqual(['media.test/attachments/1/2/a']);
		expect(await members(kvClient, PRIORITY_KEY)).toEqual(['media.test/attachments/9/9/removed']);
		expect(kvClient.dequeuePurgeBatchSpy).not.toHaveBeenCalled();
		expect(await kvClient.get(BUDGET_KEY)).toBeNull();
	});

	it('hands the dequeued prefixes to the Bunny adapter and requeues them when it fails', async () => {
		Config.cachePurge.adapter = 'bunny';
		Config.cachePurge.bunny = {...BUNNY};
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/avatars/1/a_b35cc3d3`, `${MEDIA}/attachments/1/2/a.png`]);
		const purged: Array<string | null> = [];
		server.use(
			http.post('https://bunny-api.test/purge', ({request}) => {
				const url = new URL(request.url).searchParams.get('url');
				purged.push(url);
				return new HttpResponse(null, {status: url?.includes('/attachments/') ? 429 : 200});
			}),
		);

		await processCachePurgeQueue({}, HELPERS);

		expect(sorted(purged as Array<string>)).toEqual(
			sorted([
				'https://media.test/avatars/1/a_b35cc3d3*',
				'https://media.test/avatars/1/b35cc3d3*',
				'https://media.test/attachments/1/2/a*',
			]),
		);
		expect(await members(kvClient, QUEUE_KEY)).toEqual([
			'media.test/attachments/1/2/a',
			'media.test/avatars/1/a_b35cc3d3',
			'media.test/avatars/1/b35cc3d3',
		]);
		expect(await members(kvClient, REJECTED_KEY)).toEqual([]);
	});

	it('keeps the prefixes beyond the Bunny purge budget queued instead of retrying the whole batch', async () => {
		Config.cachePurge.adapter = 'bunny';
		Config.cachePurge.bunny = {...BUNNY, burst: 2};
		const {kvClient, queue} = createHarness();
		await queue.addUrls(Array.from({length: 5}, (_, index) => `${MEDIA}/attachments/1/${index}/a.png`));
		let calls = 0;
		// Bunny's own bucket: its burst is spent after two purges and every later one is refused.
		server.use(
			http.post('https://bunny-api.test/purge', () => new HttpResponse(null, {status: ++calls <= 2 ? 200 : 429})),
		);

		await processCachePurgeQueue({}, HELPERS);

		expect(calls).toBe(2);
		expect(await kvClient.scard(QUEUE_KEY)).toBe(3);
		expect(await members(kvClient, REJECTED_KEY)).toEqual([]);
	});

	it('sends no more than the token bucket allows and refills at the configured rate', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
		const {kvClient, queue} = createHarness();
		await queue.addUrls(Array.from({length: 200}, (_, index) => `${MEDIA}/attachments/1/${index}/a.png`));
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);
		await processCachePurgeQueue({}, HELPERS);
		vi.setSystemTime(Date.now() + 10_000);
		await processCachePurgeQueue({}, HELPERS);

		expect(requests.map((request) => request.body.prefixes.length)).toEqual([120, 50]);
		expect(await kvClient.scard(QUEUE_KEY)).toBe(30);
	});

	it('keeps every key a dequeue touches in one cluster slot', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);

		const keys: Array<string> = kvClient.dequeuePurgeBatchSpy.mock.calls.flatMap(([queueKey, bucketKey]) => [
			queueKey,
			bucketKey,
		]);
		expect(keys.length).toBeGreaterThan(0);
		expect(new Set(keys.map(computeHashSlot)).size).toBe(1);
		expect(requests).toHaveLength(1);
	});

	it('drains prefixes queued under the key of the previous release, also ones added after the first run', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
		const {kvClient} = createHarness();
		const legacy = Array.from({length: 200}, (_, index) => `media.test/attachments/1/${index}/a`);
		await kvClient.sadd(LEGACY_QUEUE_KEY, ...legacy);
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests.map((request) => request.body.prefixes.length)).toEqual([120]);
		expect(await kvClient.scard(LEGACY_QUEUE_KEY)).toBe(0);
		expect(sorted([...requests[0]!.body.prefixes, ...(await kvClient.smembers(QUEUE_KEY))])).toEqual(sorted(legacy));

		// An API pod of the previous release may still write the old key during a rolling deploy.
		await kvClient.sadd(LEGACY_QUEUE_KEY, 'media.test/emojis/9');
		vi.setSystemTime(Date.now() + 60_000);
		await processCachePurgeQueue({}, HELPERS);

		expect(requests[1]!.body.prefixes).toContain('media.test/emojis/9');
		expect(await kvClient.scard(LEGACY_QUEUE_KEY)).toBe(0);
		expect(await kvClient.scard(QUEUE_KEY)).toBe(0);
	});

	it('sends an urgent prefix in the next batch while ten thousand ordinary prefixes wait', async () => {
		const {kvClient, queue} = createHarness();
		await kvClient.sadd(QUEUE_KEY, ...ordinaryBacklog(10_000));
		await queue.addUrls([`${MEDIA}/attachments/9/9/removed.png`], {priority: true});
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(requests[0]!.body.prefixes).toHaveLength(120);
		expect(requests[0]!.body.prefixes[0]).toBe('media.test/attachments/9/9/removed');
		expect(await kvClient.scard(PRIORITY_KEY)).toBe(0);
		expect(await kvClient.scard(QUEUE_KEY)).toBe(10_000 - 119);
	});

	it('spends the last Bunny token on the urgent prefix, not on the ten thousand prefix backlog', async () => {
		Config.cachePurge.adapter = 'bunny';
		Config.cachePurge.bunny = {...BUNNY, burst: 2};
		const {kvClient, queue} = createHarness();
		await kvClient.sadd(QUEUE_KEY, ...ordinaryBacklog(10_000));
		await queue.addUrls([`${MEDIA}/attachments/9/9/removed.png`], {priority: true});
		// Leave one token in the shared Bunny bucket (burst 2, one token per two seconds at 30 per minute).
		await kvClient.tryConsumeTokens('cache_purge:bunny_budget', 1, 2, 1, 2000);
		const purged = recordBunnyPurges();

		await processCachePurgeQueue({}, HELPERS);

		expect(purged).toEqual(['https://media.test/attachments/9/9/removed*']);
		expect(await kvClient.scard(PRIORITY_KEY)).toBe(0);
		expect(await kvClient.scard(QUEUE_KEY)).toBe(10_000);
	});

	it('keeps urgent prefixes that the Bunny budget defers in the urgent queue', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
		Config.cachePurge.adapter = 'bunny';
		Config.cachePurge.bunny = {...BUNNY, burst: 2};
		const {kvClient, queue} = createHarness();
		await queue.addUrls(Array.from({length: 100}, (_, index) => `${MEDIA}/attachments/1/${index}/a.png`));
		const urgent = Array.from({length: 5}, (_, index) => `media.test/attachments/9/${index}/removed`);
		await queue.addUrls(
			urgent.map((prefix) => `https://${prefix}.png`),
			{priority: true},
		);
		const purged = recordBunnyPurges();

		await processCachePurgeQueue({}, HELPERS);

		expect(purged).toHaveLength(2);
		const deferred = urgent.filter((prefix) => !purged.includes(`https://${prefix}*`));
		expect(deferred).toHaveLength(3);
		expect(await members(kvClient, PRIORITY_KEY)).toEqual(sorted(deferred));
		expect(await kvClient.scard(QUEUE_KEY)).toBe(100);

		// The Bunny bucket refills to its burst of two, and both tokens go to deferred urgent prefixes.
		vi.setSystemTime(Date.now() + 4_000);
		await processCachePurgeQueue({}, HELPERS);

		expect(purged.slice(2)).toHaveLength(2);
		for (const url of purged.slice(2)) {
			expect(deferred.map((prefix) => `https://${prefix}*`)).toContain(url);
		}
		expect(await kvClient.scard(PRIORITY_KEY)).toBe(1);
		expect(await kvClient.scard(QUEUE_KEY)).toBe(100);
	});

	it('gives ordinary prefixes the budget urgent ones leave, so the ordinary queue keeps moving', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/emojis/1.webp`, `${MEDIA}/emojis/2.webp`, `${MEDIA}/emojis/3.webp`]);
		await queue.addUrls([`${MEDIA}/attachments/9/9/removed.png`], {priority: true});
		const requests = recordPurges(() => new HttpResponse(null, {status: 204}));

		await processCachePurgeQueue({}, HELPERS);
		await queue.addUrls([`${MEDIA}/emojis/4.webp`]);
		await processCachePurgeQueue({}, HELPERS);

		expect(requests.map((request) => request.body.prefixes)).toEqual([
			['media.test/attachments/9/9/removed', 'media.test/emojis/1', 'media.test/emojis/2', 'media.test/emojis/3'],
			['media.test/emojis/4'],
		]);
		expect(await kvClient.scard(PRIORITY_KEY)).toBe(0);
		expect(await kvClient.scard(QUEUE_KEY)).toBe(0);
	});

	it('returns urgent prefixes to the urgent queue when the purge fails', async () => {
		const {kvClient, queue} = createHarness();
		await queue.addUrls([`${MEDIA}/emojis/1.webp`]);
		await queue.addUrls([`${MEDIA}/attachments/9/9/removed.png`], {priority: true});
		const requests = recordPurges(() => new HttpResponse(null, {status: 503}));

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(await members(kvClient, PRIORITY_KEY)).toEqual(['media.test/attachments/9/9/removed']);
		expect(await members(kvClient, QUEUE_KEY)).toEqual(['media.test/emojis/1']);
	});
});
