// SPDX-License-Identifier: AGPL-3.0-or-later

// The song library on dl.sanalyer.com: the index, the .sng downloads with progress, and a Cache Storage copy of each
// package so a song is fetched once per device. Prefetching follows the vote, so the winner is usually on disk by the
// time the band sits down.

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import {BAND_DIFFICULTIES, type BandDifficulty, type BandPart} from '@app/features/activities/band/engine/ChartModel';
import {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {BAND_PARTS} from '@app/features/activities/band/flow/BandRoomMachine';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {action, makeObservable, observable, observableRef, runInAction} from 'mobx';

export const BAND_SONG_LIBRARY_BASE_URL = 'https://dl.sanalyer.com/sarkilar/';
const INDEX_FILE = 'index.json';
const CACHE_NAME = 'band-songs-v1';
// Parsed packages kept in memory: the song being played and the next one.
const PARSED_PACKAGES_KEPT = 2;
// Charter ratings run 0..6; the vote cards draw five cells.
const INTENSITY_CELLS = 5;
const CHARTER_RATING_MAX = 6;

const logger = new Logger('BandSongLibrary');

let configuredBaseUrl = BAND_SONG_LIBRARY_BASE_URL;

// For the local harness, which serves its own songs; call before the first library is created.
export function setBandSongLibraryBaseUrl(baseUrl: string): void {
	configuredBaseUrl = baseUrl;
}

export function getBandSongLibraryBaseUrl(): string {
	return configuredBaseUrl;
}

export type BandLibraryFailure = 'unreachable' | 'http' | 'invalid' | 'unknownSong' | 'corrupt';

export class BandSongLibraryError extends Error {
	constructor(
		readonly reason: BandLibraryFailure,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'BandSongLibraryError';
	}
}

export type BandSongDownload =
	| {readonly status: 'queued'}
	| {readonly status: 'downloading'; readonly receivedBytes: number; readonly totalBytes: number}
	| {readonly status: 'cached'}
	| {readonly status: 'failed'; readonly reason: BandLibraryFailure};

export type BandLibraryStatus =
	| {readonly status: 'idle'}
	| {readonly status: 'loading'}
	| {readonly status: 'ready'}
	| {readonly status: 'failed'; readonly reason: BandLibraryFailure};

export interface BandSongLibraryOptions {
	readonly baseUrl?: string;
	readonly fetch?: typeof fetch;
	// Null turns the disk cache off (tests, or a context without Cache Storage).
	readonly cacheStorage?: CacheStorage | null;
}

function defaultCacheStorage(): CacheStorage | null {
	return typeof caches === 'undefined' ? null : caches;
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveUrl(value: unknown, base: string): string | null {
	const text = readString(value);
	if (!text) return null;
	try {
		return new URL(text, base).toString();
	} catch {
		return null;
	}
}

function readParts(value: unknown): BandSongSummary['parts'] | null {
	if (typeof value !== 'object' || value === null) return null;
	const parts: Partial<Record<BandPart, ReadonlyArray<BandDifficulty>>> = {};
	for (const part of BAND_PARTS) {
		const difficulties = (value as Record<string, unknown>)[part];
		if (!Array.isArray(difficulties)) continue;
		const charted = BAND_DIFFICULTIES.filter((difficulty) => difficulties.includes(difficulty));
		if (charted.length > 0) parts[part] = charted;
	}
	return Object.keys(parts).length > 0 ? parts : null;
}

function readIntensity(value: unknown): Partial<Record<BandPart, number>> {
	const intensity: Partial<Record<BandPart, number>> = {};
	if (typeof value !== 'object' || value === null) return intensity;
	for (const part of BAND_PARTS) {
		const rating = (value as Record<string, unknown>)[part];
		if (typeof rating === 'number' && Number.isFinite(rating) && rating >= 0) intensity[part] = rating;
	}
	return intensity;
}

export interface ParsedSongIndex {
	readonly songs: ReadonlyArray<BandSongSummary>;
	// Charter difficulty per part (song.ini diff_*, 0..6), from an optional `ratings` object on each entry.
	readonly intensity: ReadonlyMap<string, Partial<Record<BandPart, number>>>;
}

// Entries that do not describe a playable song are skipped, not fatal: one bad line must not hide the library.
export function parseSongIndex(json: unknown, indexUrl: string): ParsedSongIndex {
	const entries = (json as {songs?: unknown} | null)?.songs;
	if (!Array.isArray(entries)) throw new BandSongLibraryError('invalid', 'Song index has no songs array');
	const songs: Array<BandSongSummary> = [];
	const intensity = new Map<string, Partial<Record<BandPart, number>>>();
	for (const entry of entries) {
		if (typeof entry !== 'object' || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const id = readString(record.id);
		const name = readString(record.name);
		const packageUrl = resolveUrl(record.packageUrl, indexUrl);
		const parts = readParts(record.parts);
		const lengthMs = typeof record.lengthMs === 'number' && record.lengthMs > 0 ? record.lengthMs : null;
		if (!id || !name || !packageUrl || !parts || lengthMs === null || intensity.has(id)) continue;
		songs.push({
			id,
			name,
			artist: readString(record.artist) ?? '',
			lengthMs,
			parts,
			stems: record.stems === true,
			coverUrl: resolveUrl(record.coverUrl, indexUrl),
			packageUrl,
			packageBytes: typeof record.packageBytes === 'number' && record.packageBytes > 0 ? record.packageBytes : 0,
			addedBy: readString(record.addedBy),
		});
		intensity.set(id, readIntensity(record.ratings));
	}
	return {songs, intensity};
}

// 0..5 filled cells for a charter rating; null when the part is not rated.
export function intensityCells(rating: number | undefined): number | null {
	if (rating === undefined) return null;
	return Math.max(1, Math.min(INTENSITY_CELLS, Math.round((rating / CHARTER_RATING_MAX) * INTENSITY_CELLS)));
}

export class BandSongLibrary {
	status: BandLibraryStatus = {status: 'idle'};
	songs: ReadonlyArray<BandSongSummary> = [];
	songsById: ReadonlyMap<string, BandSongSummary> = new Map();
	readonly downloads = observable.map<string, BandSongDownload>();
	private intensity: ReadonlyMap<string, Partial<Record<BandPart, number>>> = new Map();

	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly cacheStorage: CacheStorage | null;
	private cachePromise: Promise<Cache | null> | null = null;
	private loading: Promise<void> | null = null;
	private readonly bytesInFlight = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
	private readonly packages = new Map<string, Promise<SongPackage>>();
	private prefetchQueue: ReadonlyArray<string> = [];
	private prefetching = false;

	constructor({baseUrl = configuredBaseUrl, fetch: fetchFn, cacheStorage}: BandSongLibraryOptions = {}) {
		this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
		this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
		this.cacheStorage = cacheStorage === undefined ? defaultCacheStorage() : cacheStorage;
		makeObservable<BandSongLibrary, 'intensity' | 'setDownload' | 'clearDownload'>(this, {
			status: observableRef,
			songs: observableRef,
			songsById: observableRef,
			intensity: observableRef,
			setDownload: action,
			clearDownload: action,
		});
	}

	get indexUrl(): string {
		return new URL(INDEX_FILE, this.baseUrl).toString();
	}

	song(songId: string): BandSongSummary | undefined {
		return this.songsById.get(songId);
	}

	download(songId: string): BandSongDownload | undefined {
		return this.downloads.get(songId);
	}

	partIntensity(songId: string, part: BandPart): number | null {
		return intensityCells(this.intensity.get(songId)?.[part]);
	}

	// Safe to call repeatedly; a failed load is retried, a finished one is kept.
	load(): Promise<void> {
		if (this.status.status === 'ready') return Promise.resolve();
		if (this.loading) return this.loading;
		runInAction(() => {
			this.status = {status: 'loading'};
		});
		this.loading = this.fetchIndex()
			.then(({songs, intensity}) => {
				runInAction(() => {
					this.songs = songs;
					this.songsById = new Map(songs.map((song) => [song.id, song]));
					this.intensity = intensity;
					this.status = {status: 'ready'};
				});
			})
			.catch((error: unknown) => {
				const reason = error instanceof BandSongLibraryError ? error.reason : 'unreachable';
				logger.warn('Song index could not be loaded', {url: this.indexUrl, reason, error});
				runInAction(() => {
					this.status = {status: 'failed', reason};
				});
			})
			.finally(() => {
				this.loading = null;
			});
		return this.loading;
	}

	// The parsed package, from memory, disk or the network in that order.
	ensure(songId: string): Promise<SongPackage> {
		const known = this.packages.get(songId);
		if (known) {
			this.packages.delete(songId);
			this.packages.set(songId, known);
			return known;
		}
		const song = this.song(songId);
		if (!song) return Promise.reject(new BandSongLibraryError('unknownSong', `Song ${songId} is not in the library`));
		const parsed = this.fetchBytes(song).then((bytes) => this.parse(song, bytes));
		this.packages.set(songId, parsed);
		parsed.catch(() => {
			if (this.packages.get(songId) === parsed) this.packages.delete(songId);
		});
		while (this.packages.size > PARSED_PACKAGES_KEPT) {
			const oldest = this.packages.keys().next().value;
			if (oldest === undefined) break;
			this.packages.delete(oldest);
		}
		return parsed;
	}

	// Downloads these songs to disk one at a time, in this order; a new call replaces the waiting list.
	prefetch(songIds: ReadonlyArray<string>): void {
		if (!this.cacheStorage) return;
		const wanted = songIds.filter((songId) => this.songsById.has(songId));
		for (const songId of this.prefetchQueue) {
			if (!wanted.includes(songId) && this.download(songId)?.status === 'queued') this.clearDownload(songId);
		}
		this.prefetchQueue = wanted;
		for (const songId of wanted) if (!this.downloads.has(songId)) this.setDownload(songId, {status: 'queued'});
		void this.runPrefetch();
	}

	private async runPrefetch(): Promise<void> {
		if (this.prefetching) return;
		this.prefetching = true;
		try {
			for (;;) {
				const songId = this.prefetchQueue.find((candidate) => {
					const status = this.download(candidate)?.status;
					return status === undefined || status === 'queued';
				});
				const song = songId ? this.song(songId) : undefined;
				if (!song) return;
				await this.prefetchOne(song);
			}
		} finally {
			this.prefetching = false;
		}
	}

	private async prefetchOne(song: BandSongSummary): Promise<void> {
		try {
			const cache = await this.openCache();
			if (cache && (await cache.match(song.packageUrl))) {
				this.setDownload(song.id, {status: 'cached'});
				return;
			}
			await this.fetchBytes(song);
		} catch {
			// fetchBytes records the failure for the card; a prefetch failure is retried by ensure.
		}
	}

	private fetchBytes(song: BandSongSummary): Promise<Uint8Array<ArrayBuffer>> {
		const inFlight = this.bytesInFlight.get(song.id);
		if (inFlight) return inFlight;
		const promise = this.readOrDownload(song).finally(() => this.bytesInFlight.delete(song.id));
		this.bytesInFlight.set(song.id, promise);
		return promise;
	}

	private async readOrDownload(song: BandSongSummary): Promise<Uint8Array<ArrayBuffer>> {
		const cache = await this.openCache();
		const cached = cache ? await cache.match(song.packageUrl).catch(() => undefined) : undefined;
		if (cached) {
			this.setDownload(song.id, {status: 'cached'});
			return new Uint8Array(await cached.arrayBuffer());
		}
		try {
			const bytes = await this.downloadPackage(song);
			if (cache) {
				await cache
					.put(song.packageUrl, new Response(bytes, {headers: {'Content-Type': 'application/octet-stream'}}))
					.catch((error: unknown) => logger.warn('Song could not be cached', {songId: song.id, error}));
			}
			this.setDownload(song.id, {status: 'cached'});
			return bytes;
		} catch (error) {
			const reason = error instanceof BandSongLibraryError ? error.reason : 'unreachable';
			this.setDownload(song.id, {status: 'failed', reason});
			throw error;
		}
	}

	private async downloadPackage(song: BandSongSummary): Promise<Uint8Array<ArrayBuffer>> {
		let response: Response;
		try {
			response = await this.fetchFn(song.packageUrl);
		} catch (error) {
			throw new BandSongLibraryError('unreachable', `Song ${song.id} could not be fetched`, {cause: error});
		}
		if (!response.ok) throw new BandSongLibraryError('http', `Song ${song.id} answered ${response.status}`);
		const totalBytes = Number(response.headers.get('Content-Length')) || song.packageBytes;
		this.setDownload(song.id, {status: 'downloading', receivedBytes: 0, totalBytes});
		if (!response.body) return new Uint8Array(await response.arrayBuffer());

		const reader = response.body.getReader();
		const chunks: Array<Uint8Array> = [];
		let receivedBytes = 0;
		let reportedPercent = 0;
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			chunks.push(value);
			receivedBytes += value.length;
			const percent = totalBytes > 0 ? Math.floor((receivedBytes / totalBytes) * 100) : 0;
			if (percent !== reportedPercent) {
				reportedPercent = percent;
				this.setDownload(song.id, {status: 'downloading', receivedBytes, totalBytes});
			}
		}
		const bytes = new Uint8Array(receivedBytes);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	}

	// A package that does not parse is evicted, so the next try downloads it again instead of failing from disk.
	private async parse(song: BandSongSummary, bytes: Uint8Array): Promise<SongPackage> {
		try {
			const songPackage = SongPackage.fromSng(bytes);
			const fromIndex = this.intensity.get(song.id);
			const fromPackage = readIntensity(songPackage.metadata.ratings);
			if ((!fromIndex || Object.keys(fromIndex).length === 0) && Object.keys(fromPackage).length > 0) {
				runInAction(() => {
					this.intensity = new Map(this.intensity).set(song.id, fromPackage);
				});
			}
			return songPackage;
		} catch (error) {
			logger.warn('Song package could not be read', {songId: song.id, error});
			const cache = await this.openCache();
			await cache?.delete(song.packageUrl).catch(() => false);
			this.setDownload(song.id, {status: 'failed', reason: 'corrupt'});
			throw new BandSongLibraryError('corrupt', `Song ${song.id} could not be read`, {cause: error});
		}
	}

	private openCache(): Promise<Cache | null> {
		if (!this.cacheStorage) return Promise.resolve(null);
		this.cachePromise ??= this.cacheStorage.open(CACHE_NAME).catch((error: unknown) => {
			logger.warn('Cache Storage is not available', {error});
			return null;
		});
		return this.cachePromise;
	}

	private setDownload(songId: string, download: BandSongDownload): void {
		this.downloads.set(songId, download);
	}

	private clearDownload(songId: string): void {
		this.downloads.delete(songId);
	}

	private async fetchIndex(): Promise<ParsedSongIndex> {
		let response: Response;
		try {
			response = await this.fetchFn(this.indexUrl, {cache: 'no-cache'});
		} catch (error) {
			throw new BandSongLibraryError('unreachable', 'Song index could not be fetched', {cause: error});
		}
		if (!response.ok) throw new BandSongLibraryError('http', `Song index answered ${response.status}`);
		let json: unknown;
		try {
			json = await response.json();
		} catch (error) {
			throw new BandSongLibraryError('invalid', 'Song index is not JSON', {cause: error});
		}
		return parseSongIndex(json, this.indexUrl);
	}
}
