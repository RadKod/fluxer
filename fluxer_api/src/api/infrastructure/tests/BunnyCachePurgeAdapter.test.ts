// SPDX-License-Identifier: AGPL-3.0-or-later

import {inspect} from 'node:util';
import {buildAPIConfigFromMaster, Config} from '@app/api/Config';
import type {APICachePurgeConfig} from '@app/api/config/APIConfig';
import {createBunnyCachePurgeAdapter} from '@app/api/infrastructure/BunnyCachePurgeAdapter';
import {CachePurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {Logger} from '@app/api/Logger';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {server} from '@app/api/test/msw/server';
import processCachePurgeQueue from '@app/api/worker/tasks/ProcessCachePurgeQueue';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {loadConfig, resetConfig} from '@fluxer/config/src/ConfigLoader';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {delay, HttpResponse, http} from 'msw';
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const API_BASE = 'https://bunny-api.test';
const API_KEY = 'bunny-account-key-4f9c2e1a-do-not-log';
const MEDIA = 'https://media.micup.gg';
const PULL_ZONE_ID = 42;
const QUEUE_KEY = 'cache_purge:{q}:queue';

interface RecordedPurge {
	url: string | null;
	async: string | null;
	accessKey: string | null;
	rawQuery: string;
}

function bunnyConfig(overrides: Partial<APICachePurgeConfig['bunny']> = {}): APICachePurgeConfig {
	return {
		adapter: 'bunny',
		http: {endpoint: '', token: '', timeoutMs: 10_000},
		bunny: {
			apiBase: API_BASE,
			apiKey: API_KEY,
			timeoutMs: 50,
			concurrency: 8,
			mode: 'prefix',
			pullZoneId: 0,
			ratePerMinute: 30,
			burst: 20,
			...overrides,
		},
	};
}

function recordBunnyPurges(respond: (purgedUrl: string) => Response | Promise<Response>): Array<RecordedPurge> {
	const requests: Array<RecordedPurge> = [];
	server.use(
		http.post(`${API_BASE}/purge`, ({request}) => {
			const url = new URL(request.url);
			requests.push({
				url: url.searchParams.get('url'),
				async: url.searchParams.get('async'),
				accessKey: request.headers.get('accesskey'),
				rawQuery: url.search,
			});
			return respond(url.searchParams.get('url') ?? '');
		}),
	);
	return requests;
}

interface RecordedTagPurge {
	cacheTag: unknown;
	accessKey: string | null;
	contentType: string | null;
}

function recordBunnyTagPurges(respond: (cacheTag: string) => Response | Promise<Response>): Array<RecordedTagPurge> {
	const requests: Array<RecordedTagPurge> = [];
	server.use(
		http.post(`${API_BASE}/pullzone/${PULL_ZONE_ID}/purgeCache`, async ({request}) => {
			const body = (await request.json()) as {CacheTag?: unknown};
			requests.push({
				cacheTag: body.CacheTag,
				accessKey: request.headers.get('accesskey'),
				contentType: request.headers.get('content-type'),
			});
			return respond(String(body.CacheTag));
		}),
	);
	return requests;
}

function tagConfig(overrides: Partial<APICachePurgeConfig['bunny']> = {}): APICachePurgeConfig {
	return bunnyConfig({mode: 'tag', pullZoneId: PULL_ZONE_ID, ...overrides});
}

function useBudgetStore(): MockKVProvider {
	const kvClient = new MockKVProvider();
	setWorkerDependenciesForTest({kvClient});
	return kvClient;
}

async function queued(kvClient: MockKVProvider): Promise<Array<string>> {
	return (await kvClient.smembers(QUEUE_KEY)).sort();
}

const PREFIXES = ['media.micup.gg/avatars/1/abc', 'media.micup.gg/emojis/9', 'media.micup.gg/attachments/1/2/a'];

describe('createBunnyCachePurgeAdapter', () => {
	beforeEach(() => {
		useBudgetStore();
	});

	afterEach(() => {
		clearWorkerDependencies();
	});

	it('sends one wildcard purge per prefix with the account key', async () => {
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig()).purge(PREFIXES);

		expect(outcome).toEqual({kind: 'purged'});
		expect(requests).toHaveLength(3);
		expect(requests.map((request) => request.url).sort()).toEqual([
			'https://media.micup.gg/attachments/1/2/a*',
			'https://media.micup.gg/avatars/1/abc*',
			'https://media.micup.gg/emojis/9*',
		]);
		expect(requests.map((request) => request.rawQuery)).toContain(
			'?url=https%3A%2F%2Fmedia.micup.gg%2Favatars%2F1%2Fabc*&async=true',
		);
		for (const request of requests) {
			expect(request.accessKey).toBe(API_KEY);
			expect(request.async).toBe('true');
		}
	});

	it('purges a Turkish file name under both its percent-encoded and its decoded spelling', async () => {
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig()).purge([
			'media.micup.gg/attachments/1/2/Ekran_görüntüsü_çşğıİ_2026',
		]);

		expect(outcome).toEqual({kind: 'purged'});
		expect(requests.map((request) => request.url).sort()).toEqual([
			'https://media.micup.gg/attachments/1/2/Ekran_g%C3%B6r%C3%BCnt%C3%BCs%C3%BC_%C3%A7%C5%9F%C4%9F%C4%B1%C4%B0_2026*',
			'https://media.micup.gg/attachments/1/2/Ekran_görüntüsü_çşğıİ_2026*',
		]);
	});

	it('keeps the port of a media host that carries one', async () => {
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));

		await createBunnyCachePurgeAdapter(bunnyConfig()).purge(['localhost:8088/media/attachments/1/2/ç']);

		expect(requests.map((request) => request.url).sort()).toEqual([
			'https://localhost:8088/media/attachments/1/2/%C3%A7*',
			'https://localhost:8088/media/attachments/1/2/ç*',
		]);
	});

	it('fails the batch when one purge is rate limited', async () => {
		recordBunnyPurges((url) => new HttpResponse(null, {status: url.includes('/emojis/') ? 429 : 200}));

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig()).purge(PREFIXES);

		expect(outcome).toMatchObject({kind: 'failed', status: 429});
	});

	it('rejects the batch when Bunny refuses one purge URL as malformed', async () => {
		recordBunnyPurges((url) => new HttpResponse(null, {status: url.includes('/emojis/') ? 400 : 200}));

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig()).purge(PREFIXES);

		expect(outcome).toEqual({kind: 'rejected', status: 400});
	});

	it('fails rather than rejects when a malformed URL shares the batch with a failed purge', async () => {
		recordBunnyPurges((url) => {
			if (url.includes('/emojis/')) return new HttpResponse(null, {status: 400});
			if (url.includes('/avatars/')) return new HttpResponse(null, {status: 503});
			return new HttpResponse(null, {status: 200});
		});

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig()).purge(PREFIXES);

		expect(outcome).toMatchObject({kind: 'failed', status: 503});
	});

	it('fails with no status when Bunny does not answer in time', async () => {
		recordBunnyPurges(async () => {
			await delay('infinite');
			return new HttpResponse(null, {status: 200});
		});

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig()).purge(PREFIXES.slice(0, 1));

		expect(outcome).toMatchObject({kind: 'failed', status: null});
	});

	it('does not follow a redirect that would carry the account key elsewhere', async () => {
		const redirectTarget = 'https://elsewhere.test/purge';
		const redirected: Array<string | null> = [];
		server.use(
			http.all(redirectTarget, ({request}) => {
				redirected.push(request.headers.get('accesskey'));
				return new HttpResponse(null, {status: 200});
			}),
		);
		recordBunnyPurges(() => new HttpResponse(null, {status: 307, headers: {Location: redirectTarget}}));

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig()).purge(PREFIXES.slice(0, 1));

		expect(outcome).toMatchObject({kind: 'failed', status: 307});
		expect(redirected).toEqual([]);
	});

	it('keeps no more purges in flight than the configured concurrency', async () => {
		let inFlight = 0;
		let peak = 0;
		recordBunnyPurges(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await delay(5);
			inFlight--;
			return new HttpResponse(null, {status: 200});
		});

		const prefixes = Array.from({length: 6}, (_, index) => `media.micup.gg/attachments/1/${index}/a`);
		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig({concurrency: 2})).purge(prefixes);

		expect(outcome).toEqual({kind: 'purged'});
		expect(peak).toBe(2);
	});
});

describe('Bunny tag purges', () => {
	beforeEach(() => {
		useBudgetStore();
	});

	afterEach(() => {
		clearWorkerDependencies();
	});

	it('purges one cache tag per asset on the pull zone with the account key', async () => {
		const requests = recordBunnyTagPurges(() => new HttpResponse(null, {status: 204}));

		const outcome = await createBunnyCachePurgeAdapter(tagConfig()).purge([
			'media.micup.gg/avatars/1/a_b35cc3d3',
			'media.micup.gg/avatars/1/b35cc3d3',
			'media.micup.gg/emojis/9',
			'media.micup.gg/guilds/5/users/6/avatars/abcdef12',
		]);

		expect(outcome).toEqual({kind: 'purged'});
		expect(requests.map((request) => request.cacheTag).sort()).toEqual([
			'avatars/1/a_b35cc3d3',
			'avatars/1/b35cc3d3',
			'emojis/9',
			'guilds/5/users/6/avatars/abcdef12',
		]);
		for (const request of requests) {
			expect(request.accessKey).toBe(API_KEY);
			expect(request.contentType).toBe('application/json');
		}
	});

	it('purges a Turkish-named attachment with one tag that covers every spelling of its name', async () => {
		const requests = recordBunnyTagPurges(() => new HttpResponse(null, {status: 204}));

		const outcome = await createBunnyCachePurgeAdapter(tagConfig()).purge([
			'media.micup.gg/attachments/1/2/Ekran_görüntüsü_çşğıİ_2026',
			'media.micup.gg/attachments/3/4/0123abcd',
			'media.micup.gg/attachments/3/4/a_0123abcd',
		]);

		expect(outcome).toEqual({kind: 'purged'});
		expect(requests.map((request) => request.cacheTag).sort()).toEqual(['attachments/1/2', 'attachments/3/4']);
	});

	it.each([429, 404, 401])('fails the batch when Bunny answers a tag purge with %i', async (status) => {
		recordBunnyTagPurges((tag) => new HttpResponse(null, {status: tag === 'emojis/9' ? status : 204}));

		const outcome = await createBunnyCachePurgeAdapter(tagConfig()).purge(PREFIXES);

		expect(outcome).toMatchObject({kind: 'failed', status});
	});

	it('rejects the batch when Bunny refuses a tag purge as malformed', async () => {
		recordBunnyTagPurges((tag) => new HttpResponse(null, {status: tag === 'emojis/9' ? 400 : 204}));

		const outcome = await createBunnyCachePurgeAdapter(tagConfig()).purge(PREFIXES);

		expect(outcome).toEqual({kind: 'rejected', status: 400});
	});
});

describe('Bunny purge budget', () => {
	const FIVE = Array.from({length: 5}, (_, index) => `media.micup.gg/attachments/1/${index}/a`);
	let kvClient: MockKVProvider;

	beforeEach(() => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
		kvClient = useBudgetStore();
	});

	afterEach(() => {
		clearWorkerDependencies();
		vi.useRealTimers();
	});

	it('sends no more purges than the budget holds and hands the rest back to the queue', async () => {
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig({burst: 3})).purge(FIVE);

		expect(outcome).toEqual({kind: 'purged'});
		expect(requests).toHaveLength(3);
		const deferred = await queued(kvClient);
		expect(deferred).toHaveLength(2);
		expect(requests.map((request) => request.url?.replace(/^https:\/\/|\*$/gu, '')).sort()).toEqual(
			FIVE.filter((prefix) => !deferred.includes(prefix)).sort(),
		);
	});

	it('refills the budget at the configured rate per minute', async () => {
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));
		const adapter = createBunnyCachePurgeAdapter(bunnyConfig({burst: 3, ratePerMinute: 30}));

		await adapter.purge(FIVE.slice(0, 3));
		await adapter.purge(FIVE.slice(3));
		expect(requests).toHaveLength(3);
		vi.setSystemTime(Date.now() + 4_000);
		await adapter.purge(await kvClient.spop(QUEUE_KEY, 10));

		expect(requests).toHaveLength(5);
		expect(await queued(kvClient)).toEqual([]);
	});

	it('shares one budget between adapters so worker replicas cannot overrun Bunny together', async () => {
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));

		await createBunnyCachePurgeAdapter(bunnyConfig({burst: 3})).purge(FIVE.slice(0, 3));
		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig({burst: 3})).purge(FIVE.slice(3));

		expect(outcome).toEqual({kind: 'purged'});
		expect(requests).toHaveLength(3);
		expect(await queued(kvClient)).toEqual(FIVE.slice(3).sort());
	});

	it('charges both spellings of a Turkish name in prefix mode but a single tag in tag mode', async () => {
		const turkish = 'media.micup.gg/attachments/1/2/Ekran_görüntüsü';
		const prefixRequests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));
		await createBunnyCachePurgeAdapter(bunnyConfig({burst: 2})).purge([FIVE[0]!, turkish]);
		expect(prefixRequests).toHaveLength(1);
		expect(await queued(kvClient)).toEqual([turkish]);

		await kvClient.spop(QUEUE_KEY, 10);
		vi.setSystemTime(Date.now() + 60_000);
		const tagRequests = recordBunnyTagPurges(() => new HttpResponse(null, {status: 204}));
		await createBunnyCachePurgeAdapter(tagConfig({burst: 2})).purge([FIVE[0]!, turkish]);
		expect(tagRequests.map((request) => request.cacheTag).sort()).toEqual(['attachments/1/0', 'attachments/1/2']);
		expect(await queued(kvClient)).toEqual([]);
	});

	it('takes only the tokens it sends when a two-spelling name does not fit the rest of the budget', async () => {
		const turkish = 'media.micup.gg/attachments/1/2/Ekran_görüntüsü';
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));
		const adapter = createBunnyCachePurgeAdapter(bunnyConfig({burst: 2}));

		await adapter.purge([FIVE[0]!, turkish]);
		expect(requests).toHaveLength(1);
		expect(await queued(kvClient)).toEqual([turkish]);

		await adapter.purge([FIVE[1]!]);
		expect(requests).toHaveLength(2);
	});

	it('never sends more than it took when another replica spends the budget after the read', async () => {
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));
		await kvClient.tryConsumeTokens('cache_purge:bunny_budget', 2, 3, 1, 60_000);
		vi.spyOn(kvClient, 'get').mockResolvedValueOnce(JSON.stringify({tokens: 3, lastRefill: Date.now()}));

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig({burst: 3})).purge(FIVE.slice(0, 3));

		expect(outcome).toEqual({kind: 'purged'});
		expect(requests).toHaveLength(1);
		expect(await queued(kvClient)).toHaveLength(2);
	});

	it('still fails the batch on a Bunny rate limit while the unsent prefixes wait in the queue', async () => {
		recordBunnyPurges(() => new HttpResponse(null, {status: 429}));

		const outcome = await createBunnyCachePurgeAdapter(bunnyConfig({burst: 3})).purge(FIVE);

		expect(outcome).toMatchObject({kind: 'failed', status: 429});
		expect(await queued(kvClient)).toHaveLength(2);
	});
});

describe('Bunny cache purge logging', () => {
	const HELPERS = {logger: new NoopLogger()} as unknown as WorkerTaskHelpers;
	let previousCachePurge: APICachePurgeConfig;
	let previousMedia: string;

	afterEach(() => {
		Config.cachePurge.adapter = previousCachePurge.adapter;
		Config.cachePurge.bunny = previousCachePurge.bunny;
		Config.endpoints.media = previousMedia;
		clearWorkerDependencies();
		vi.restoreAllMocks();
	});

	function captureLogs(): Array<unknown> {
		const sink = Logger.child({});
		const calls: Array<unknown> = [];
		for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
			vi.spyOn(sink, level).mockImplementation((...args: Array<unknown>) => {
				calls.push(args);
			});
		}
		return calls;
	}

	it.each([
		['a refused key', () => new HttpResponse('{"Message":"Unauthorized"}', {status: 401})],
		['a rate limit', () => new HttpResponse(null, {status: 429})],
		['an unreachable API', () => HttpResponse.error()],
		[
			'a timeout',
			async () => {
				await delay('infinite');
				return new HttpResponse(null, {status: 200});
			},
		],
	])('never writes the account key to the log after %s', async (_name, respond) => {
		previousCachePurge = {...Config.cachePurge};
		previousMedia = Config.endpoints.media;
		Config.endpoints.media = MEDIA;
		Config.cachePurge.adapter = 'bunny';
		Config.cachePurge.bunny = bunnyConfig().bunny;
		const kvClient = new MockKVProvider();
		setWorkerDependenciesForTest({kvClient});
		await new CachePurgeQueue(kvClient).addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const requests = recordBunnyPurges(respond);
		const logs = captureLogs();

		await processCachePurgeQueue({}, HELPERS);

		expect(requests).toHaveLength(1);
		expect(logs.length).toBeGreaterThan(0);
		expect(inspect(logs, {depth: 20})).not.toContain(API_KEY);
	});

	it.each([
		['a refused tag purge', 'tag' as const, 1],
		['a spent budget', 'prefix' as const, 0],
	])('never writes the account key to the log after %s', async (_name, mode, burstLeft) => {
		previousCachePurge = {...Config.cachePurge};
		previousMedia = Config.endpoints.media;
		Config.endpoints.media = MEDIA;
		Config.cachePurge.adapter = 'bunny';
		Config.cachePurge.bunny = bunnyConfig({mode, pullZoneId: PULL_ZONE_ID, burst: 2}).bunny;
		const kvClient = new MockKVProvider();
		setWorkerDependenciesForTest({kvClient});
		await kvClient.tryConsumeTokens('cache_purge:bunny_budget', 2 - burstLeft, 2, 1, 60_000);
		await new CachePurgeQueue(kvClient).addUrls([`${MEDIA}/attachments/1/2/a.png`]);
		const tagRequests = recordBunnyTagPurges(() => new HttpResponse('{"Message":"Unauthorized"}', {status: 401}));
		const logs = captureLogs();

		await processCachePurgeQueue({}, HELPERS);

		expect(tagRequests).toHaveLength(burstLeft);
		expect(logs.length).toBeGreaterThan(0);
		expect(inspect(logs, {depth: 20})).not.toContain(API_KEY);
	});
});

describe('Bunny cache purge of a deleted attachment', () => {
	const HELPERS = {logger: new NoopLogger()} as unknown as WorkerTaskHelpers;
	let previousCachePurge: APICachePurgeConfig;
	let previousMedia: string;

	afterEach(() => {
		Config.cachePurge.adapter = previousCachePurge.adapter;
		Config.cachePurge.bunny = previousCachePurge.bunny;
		Config.endpoints.media = previousMedia;
		clearWorkerDependencies();
	});

	it('purges the exact URL a client requests for a Turkish file name', async () => {
		previousCachePurge = {...Config.cachePurge};
		previousMedia = Config.endpoints.media;
		Config.endpoints.media = MEDIA;
		Config.cachePurge.adapter = 'bunny';
		Config.cachePurge.bunny = bunnyConfig().bunny;
		const kvClient = new MockKVProvider();
		setWorkerDependenciesForTest({kvClient});
		// The API hands out the raw file name (makeAttachmentCdnUrl); a browser percent-encodes it with the
		// WHATWG URL parser before the request reaches Bunny, so that serialization is the one the cache holds.
		const cdnUrl = `${MEDIA}/attachments/1/2/Ekran_görüntüsü_çşğıİöü_2026.png`;
		await new CachePurgeQueue(kvClient).addUrls([cdnUrl]);
		const requests = recordBunnyPurges(() => new HttpResponse(null, {status: 200}));

		await processCachePurgeQueue({}, HELPERS);

		const clientRequestedPrefix = `${new URL(cdnUrl).href.replace(/\.png$/u, '')}*`;
		expect(clientRequestedPrefix).toContain('%C3%B6');
		expect(requests.map((request) => request.url)).toContain(clientRequestedPrefix);
	});
});

describe('Bunny cache purge configuration', () => {
	async function loadWithEnv(env: Record<string, string>) {
		vi.unstubAllEnvs();
		for (const [key, value] of Object.entries(env)) {
			vi.stubEnv(key, value);
		}
		resetConfig();
		return loadConfig();
	}

	afterEach(() => {
		vi.unstubAllEnvs();
		resetConfig();
	});

	afterAll(async () => {
		await loadConfig();
	});

	it('requires an account key when the adapter is bunny', async () => {
		await expect(loadWithEnv({FLUXER_CACHE_PURGE_ADAPTER: 'bunny'})).rejects.toThrow(
			'FLUXER_CACHE_PURGE_BUNNY_API_KEY is required',
		);
	});

	it('defaults to the public Bunny API and carries the settings into the API config', async () => {
		const master = await loadWithEnv({FLUXER_CACHE_PURGE_ADAPTER: 'bunny', FLUXER_CACHE_PURGE_BUNNY_API_KEY: API_KEY});

		expect(buildAPIConfigFromMaster(master).cachePurge.bunny).toEqual({
			apiBase: 'https://api.bunny.net',
			apiKey: API_KEY,
			timeoutMs: 10_000,
			concurrency: 8,
			mode: 'prefix',
			pullZoneId: 0,
			ratePerMinute: 30,
			burst: 20,
		});
	});

	it('reads every Bunny setting from the environment', async () => {
		const master = await loadWithEnv({
			FLUXER_CACHE_PURGE_ADAPTER: 'bunny',
			FLUXER_CACHE_PURGE_BUNNY_API_BASE: 'https://bunny-proxy.internal',
			FLUXER_CACHE_PURGE_BUNNY_API_KEY: API_KEY,
			FLUXER_CACHE_PURGE_BUNNY_TIMEOUT_MS: '5000',
			FLUXER_CACHE_PURGE_BUNNY_CONCURRENCY: '16',
			FLUXER_CACHE_PURGE_BUNNY_MODE: 'tag',
			FLUXER_CACHE_PURGE_BUNNY_PULL_ZONE_ID: '4242',
			FLUXER_CACHE_PURGE_BUNNY_RATE_PER_MINUTE: '300',
			FLUXER_CACHE_PURGE_BUNNY_BURST: '120',
		});

		expect(buildAPIConfigFromMaster(master).cachePurge).toMatchObject({
			adapter: 'bunny',
			bunny: {
				apiBase: 'https://bunny-proxy.internal',
				apiKey: API_KEY,
				timeoutMs: 5000,
				concurrency: 16,
				mode: 'tag',
				pullZoneId: 4242,
				ratePerMinute: 300,
				burst: 120,
			},
		});
	});

	it('requires a known purge mode and a pull zone id for tag purges', async () => {
		const base = {FLUXER_CACHE_PURGE_ADAPTER: 'bunny', FLUXER_CACHE_PURGE_BUNNY_API_KEY: API_KEY};
		await expect(loadWithEnv({...base, FLUXER_CACHE_PURGE_BUNNY_MODE: 'exact'})).rejects.toThrow(
			'FLUXER_CACHE_PURGE_BUNNY_MODE',
		);
		const zones: Array<Record<string, string>> = [
			{},
			{FLUXER_CACHE_PURGE_BUNNY_PULL_ZONE_ID: '0'},
			{FLUXER_CACHE_PURGE_BUNNY_PULL_ZONE_ID: '-3'},
		];
		for (const zone of zones) {
			await expect(loadWithEnv({...base, ...zone, FLUXER_CACHE_PURGE_BUNNY_MODE: 'tag'})).rejects.toThrow(
				'FLUXER_CACHE_PURGE_BUNNY_PULL_ZONE_ID must be a positive integer when FLUXER_CACHE_PURGE_BUNNY_MODE is tag',
			);
		}
	});

	it('rejects a purge rate outside 1 to 60000 per minute and a burst outside 2 to 10000', async () => {
		const base = {FLUXER_CACHE_PURGE_ADAPTER: 'bunny', FLUXER_CACHE_PURGE_BUNNY_API_KEY: API_KEY};
		for (const rate of ['0', '60001']) {
			await expect(loadWithEnv({...base, FLUXER_CACHE_PURGE_BUNNY_RATE_PER_MINUTE: rate})).rejects.toThrow(
				'FLUXER_CACHE_PURGE_BUNNY_RATE_PER_MINUTE must be an integer between 1 and 60000',
			);
		}
		for (const burst of ['1', '10001']) {
			await expect(loadWithEnv({...base, FLUXER_CACHE_PURGE_BUNNY_BURST: burst})).rejects.toThrow(
				'FLUXER_CACHE_PURGE_BUNNY_BURST must be an integer between 2 and 10000',
			);
		}
	});

	it('rejects an API base that is not an absolute http URL without credentials', async () => {
		for (const apiBase of ['api.bunny.net', 'ftp://api.bunny.net', 'https://user:pass@api.bunny.net']) {
			await expect(
				loadWithEnv({
					FLUXER_CACHE_PURGE_ADAPTER: 'bunny',
					FLUXER_CACHE_PURGE_BUNNY_API_BASE: apiBase,
					FLUXER_CACHE_PURGE_BUNNY_API_KEY: API_KEY,
				}),
			).rejects.toThrow('FLUXER_CACHE_PURGE_BUNNY_API_BASE must be an absolute http or https URL without credentials');
		}
	});

	it('rejects an account key with spaces or control characters without echoing it', async () => {
		for (const apiKey of ['bunny key', 'bunny-key\n']) {
			await expect(
				loadWithEnv({FLUXER_CACHE_PURGE_ADAPTER: 'bunny', FLUXER_CACHE_PURGE_BUNNY_API_KEY: apiKey}),
			).rejects.toThrow(/^FLUXER_CACHE_PURGE_BUNNY_API_KEY must contain only visible ASCII characters$/);
		}
	});

	it('rejects a timeout outside 1000 to 10000 and a concurrency outside 1 to 32', async () => {
		const base = {FLUXER_CACHE_PURGE_ADAPTER: 'bunny', FLUXER_CACHE_PURGE_BUNNY_API_KEY: API_KEY};
		for (const timeout of ['999', '10001']) {
			await expect(loadWithEnv({...base, FLUXER_CACHE_PURGE_BUNNY_TIMEOUT_MS: timeout})).rejects.toThrow(
				'FLUXER_CACHE_PURGE_BUNNY_TIMEOUT_MS must be an integer between 1000 and 10000',
			);
		}
		for (const concurrency of ['0', '33']) {
			await expect(loadWithEnv({...base, FLUXER_CACHE_PURGE_BUNNY_CONCURRENCY: concurrency})).rejects.toThrow(
				'FLUXER_CACHE_PURGE_BUNNY_CONCURRENCY must be an integer between 1 and 32',
			);
		}
	});

	it('leaves the Bunny settings unvalidated when another adapter is selected', async () => {
		const master = await loadWithEnv({
			FLUXER_CACHE_PURGE_BUNNY_API_BASE: 'ftp://x',
			FLUXER_CACHE_PURGE_BUNNY_TIMEOUT_MS: '1',
		});
		expect(master.integrations.cache_purge.adapter).toBe('none');
	});
});
