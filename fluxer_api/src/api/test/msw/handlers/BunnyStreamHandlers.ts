// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomBytes, randomUUID} from 'node:crypto';
import type {FeedStreamSettings} from '@app/api/feed/video/FeedVideoUrls';
import {HttpResponse, http, type RequestHandler} from 'msw';
import sharp from 'sharp';

// Test-only hosts (.test never resolves), so a request that slips past MSW cannot reach Bunny.
export const BUNNY_TEST_SETTINGS: FeedStreamSettings = {
	enabled: true,
	libraryId: 4242,
	apiKey: 'bunny-test-library-key',
	readOnlyApiKey: 'bunny-test-read-only-key',
	cdnHostname: 'vz-test.b-cdn.test',
	tokenKey: 'bunny-test-token-key',
	apiBase: 'https://video.bunny.test',
	tusEndpoint: 'https://video.bunny.test/tusupload',
	timeoutMs: 5000,
	storageHost: 'storage.bunny.test',
	storageZone: 'vz-test-zone',
	storagePassword: 'bunny-test-storage-read-only',
};

export interface FakeBunnyVideo {
	guid: string;
	title: string;
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

/** One request the fake answered. Storage paths are relative to the video's directory; a listing ends in '/' ('' = root). */
export interface FakeBunnyCall {
	method: string;
	service: 'api' | 'storage';
	guid: string | null;
	path: string;
	accessKey: string | null;
}

interface FakeBunnyFile {
	body: Buffer;
	length: number;
}

interface FakeBunnyFailure {
	match: (call: FakeBunnyCall) => boolean;
	status: number;
	remaining: number;
}

export interface FinishVideoOptions {
	length?: number;
	width?: number;
	height?: number;
	rotation?: number | null;
	category?: string | null;
	/** Keeps an `original` whose listed Length is this many bytes (the library deletes originals). */
	originalBytes?: number;
	mp4?: Array<string>;
	resolutions?: Array<string>;
	/** Every seek sheet at this size instead of Bunny's 6 x 6 grid of 300 px wide tiles. */
	sheet?: {width: number; height: number};
}

const SEEK_PER_SHEET = 36;
const SHEET_COLUMNS = 6;
const TILE_WIDTH = 300;
const HLS_SEGMENT_SECONDS = 4;
const THUMBNAIL_COLORS = ['#c03030', '#30c030', '#3030c0', '#c0c030', '#30c0c0', '#c030c0'];
const jpegCache = new Map<string, Promise<Buffer>>();

function jpeg(width: number, height: number, color: string): Promise<Buffer> {
	const key = `${width}x${height}:${color}`;
	let image = jpegCache.get(key);
	if (!image) {
		image = sharp({create: {width, height, channels: 3, background: color}})
			.jpeg()
			.toBuffer();
		jpegCache.set(key, image);
	}
	return image;
}

function displaySize(width: number, height: number, rotation: number | null): {width: number; height: number} {
	return Math.abs(rotation ?? 0) % 180 === 90 ? {width: height, height: width} : {width, height};
}

function variantSize(label: string, display: {width: number; height: number}): string {
	const short = Number.parseInt(label, 10);
	return display.width >= display.height
		? `${Math.round((short * display.width) / display.height)}x${short}`
		: `${short}x${Math.round((short * display.height) / display.width)}`;
}

function empty(status: number): HttpResponse<string> {
	return new HttpResponse('', {status});
}

class MswBunnyStreamServer {
	private readonly videos = new Map<string, FakeBunnyVideo>();
	private readonly storage = new Map<string, Map<string, FakeBunnyFile>>();
	private calls: Array<FakeBunnyCall> = [];
	private failures: Array<FakeBunnyFailure> = [];

	reset(): void {
		this.videos.clear();
		this.storage.clear();
		this.calls = [];
		this.failures = [];
	}

	getCalls(): Array<FakeBunnyCall> {
		return [...this.calls];
	}

	getVideo(guid: string): FakeBunnyVideo | null {
		return this.videos.get(guid) ?? null;
	}

	/** Adds a library video (status 0 unless given) without a request, and returns its GUID. */
	putVideo(video: Partial<FakeBunnyVideo> = {}): string {
		const guid = video.guid ?? randomUUID();
		this.videos.set(guid, {
			guid,
			title: '',
			status: 0,
			length: 0,
			width: 0,
			height: 0,
			rotation: 0,
			thumbnailCount: 0,
			category: 'untagged',
			dateUploaded: new Date().toISOString(),
			originalHash: null,
			...video,
		});
		return guid;
	}

	updateVideo(guid: string, patch: Partial<FakeBunnyVideo>): void {
		const video = this.videos.get(guid);
		if (!video) throw new Error(`No fake Bunny video ${guid}`);
		this.videos.set(guid, {...video, ...patch});
	}

	/**
	 * Finishes encoding: status 4, thumbnailCount = ceil(length / 2), and the storage files Bunny leaves: poster and five
	 * thumbnails, seek sheets (a 6 x 6 canvas of 300 px wide tiles, the last sheet too), MP4 fallbacks and HLS (a master
	 * playlist, a media playlist and 4 s segments per resolution).
	 */
	async finishVideo(guid: string, options: FinishVideoOptions = {}): Promise<void> {
		const length = options.length ?? 90;
		const width = options.width ?? 1080;
		const height = options.height ?? 1920;
		const rotation = options.rotation === undefined ? 0 : options.rotation;
		const thumbnailCount = Math.ceil(length / 2);
		this.updateVideo(guid, {
			status: 4,
			length,
			width,
			height,
			rotation,
			thumbnailCount,
			category: options.category === undefined ? 'other' : options.category,
			originalHash: randomBytes(32).toString('hex').toUpperCase(),
		});
		const display = displaySize(width, height, rotation);
		const files = this.files(guid);
		if (options.originalBytes === undefined) {
			files.delete('original');
		} else {
			this.setFile(guid, 'original', Buffer.from('000000186674797069736f6d00000200', 'hex'), options.originalBytes);
		}

		const posterSize = {
			width: Math.max(1, Math.round(display.width / 10)),
			height: Math.max(1, Math.round(display.height / 10)),
		};
		for (const [index, name] of [
			'thumbnail.jpg',
			'thumbnail_1.jpg',
			'thumbnail_2.jpg',
			'thumbnail_3.jpg',
			'thumbnail_4.jpg',
			'thumbnail_5.jpg',
		].entries()) {
			this.setFile(guid, name, await jpeg(posterSize.width, posterSize.height, THUMBNAIL_COLORS[index]!));
		}

		// As live Bunny serves them (27 Sep): every sheet, the last one too, is the whole 6 x 6 canvas (unused cells
		// empty), tiles 300 px wide and floor(300 · h / w) high: 1800×3198 portrait, 1800×1008 for 640×360.
		const tileHeight = Math.floor((TILE_WIDTH * display.height) / display.width);
		const size = options.sheet ?? {width: SHEET_COLUMNS * TILE_WIDTH, height: SHEET_COLUMNS * tileHeight};
		for (let sheet = 0; sheet < Math.ceil(thumbnailCount / SEEK_PER_SHEET); sheet++) {
			this.setFile(guid, `seek/_${sheet}.jpg`, await jpeg(size.width, size.height, '#808080'));
		}

		for (const name of options.mp4 ?? ['play_720p.mp4']) {
			this.setFile(guid, name, Buffer.from(`mp4:${name}`));
		}

		const resolutions = options.resolutions ?? ['720p'];
		const segments = Math.max(1, Math.ceil(length / HLS_SEGMENT_SECONDS));
		const master = ['#EXTM3U'];
		for (const resolution of resolutions) {
			master.push(
				`#EXT-X-STREAM-INF:BANDWIDTH=${Number.parseInt(resolution, 10) * 2000},RESOLUTION=${variantSize(resolution, display)}`,
				`${resolution}/video.m3u8`,
			);
			const media = [
				'#EXTM3U',
				'#EXT-X-VERSION:3',
				`#EXT-X-TARGETDURATION:${HLS_SEGMENT_SECONDS}`,
				'#EXT-X-MEDIA-SEQUENCE:0',
			];
			for (let segment = 0; segment < segments; segment++) {
				const seconds = Math.min(HLS_SEGMENT_SECONDS, length - segment * HLS_SEGMENT_SECONDS);
				media.push(`#EXTINF:${seconds.toFixed(6)},`, `video${segment}.ts`);
				// One MPEG-TS packet (sync byte 0x47) marked with its resolution and index.
				const packet = Buffer.alloc(188, segment);
				packet[0] = 0x47;
				packet.write(`${resolution}:${segment}`, 4);
				this.setFile(guid, `${resolution}/video${segment}.ts`, packet);
			}
			media.push('#EXT-X-ENDLIST');
			this.setFile(guid, `${resolution}/video.m3u8`, Buffer.from(`${media.join('\n')}\n`));
		}
		this.setFile(guid, 'playlist.m3u8', Buffer.from(`${master.join('\n')}\n`));
	}

	/** Stores a file; `length` is what the listing reports (default: the body's size). */
	setFile(guid: string, path: string, body: Buffer, length = body.length): void {
		this.files(guid).set(path, {body, length});
	}

	getFile(guid: string, path: string): Buffer | null {
		return this.storage.get(guid)?.get(path)?.body ?? null;
	}

	removeFile(guid: string, path: string): void {
		this.storage.get(guid)?.delete(path);
	}

	/** Answers the next `times` matching requests with `status` (after they are logged). */
	failWhen(match: (call: FakeBunnyCall) => boolean, status: number, times = Number.POSITIVE_INFINITY): void {
		this.failures.push({match, status, remaining: times});
	}

	createHandlers(): Array<RequestHandler> {
		const {apiBase, storageHost} = BUNNY_TEST_SETTINGS;
		return [
			http.post(`${apiBase}/library/:libraryId/videos`, async ({request, params}) => {
				const failed = this.record(request, 'api', null, '');
				if (failed) return failed;
				if (!this.libraryAllowed(request, params.libraryId)) return empty(401);
				const body = (await request.json().catch(() => null)) as {title?: unknown} | null;
				const guid = this.putVideo({title: typeof body?.title === 'string' ? body.title : ''});
				return HttpResponse.json(this.videoJson(this.videos.get(guid)!));
			}),
			http.get(`${apiBase}/library/:libraryId/videos/:guid`, ({request, params}) => {
				const guid = String(params.guid);
				const failed = this.record(request, 'api', guid, '');
				if (failed) return failed;
				if (!this.libraryAllowed(request, params.libraryId)) return empty(401);
				const video = this.videos.get(guid);
				return video ? HttpResponse.json(this.videoJson(video)) : empty(404);
			}),
			http.delete(`${apiBase}/library/:libraryId/videos/:guid`, ({request, params}) => {
				const guid = String(params.guid);
				const failed = this.record(request, 'api', guid, '');
				if (failed) return failed;
				if (!this.libraryAllowed(request, params.libraryId)) return empty(401);
				if (!this.videos.delete(guid)) return empty(404);
				this.storage.delete(guid);
				return HttpResponse.json({success: true, message: 'OK', statusCode: 200});
			}),
			http.all(`https://${storageHost}/*`, ({request}) => {
				const [, zone = '', guid = '', ...rest] = new URL(request.url).pathname.split('/');
				const path = rest.join('/');
				const failed = this.record(request, 'storage', guid, path);
				if (failed) return failed;
				if (request.method !== 'GET') return empty(405);
				if (
					zone !== BUNNY_TEST_SETTINGS.storageZone ||
					request.headers.get('AccessKey') !== BUNNY_TEST_SETTINGS.storagePassword
				) {
					return empty(401);
				}
				const files = this.storage.get(guid);
				if (!files) return empty(404);
				if (path === '' || path.endsWith('/')) return HttpResponse.json(this.listing(guid, files, path));
				const file = files.get(path);
				if (!file) return empty(404);
				return new HttpResponse(file.body, {
					status: 200,
					headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(file.body.length)},
				});
			}),
		];
	}

	private files(guid: string): Map<string, FakeBunnyFile> {
		let files = this.storage.get(guid);
		if (!files) {
			files = new Map();
			this.storage.set(guid, files);
		}
		return files;
	}

	private record(request: Request, service: FakeBunnyCall['service'], guid: string | null, path: string) {
		const call: FakeBunnyCall = {
			method: request.method,
			service,
			guid,
			path,
			accessKey: request.headers.get('AccessKey'),
		};
		this.calls.push(call);
		const failure = this.failures.find((candidate) => candidate.remaining > 0 && candidate.match(call));
		if (!failure) return null;
		failure.remaining -= 1;
		return new HttpResponse('Injected failure', {status: failure.status});
	}

	private libraryAllowed(request: Request, libraryId: unknown): boolean {
		return (
			String(libraryId) === String(BUNNY_TEST_SETTINGS.libraryId) &&
			request.headers.get('AccessKey') === BUNNY_TEST_SETTINGS.apiKey
		);
	}

	private listing(guid: string, files: Map<string, FakeBunnyFile>, dir: string) {
		const children = new Map<string, {length: number; isDirectory: boolean}>();
		for (const [path, file] of files) {
			if (!path.startsWith(dir)) continue;
			const [name = '', ...below] = path.slice(dir.length).split('/');
			children.set(name, below.length > 0 ? {length: 0, isDirectory: true} : {length: file.length, isDirectory: false});
		}
		return [...children.keys()].sort().map((name) => ({
			Guid: randomUUID(),
			StorageZoneName: BUNNY_TEST_SETTINGS.storageZone,
			Path: `/${BUNNY_TEST_SETTINGS.storageZone}/${guid}/${dir}`,
			ObjectName: name,
			Length: children.get(name)!.length,
			LastChanged: new Date().toISOString(),
			IsDirectory: children.get(name)!.isDirectory,
			DateCreated: new Date().toISOString(),
		}));
	}

	private videoJson(video: FakeBunnyVideo) {
		return {
			videoLibraryId: BUNNY_TEST_SETTINGS.libraryId,
			...video,
			views: 0,
			isPublic: false,
			framerate: 30,
			storageSize: 0,
			hasMP4Fallback: true,
			encodeProgress: video.status === 4 ? 100 : 0,
		};
	}
}

export const fakeBunnyStream = new MswBunnyStreamServer();

export function createBunnyStreamHandlers(): Array<RequestHandler> {
	return fakeBunnyStream.createHandlers();
}
