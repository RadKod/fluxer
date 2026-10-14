// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUNNY_GUID_PATTERN, type FeedStreamSettings} from '@app/api/feed/video/FeedVideoUrls';
import * as FetchUtils from '@app/api/utils/FetchUtils';
import {z} from 'zod';

const TRAILING_SLASHES_PATTERN = /\/+$/u;
// Every storage path the feed reads: poster and thumbnails, seek sheets, MP4 fallbacks, the original (kept only until
// encoding when KeepOriginalFiles is off) and HLS playlists and segments.
const STORAGE_FILE_PATTERN =
	/^(seek\/_\d+\.jpg|thumbnail(_[1-5])?\.jpg|original|play_\d{3,4}p\.mp4|playlist\.m3u8|\d{3,4}p\/video\.m3u8|\d{3,4}p\/video\d+\.ts)$/;
const STORAGE_DIR_PATTERN = /^(seek|\d{3,4}p)$/;
const JSON_MAX_BYTES = 1024 * 1024;
// A whole-file stream (evidence copies) gets its own deadline, under the video lane's ack wait.
// TEMPORARY: one deadline for headers and body; a separate stall timer if slow Storage reads ever hit it.
const STREAM_TIMEOUT_MS = 540_000;

export interface BunnyVideo {
	guid: string;
	status: number;
	length: number;
	width: number;
	height: number;
	rotation: number | null;
	thumbnailCount: number;
	category: string | null;
	dateUploaded: string;
	originalHash: string | null;
}

export interface BunnyStorageEntry {
	name: string;
	length: number;
	isDirectory: boolean;
}

/** A failed Bunny call; status is null when no response came. The message never holds a URL, key or video id. */
export class BunnyStreamError extends Error {
	constructor(
		readonly status: number | null,
		message = status === null ? 'Bunny Stream request got no response' : `Bunny Stream answered ${status}`,
	) {
		super(message);
		this.name = 'BunnyStreamError';
	}
}

const CreatedVideoSchema = z.object({guid: z.string().regex(BUNNY_GUID_PATTERN)});
const VideoSchema = z.object({
	guid: z.string().regex(BUNNY_GUID_PATTERN),
	status: z.number().int(),
	length: z.number(),
	width: z.number(),
	height: z.number(),
	rotation: z.number().nullish(),
	thumbnailCount: z.number().int(),
	category: z.string().nullish(),
	dateUploaded: z.string(),
	originalHash: z.string().nullish(),
});
const StorageListSchema = z.array(z.object({ObjectName: z.string(), Length: z.number(), IsDirectory: z.boolean()}));

function assertGuid(guid: string): void {
	if (!BUNNY_GUID_PATTERN.test(guid)) throw new Error('Refusing a Bunny request with a malformed video id');
}

function assertFile(path: string): void {
	if (!STORAGE_FILE_PATTERN.test(path)) throw new Error('Refusing a Bunny Storage request with a malformed path');
}

/**
 * Bunny Stream API (library key) and the library's Storage zone (read-only password). Hosts come from settings and
 * every path is built from a checked GUID and an allow-listed file name, so no caller input reaches a URL.
 */
export class BunnyStreamClient {
	private readonly apiBase: string;

	constructor(private readonly s: FeedStreamSettings) {
		this.apiBase = `${s.apiBase.replace(TRAILING_SLASHES_PATTERN, '')}/library/${s.libraryId}/videos`;
	}

	async createVideo(title: string): Promise<{guid: string}> {
		const response = await this.send(this.apiBase, {
			method: 'POST',
			headers: {AccessKey: this.s.apiKey, 'Content-Type': 'application/json', Accept: 'application/json'},
			body: JSON.stringify({title}),
		});
		const {guid} = await this.readJson(this.expectOk(response), CreatedVideoSchema);
		return {guid};
	}

	async getVideo(guid: string): Promise<BunnyVideo | null> {
		assertGuid(guid);
		const response = await this.send(`${this.apiBase}/${guid}`, {headers: this.apiHeaders()});
		if (response.status === 404) return this.gone(response);
		const video = await this.readJson(this.expectOk(response), VideoSchema);
		return {
			...video,
			rotation: video.rotation ?? null,
			category: video.category ?? null,
			originalHash: video.originalHash ?? null,
		};
	}

	/** A video that is already gone counts as deleted. */
	async deleteVideo(guid: string): Promise<void> {
		assertGuid(guid);
		const response = await this.send(`${this.apiBase}/${guid}`, {method: 'DELETE', headers: this.apiHeaders()});
		FetchUtils.discardResponseBody(response.body, response.status);
		if (response.status !== 404) this.expectOk(response);
	}

	/** The video's storage directory, or one of its sub-directories (seek sheets, an HLS resolution); null when gone. */
	async listFiles(guid: string, dir?: string): Promise<Array<BunnyStorageEntry> | null> {
		assertGuid(guid);
		const subdir = dir?.replace(/\/$/u, '');
		if (subdir !== undefined && !STORAGE_DIR_PATTERN.test(subdir)) {
			throw new Error('Refusing a Bunny Storage listing of a malformed directory');
		}
		const response = await this.send(this.storageUrl(guid, subdir === undefined ? '' : `${subdir}/`), {
			headers: this.storageHeaders(),
		});
		if (response.status === 404) return this.gone(response);
		const entries = await this.readJson(this.expectOk(response), StorageListSchema);
		return entries.map((entry) => ({name: entry.ObjectName, length: entry.Length, isDirectory: entry.IsDirectory}));
	}

	/** A whole storage file of at most `maxBytes` (a larger one throws); null when it does not exist. */
	async readFile(guid: string, path: string, maxBytes: number): Promise<Buffer | null> {
		assertGuid(guid);
		assertFile(path);
		const response = await this.send(this.storageUrl(guid, path), {headers: this.storageHeaders()});
		if (response.status === 404) return this.gone(response);
		this.expectOk(response);
		const bytes = await FetchUtils.streamToBufferWithLimit(response.body, {
			maxBytes,
			headers: response.headers,
			description: 'Bunny Storage file',
		});
		return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	/** A storage file as a stream, for copies too large to buffer; length is -1 when Bunny sends none. */
	async streamFile(guid: string, path: string): Promise<{body: ReadableStream<Uint8Array>; length: number} | null> {
		assertGuid(guid);
		assertFile(path);
		const response = await this.send(this.storageUrl(guid, path), {headers: this.storageHeaders()}, STREAM_TIMEOUT_MS);
		if (response.status === 404) return this.gone(response);
		this.expectOk(response);
		if (!response.body) throw new BunnyStreamError(response.status, 'Bunny Storage sent no body');
		const length = Number(response.headers.get('content-length') ?? Number.NaN);
		return {body: response.body, length: Number.isSafeInteger(length) ? length : -1};
	}

	private apiHeaders(): Record<string, string> {
		return {AccessKey: this.s.apiKey, Accept: 'application/json'};
	}

	private storageHeaders(): Record<string, string> {
		return {AccessKey: this.s.storagePassword};
	}

	private storageUrl(guid: string, path: string): string {
		return `https://${this.s.storageHost}/${this.s.storageZone}/${guid}/${path}`;
	}

	// The fetch error can carry the URL, so only its name goes into the message.
	private async send(url: string, init: RequestInit, timeoutMs = this.s.timeoutMs): Promise<Response> {
		try {
			return await fetch(url, {...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)});
		} catch (error) {
			throw new BunnyStreamError(null, `Bunny Stream request got no response (${(error as Error).name})`);
		}
	}

	private expectOk(response: Response): Response {
		if (response.ok) return response;
		FetchUtils.discardResponseBody(response.body, response.status);
		throw new BunnyStreamError(response.status);
	}

	private gone(response: Response): null {
		FetchUtils.discardResponseBody(response.body, response.status);
		return null;
	}

	private async readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
		try {
			const text = await FetchUtils.streamToStringWithLimit(response.body, {
				maxBytes: JSON_MAX_BYTES,
				headers: response.headers,
				description: 'Bunny Stream response',
			});
			const parsed = schema.safeParse(JSON.parse(text));
			if (parsed.success) return parsed.data;
		} catch {
			// Falls through to the one error below, which never echoes the body.
		}
		throw new BunnyStreamError(response.status, `Bunny Stream sent an unexpected response (${response.status})`);
	}
}
