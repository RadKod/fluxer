// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildMidi, buildSng, EXPERT_NOTE_BASE} from '@app/features/activities/band/engine/BandTestFixtures';
import {
	BandSongLibrary,
	BandSongLibraryError,
	parseSongIndex,
	ratingTier,
	readYear,
} from '@app/features/activities/band/flow/BandSongLibrary';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));

const BASE = 'https://songs.example/sarkilar/';
const INDEX_URL = `${BASE}index.json`;

const SNG = buildSng({name: 'Song A', diff_guitar: '6'}, [
	{
		fileName: 'notes.mid',
		data: buildMidi({tracks: [{name: 'PART GUITAR', notes: [{tick: 0, note: EXPERT_NOTE_BASE}]}]}),
	},
	{fileName: 'song.opus', data: new Uint8Array([1, 2, 3])},
]);

function entry(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		name: `Song ${id}`,
		artist: 'Artist',
		lengthMs: 120_000,
		parts: {guitar: ['easy', 'expert'], drums: ['hard']},
		stems: true,
		coverUrl: `covers/${id}.jpg`,
		packageUrl: `${id}.sng`,
		packageBytes: SNG.length,
		addedBy: null,
		...overrides,
	};
}

class MemoryCache {
	readonly entries = new Map<string, Uint8Array>();
	readonly put = vi.fn(async (url: string, response: Response) => {
		this.entries.set(url, new Uint8Array(await response.arrayBuffer()));
	});
	readonly match = vi.fn(async (url: string) => {
		const bytes = this.entries.get(url);
		return bytes ? new Response(bytes.slice()) : undefined;
	});
	readonly delete = vi.fn(async (url: string) => this.entries.delete(url));
	readonly keys = vi.fn(async () => [...this.entries.keys()].map((url) => new Request(url)));
}

function cacheStorage(cache = new MemoryCache()): {storage: CacheStorage; cache: MemoryCache} {
	return {storage: {open: vi.fn(async () => cache)} as unknown as CacheStorage, cache};
}

// A body that arrives in a few chunks, so progress has steps to report.
function chunkedResponse(bytes: Uint8Array, chunks = 4): Response {
	const size = Math.ceil(bytes.length / chunks);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let offset = 0; offset < bytes.length; offset += size)
				controller.enqueue(bytes.slice(offset, offset + size));
			controller.close();
		},
	});
	return new Response(stream, {headers: {'Content-Length': String(bytes.length)}});
}

function server(routes: Record<string, () => Response | Promise<Response>>) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const route = routes[url];
		if (!route) return new Response('missing', {status: 404});
		return route();
	});
}

const INDEX = {songs: [entry('a', {ratings: {guitar: 6, drums: 3}}), entry('b'), entry('c')]};

function library(fetchMock: ReturnType<typeof server>, storage: CacheStorage | null = null) {
	return new BandSongLibrary({baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch, cacheStorage: storage});
}

const SNG_ROUTES = {
	[`${BASE}a.sng`]: () => chunkedResponse(SNG),
	[`${BASE}b.sng`]: () => chunkedResponse(SNG),
	[`${BASE}c.sng`]: () => chunkedResponse(SNG),
};

describe('parseSongIndex', () => {
	it('resolves relative urls against the index and keeps charted parts only', () => {
		const {songs} = parseSongIndex(
			{songs: [entry('a', {parts: {guitar: ['expert', 'easy', 'impossible'], bass: [], keys: 'yes'}})]},
			INDEX_URL,
		);
		expect(songs).toEqual([
			{
				id: 'a',
				name: 'Song a',
				artist: 'Artist',
				lengthMs: 120_000,
				parts: {guitar: ['easy', 'expert']},
				stems: true,
				coverUrl: `${BASE}covers/a.jpg`,
				packageUrl: `${BASE}a.sng`,
				packageBytes: SNG.length,
				addedBy: null,
				groups: [],
				genre: null,
				year: null,
				previewStartMs: null,
				key: null,
			},
		]);
	});

	it('reads the genre shelves, genre, year and preview start of newer indexes', () => {
		const {songs} = parseSongIndex(
			{
				songs: [
					entry('a', {
						groups: ['metal', 'turkce', 'polka', 7],
						genre: 'Heavy Metal',
						year: '1969 (October 6)',
						previewStartMs: 151_996,
					}),
					entry('b', {groups: 'rock', genre: '', year: null, previewStartMs: -5}),
				],
			},
			INDEX_URL,
		);
		expect(songs.map(({groups, genre, year, previewStartMs}) => ({groups, genre, year, previewStartMs}))).toEqual([
			{groups: ['turkce', 'metal'], genre: 'Heavy Metal', year: 1969, previewStartMs: 151_996},
			{groups: [], genre: null, year: null, previewStartMs: null},
		]);
	});

	it('reads the song key for freestyle solos, tolerating older and malformed entries', () => {
		const {songs} = parseSongIndex(
			{
				songs: [
					entry('a', {
						key: {
							tonic: 'Ab',
							mode: 'major',
							scale: 'major-pentatonic',
							tuningCents: 13,
							lowConfidence: false,
							solos: [
								{startMs: 112_938, endMs: 133_825, tonic: 'F', mode: 'minor', scale: 'blues'},
								{startMs: 5, endMs: 1, tonic: 'F', mode: 'minor', scale: 'blues'},
								{startMs: 0, endMs: 10, tonic: 'H', mode: 'minor', scale: 'blues'},
							],
						},
					}),
					entry('b', {
						key: {tonic: 'D', mode: 'minor', scale: 'minor-pentatonic', lowConfidence: true, tuningCents: 900},
					}),
					entry('c', {key: {tonic: 'D', mode: 'dorian', scale: 'minor-pentatonic'}}),
					entry('d'),
				],
			},
			INDEX_URL,
		);
		expect(songs.map((song) => song.key)).toEqual([
			{
				tonic: 'Ab',
				mode: 'major',
				scale: 'major-pentatonic',
				tuningCents: 13,
				lowConfidence: false,
				solos: [{startMs: 112_938, endMs: 133_825, tonic: 'F', mode: 'minor', scale: 'blues'}],
			},
			{tonic: 'D', mode: 'minor', scale: 'minor-pentatonic', tuningCents: 100, lowConfidence: true, solos: []},
			null,
			null,
		]);
	});

	it('skips entries it cannot play and duplicate ids', () => {
		const {songs} = parseSongIndex(
			{
				songs: [
					entry('a'),
					entry('a', {name: 'Again'}),
					entry('b', {packageUrl: undefined}),
					entry('c', {parts: {}}),
					entry('d', {lengthMs: 0}),
					null,
					'e',
					entry('f', {coverUrl: null, artist: 7}),
				],
			},
			INDEX_URL,
		);
		expect(songs.map((song) => song.id)).toEqual(['a', 'f']);
		expect(songs[1]).toMatchObject({coverUrl: null, artist: ''});
	});

	it('rejects an index without a songs array', () => {
		expect(() => parseSongIndex({tracks: []}, INDEX_URL)).toThrow(BandSongLibraryError);
	});
});

describe('ratingTier', () => {
	it('keeps charter ratings on the seven 0..6 tiers', () => {
		expect(ratingTier(undefined)).toBeNull();
		expect(ratingTier(0)).toBe(0);
		expect(ratingTier(2.6)).toBe(3);
		expect(ratingTier(6)).toBe(6);
		expect(ratingTier(9)).toBe(6);
	});
});

describe('readYear', () => {
	it('reads the leading four digit year of the index text', () => {
		expect(readYear('1986')).toBe(1986);
		expect(readYear('1969 (October 6)')).toBe(1969);
		expect(readYear('1969-10-06')).toBe(1969);
		expect(readYear(2004)).toBe(2004);
		expect(readYear('19690')).toBeNull();
		expect(readYear('Unknown')).toBeNull();
		expect(readYear(null)).toBeNull();
		expect(readYear(undefined)).toBeNull();
	});
});

describe('BandSongLibrary.load', () => {
	it('loads the index from the base url', async () => {
		const fetchMock = server({[INDEX_URL]: () => Response.json(INDEX)});
		const songs = library(fetchMock);
		await songs.load();
		expect(fetchMock).toHaveBeenCalledWith(INDEX_URL, {cache: 'no-cache'});
		expect(songs.status).toEqual({status: 'ready'});
		expect(songs.songs.map((song) => song.id)).toEqual(['a', 'b', 'c']);
		expect(songs.song('b')?.packageUrl).toBe(`${BASE}b.sng`);
		expect(songs.partTier('a', 'guitar')).toBe(6);
		expect(songs.partTier('b', 'guitar')).toBeNull();
		await songs.load();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('reports an unreachable index (CORS or offline) and loads on retry', async () => {
		let online = false;
		const fetchMock = vi.fn(async () => {
			if (!online) throw new TypeError('Failed to fetch');
			return Response.json(INDEX);
		});
		const songs = new BandSongLibrary({baseUrl: BASE, fetch: fetchMock, cacheStorage: null});
		await songs.load();
		expect(songs.status).toEqual({status: 'failed', reason: 'unreachable'});
		online = true;
		await songs.load();
		expect(songs.status).toEqual({status: 'ready'});
	});

	it('tells an http error and a broken index apart', async () => {
		const missing = library(server({}));
		await missing.load();
		expect(missing.status).toEqual({status: 'failed', reason: 'http'});
		const broken = library(server({[INDEX_URL]: () => new Response('<html>')}));
		await broken.load();
		expect(broken.status).toEqual({status: 'failed', reason: 'invalid'});
	});

	it('shares one request between concurrent loads', async () => {
		const fetchMock = server({[INDEX_URL]: () => Response.json(INDEX)});
		const songs = library(fetchMock);
		await Promise.all([songs.load(), songs.load()]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('BandSongLibrary.ensure', () => {
	async function loaded(
		storage: CacheStorage | null = null,
		routes: Record<string, () => Response | Promise<Response>> = SNG_ROUTES,
	) {
		const fetchMock = server({[INDEX_URL]: () => Response.json(INDEX), ...routes});
		const songs = library(fetchMock, storage);
		await songs.load();
		return {songs, fetchMock};
	}

	it('downloads with progress, parses and caches under the package url', async () => {
		const {storage, cache} = cacheStorage();
		const {songs} = await loaded(storage);
		const songPackage = await songs.ensure('a');
		expect(songPackage.metadata.name).toBe('Song A');
		expect(songs.download('a')).toEqual({status: 'cached'});
		expect(cache.put).toHaveBeenCalledWith(`${BASE}a.sng`, expect.any(Response));
		expect(cache.entries.get(`${BASE}a.sng`)).toEqual(SNG);
	});

	it('reports byte progress while downloading', async () => {
		const {songs} = await loaded();
		const progress: Array<number> = [];
		const original = songs.downloads.set.bind(songs.downloads);
		vi.spyOn(songs.downloads, 'set').mockImplementation((key, value) => {
			if (value.status === 'downloading') progress.push(value.receivedBytes);
			return original(key, value);
		});
		await songs.ensure('a');
		expect(progress[0]).toBe(0);
		expect(progress.at(-1)).toBe(SNG.length);
		expect(progress.length).toBeGreaterThan(2);
	});

	it('reads a cached package without the network', async () => {
		const {storage, cache} = cacheStorage();
		cache.entries.set(`${BASE}a.sng`, SNG);
		const {songs, fetchMock} = await loaded(storage);
		await songs.ensure('a');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(songs.download('a')).toEqual({status: 'cached'});
	});

	it('returns the same package to concurrent and later callers', async () => {
		const {songs, fetchMock} = await loaded();
		const [first, second] = await Promise.all([songs.ensure('a'), songs.ensure('a')]);
		expect(first).toBe(second);
		expect(await songs.ensure('a')).toBe(first);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('keeps only the two most recent packages in memory', async () => {
		const {songs, fetchMock} = await loaded();
		await songs.ensure('a');
		await songs.ensure('b');
		await songs.ensure('a');
		await songs.ensure('c');
		await songs.ensure('a');
		expect(fetchMock).toHaveBeenCalledTimes(4);
		await songs.ensure('b');
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it('rejects a song outside the library', async () => {
		const {songs} = await loaded();
		await expect(songs.ensure('zzz')).rejects.toMatchObject({reason: 'unknownSong'});
	});

	it('marks a failed download and retries it next time', async () => {
		let up = false;
		const {songs} = await loaded(null, {
			[`${BASE}a.sng`]: () => (up ? chunkedResponse(SNG) : new Response('nope', {status: 503})),
		});
		await expect(songs.ensure('a')).rejects.toMatchObject({reason: 'http'});
		expect(songs.download('a')).toEqual({status: 'failed', reason: 'http'});
		up = true;
		await expect(songs.ensure('a')).resolves.toBeDefined();
	});

	it('evicts a package that does not parse', async () => {
		const {storage, cache} = cacheStorage();
		cache.entries.set(`${BASE}a.sng`, new Uint8Array([1, 2, 3]));
		const {songs} = await loaded(storage);
		await expect(songs.ensure('a')).rejects.toMatchObject({reason: 'corrupt'});
		expect(cache.delete).toHaveBeenCalledWith(`${BASE}a.sng`);
		expect(songs.download('a')).toEqual({status: 'failed', reason: 'corrupt'});
	});

	it('fills intensity from the package when the index has none', async () => {
		const {songs} = await loaded();
		expect(songs.partTier('b', 'guitar')).toBeNull();
		await songs.ensure('b');
		expect(songs.partTier('b', 'guitar')).toBe(6);
	});

	it('still plays when Cache Storage cannot open', async () => {
		const storage = {open: vi.fn(async () => Promise.reject(new Error('SecurityError')))} as unknown as CacheStorage;
		const {songs} = await loaded(storage);
		await expect(songs.ensure('a')).resolves.toBeDefined();
	});
});

describe('BandSongLibrary previews', () => {
	async function loadedWith(cache: MemoryCache) {
		const fetchMock = server({[INDEX_URL]: () => Response.json(INDEX), ...SNG_ROUTES});
		const songs = library(fetchMock, cacheStorage(cache).storage);
		await songs.load();
		await vi.waitFor(() => expect(cache.keys).toHaveBeenCalled());
		return {songs, fetchMock};
	}

	it('knows which songs an earlier day left on this device', async () => {
		const cache = new MemoryCache();
		cache.entries.set(`${BASE}b.sng`, SNG);
		const {songs} = await loadedWith(cache);
		await vi.waitFor(() => expect(songs.isOnDevice('b')).toBe(true));
		expect(songs.isOnDevice('a')).toBe(false);
		expect(songs.isOnDevice('missing')).toBe(false);
	});

	it('opens a stored package without the network and never downloads one', async () => {
		const cache = new MemoryCache();
		cache.entries.set(`${BASE}b.sng`, SNG);
		const {songs, fetchMock} = await loadedWith(cache);
		await expect(songs.openStored('b')).resolves.not.toBeNull();
		await expect(songs.openStored('a')).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(songs.download('a')).toBeUndefined();
	});

	it('counts a song downloaded in this session as on the device', async () => {
		const cache = new MemoryCache();
		const {songs} = await loadedWith(cache);
		expect(songs.isOnDevice('a')).toBe(false);
		await songs.ensure('a');
		expect(songs.isOnDevice('a')).toBe(true);
	});
});

describe('BandSongLibrary.prefetch', () => {
	async function settle(songs: BandSongLibrary, ids: ReadonlyArray<string>) {
		await vi.waitFor(() => {
			for (const id of ids) expect(songs.download(id)?.status).toBe('cached');
		});
	}

	it('downloads candidates to disk one at a time, in the given order', async () => {
		const {storage, cache} = cacheStorage();
		const order: Array<string> = [];
		let active = 0;
		let maxActive = 0;
		const slow = (id: string) => async () => {
			order.push(id);
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return chunkedResponse(SNG);
		};
		const fetchMock = server({
			[INDEX_URL]: () => Response.json(INDEX),
			[`${BASE}a.sng`]: slow('a'),
			[`${BASE}b.sng`]: slow('b'),
			[`${BASE}c.sng`]: slow('c'),
		});
		const songs = library(fetchMock, storage);
		await songs.load();
		songs.prefetch(['c', 'a', 'b']);
		expect(songs.download('a')).toEqual({status: 'queued'});
		await settle(songs, ['a', 'b', 'c']);
		expect(order).toEqual(['c', 'a', 'b']);
		expect(maxActive).toBe(1);
		expect(cache.entries.size).toBe(3);
	});

	it('marks songs already on disk as cached without downloading them', async () => {
		const {storage, cache} = cacheStorage();
		cache.entries.set(`${BASE}b.sng`, SNG);
		const fetchMock = server({[INDEX_URL]: () => Response.json(INDEX), ...SNG_ROUTES});
		const songs = library(fetchMock, storage);
		await songs.load();
		songs.prefetch(['b']);
		await settle(songs, ['b']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('drops waiting songs that are no longer wanted', async () => {
		const {storage} = cacheStorage();
		const fetchMock = server({[INDEX_URL]: () => Response.json(INDEX), ...SNG_ROUTES});
		const songs = library(fetchMock, storage);
		await songs.load();
		songs.prefetch(['a', 'b']);
		songs.prefetch(['a', 'c']);
		expect(songs.download('b')).toBeUndefined();
		await settle(songs, ['a', 'c']);
		expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(`${BASE}b.sng`);
	});

	it('does nothing without a disk cache', async () => {
		const fetchMock = server({[INDEX_URL]: () => Response.json(INDEX), ...SNG_ROUTES});
		const songs = library(fetchMock);
		await songs.load();
		songs.prefetch(['a']);
		expect(songs.download('a')).toBeUndefined();
	});
});
