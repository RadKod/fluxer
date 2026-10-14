// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedVideoUploadResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));

// The real REST client runs over a fake XMLHttpRequest, so a header it would add on its own (the session token) shows.
const {http} = await import('@app/features/platform/transport/RestTransport');
const {uploadFeedVideo} = await import('@app/features/feed/utils/FeedVideoUpload');

const MiB = 1024 * 1024;
const SESSION_TOKEN = 'micup-session-token';
const ENDPOINT = 'https://video.bunnycdn.com/tusupload';
const UPLOAD_URL = 'https://video.bunnycdn.com/tusupload/up-1';

interface TusRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Blob | null;
	credentials?: RequestCredentials;
}

// 'slow': the PATCH is sent over 100 s with some progress every 20 s, then stored whole.
type TusReply = {status: number; headers?: Record<string, string>} | 'drop' | 'hang' | 'slow';

let requests: Array<TusRequest>;
let serverOffset: number;
let patchCount: number;
let patchReply: (request: TusRequest, index: number) => TusReply | undefined;
let createReply: TusReply;
// While false, nothing reaches the server (and navigator.onLine says so).
let online: boolean;

// A TUS server: creation answers a relative Location, HEAD the stored offset, PATCH appends at the stored offset.
function serve(request: TusRequest): TusReply {
	requests.push(request);
	if (!online) return 'drop';
	if (request.method === 'POST') return createReply;
	if (request.method === 'HEAD') return {status: 200, headers: {'Upload-Offset': String(serverOffset)}};
	const custom = patchReply(request, patchCount++);
	if (custom) return custom;
	if (Number(request.headers['Upload-Offset']) !== serverOffset) return {status: 409};
	serverOffset += request.body!.size;
	return {status: 204, headers: {'Upload-Offset': String(serverOffset)}};
}

class FakeXhr {
	status = 0;
	statusText = '';
	responseText = '';
	responseType = '';
	response: unknown = null;
	timeout = 0;
	readonly upload = new EventTarget();
	private readonly events = new EventTarget();
	private request: TusRequest = {method: '', url: '', headers: {}, body: null};
	private replyHeaders = '';
	private done = false;

	open(method: string, url: string) {
		this.request = {method, url, headers: {}, body: null};
	}
	setRequestHeader(name: string, value: string) {
		this.request.headers[name] = value;
	}
	addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions) {
		this.events.addEventListener(type, listener, options);
	}
	getAllResponseHeaders() {
		return this.replyHeaders;
	}
	abort() {
		this.finish('abort');
	}
	send(body: Blob | null) {
		this.request.body = body;
		queueMicrotask(() => {
			if (this.done) return;
			const reply = serve(this.request);
			if (reply === 'hang') return;
			if (reply === 'slow') {
				this.trickle(body!, 1);
				return;
			}
			if (reply === 'drop') {
				this.finish('error');
				return;
			}
			if (body) this.upload.dispatchEvent(Object.assign(new Event('progress'), {loaded: body.size}));
			this.status = reply.status;
			this.replyHeaders = Object.entries(reply.headers ?? {})
				.map(([name, value]) => `${name}: ${value}`)
				.join('\r\n');
			this.finish('load');
		});
	}
	private trickle(body: Blob, step: number) {
		setTimeout(() => {
			if (this.done) return;
			this.upload.dispatchEvent(Object.assign(new Event('progress'), {loaded: Math.floor((body.size * step) / 5)}));
			if (step < 5) {
				this.trickle(body, step + 1);
				return;
			}
			serverOffset += body.size;
			this.status = 204;
			this.replyHeaders = `Upload-Offset: ${serverOffset}`;
			this.finish('load');
		}, 20_000);
	}
	private finish(type: string) {
		if (this.done) return;
		this.done = true;
		this.events.dispatchEvent(new Event(type));
		this.events.dispatchEvent(new Event('loadend'));
	}
}

const fetchHead = vi.fn(async (url: string, init: RequestInit) => {
	const reply = serve({
		method: init.method ?? 'GET',
		url,
		headers: {...(init.headers as Record<string, string>)},
		body: null,
		credentials: init.credentials,
	});
	if (typeof reply === 'string') throw new TypeError('Failed to fetch');
	return new Response(null, {status: reply.status, headers: reply.headers});
});

function ticket(signature = 'sig-1', expires = 1_900_000_000): FeedVideoUploadResponse {
	return {
		id: '0b6c1f3e-6d2a-4f55-9a1e-2f8f5b1c7d90',
		library_id: '761025',
		upload: {endpoint: ENDPOINT, signature, expires},
	};
}

const clip = (size: number) => new File([new Uint8Array(size)], 'clip.mp4', {type: 'video/mp4'});
const patches = () => requests.filter((request) => request.method === 'PATCH');
const methods = () => requests.map((request) => request.method);

describe('uploadFeedVideo', () => {
	beforeEach(() => {
		requests = [];
		serverOffset = 0;
		patchCount = 0;
		patchReply = () => undefined;
		createReply = {status: 201, headers: {Location: '/tusupload/up-1'}};
		online = true;
		Object.defineProperty(navigator, 'onLine', {configurable: true, get: () => online});
		vi.useFakeTimers();
		vi.stubGlobal('XMLHttpRequest', FakeXhr);
		vi.stubGlobal('fetch', fetchHead);
		http.installAuth(() => SESSION_TOKEN);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		http.installAuth(() => null);
		delete (navigator as {onLine?: boolean}).onLine;
	});

	// Runs the upload through its backoff waits.
	async function upload(file: File, hooks: Partial<Parameters<typeof uploadFeedVideo>[2]> = {}) {
		const result = uploadFeedVideo(file, ticket(), {
			signal: new AbortController().signal,
			resign: vi.fn(async () => ticket('sig-2', 1_900_007_200)),
			...hooks,
		});
		const settled = result.then(
			() => 'ok',
			(error: unknown) => error,
		);
		await vi.runAllTimersAsync();
		return settled;
	}

	it('creates the upload with the four Bunny headers and base64 metadata', async () => {
		const file = clip(3 * MiB);
		await expect(upload(file)).resolves.toBe('ok');
		const [create] = requests;
		expect(create).toMatchObject({method: 'POST', url: ENDPOINT, body: null});
		expect(create!.headers).toEqual({
			'Tus-Resumable': '1.0.0',
			'Upload-Length': String(3 * MiB),
			'Upload-Metadata': `filetype ${btoa('video/mp4')},title ${btoa(ticket().id)}`,
			AuthorizationSignature: 'sig-1',
			AuthorizationExpire: '1900000000',
			LibraryId: '761025',
			VideoId: ticket().id,
		});
		// The relative Location is resolved against the TUS endpoint.
		expect(patches().map((request) => request.url)).toEqual([UPLOAD_URL]);
	});

	it('sends 8 MiB PATCHes from the server offset', async () => {
		// The server keeps only 5 MiB of the first PATCH; the next one starts where it says.
		patchReply = (_, index) => {
			if (index !== 0) return undefined;
			serverOffset = 5 * MiB;
			return {status: 204, headers: {'Upload-Offset': String(serverOffset)}};
		};
		const progress = vi.fn();
		await expect(upload(clip(20 * MiB), {onProgress: progress})).resolves.toBe('ok');
		expect(patches().map((request) => [request.headers['Upload-Offset'], request.body!.size])).toEqual([
			['0', 8 * MiB],
			[String(5 * MiB), 8 * MiB],
			[String(13 * MiB), 7 * MiB],
		]);
		for (const request of patches()) {
			expect(request.headers['Content-Type']).toBe('application/offset+octet-stream');
			expect(request.headers['Tus-Resumable']).toBe('1.0.0');
			expect(request.headers.AuthorizationSignature).toBe('sig-1');
		}
		expect(progress).toHaveBeenLastCalledWith(20 * MiB, 20 * MiB);
		expect(serverOffset).toBe(20 * MiB);
	});

	it('resumes from the HEAD offset after a dropped PATCH', async () => {
		// The connection drops after the server stored 3 MiB of the second PATCH.
		patchReply = (_, index) => {
			if (index !== 1) return undefined;
			serverOffset += 3 * MiB;
			return 'drop';
		};
		await expect(upload(clip(20 * MiB))).resolves.toBe('ok');
		expect(requests.map((request) => request.method)).toEqual(['POST', 'PATCH', 'PATCH', 'HEAD', 'PATCH', 'PATCH']);
		expect(patches().map((request) => request.headers['Upload-Offset'])).toEqual([
			'0',
			String(8 * MiB),
			String(11 * MiB),
			String(19 * MiB),
		]);
		expect(serverOffset).toBe(20 * MiB);
	});

	it('re-signs once on 401 and continues', async () => {
		patchReply = (request) => (request.headers.AuthorizationSignature === 'sig-1' ? {status: 401} : undefined);
		const resign = vi.fn(async () => ticket('sig-2', 1_900_007_200));
		await expect(upload(clip(3 * MiB), {resign})).resolves.toBe('ok');
		expect(resign).toHaveBeenCalledTimes(1);
		const last = patches().at(-1)!;
		expect(last.headers).toMatchObject({AuthorizationSignature: 'sig-2', AuthorizationExpire: '1900007200'});
		expect(serverOffset).toBe(3 * MiB);

		// A second refusal right after the new signature ends the upload.
		requests = [];
		serverOffset = 0;
		patchReply = () => ({status: 403});
		resign.mockClear();
		expect(await upload(clip(3 * MiB), {resign})).toBeInstanceOf(Error);
		expect(resign).toHaveBeenCalledTimes(1);
	});

	it('never sends the sanalyer session token to Bunny', async () => {
		patchReply = (_, index) => (index === 0 ? 'drop' : undefined);
		await expect(upload(clip(9 * MiB))).resolves.toBe('ok');
		expect(requests.map((request) => request.method)).toContain('HEAD');
		for (const request of requests) {
			expect(request.url.startsWith('https://video.bunnycdn.com/')).toBe(true);
			expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain('authorization');
			expect(Object.values(request.headers)).not.toContain(SESSION_TOKEN);
		}
		expect(requests.find((request) => request.method === 'HEAD')!.credentials).toBe('omit');
	});

	it('stops on abort', async () => {
		const controller = new AbortController();
		patchReply = () => 'hang';
		const result = uploadFeedVideo(clip(20 * MiB), ticket(), {signal: controller.signal, resign: vi.fn()});
		await vi.advanceTimersByTimeAsync(0);
		expect(patches()).toHaveLength(1);
		controller.abort();
		await expect(result).rejects.toMatchObject({name: 'AbortError'});
		await vi.runAllTimersAsync();
		expect(patches()).toHaveLength(1);

		// An abort during the wait before a retry ends it too, without the retry.
		requests = [];
		const second = new AbortController();
		patchReply = () => 'drop';
		const retrying = uploadFeedVideo(clip(3 * MiB), ticket(), {signal: second.signal, resign: vi.fn()});
		await vi.advanceTimersByTimeAsync(0);
		second.abort();
		await expect(retrying).rejects.toMatchObject({name: 'AbortError'});
		await vi.runAllTimersAsync();
		expect(requests.map((request) => request.method)).toEqual(['POST', 'PATCH']);
	});

	// an upload cut by the network goes on by itself once the connection is back, however long that takes.
	it('waits offline for the connection to come back without using up its retries', async () => {
		patchReply = (_, index) => {
			if (index !== 1) return undefined;
			online = false;
			return 'drop';
		};
		const result = uploadFeedVideo(clip(20 * MiB), ticket(), {
			signal: new AbortController().signal,
			resign: vi.fn(),
		}).then(
			() => 'ok',
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(methods()).toEqual(['POST', 'PATCH', 'PATCH']);
		online = true;
		window.dispatchEvent(new Event('online'));
		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe('ok');
		expect(methods()).toEqual(['POST', 'PATCH', 'PATCH', 'HEAD', 'PATCH', 'PATCH']);
		expect(serverOffset).toBe(20 * MiB);
	});

	it('stops waiting for the connection when aborted', async () => {
		patchReply = () => {
			online = false;
			return 'drop';
		};
		const controller = new AbortController();
		const result = uploadFeedVideo(clip(3 * MiB), ticket(), {signal: controller.signal, resign: vi.fn()});
		await vi.advanceTimersByTimeAsync(60_000);
		controller.abort();
		await expect(result).rejects.toMatchObject({name: 'AbortError'});
	});

	// A half-open connection never fails by itself: a PATCH without progress for 60 s is dropped and HEAD asked.
	it('gives up a PATCH that makes no progress for 60 seconds and goes on from the HEAD offset', async () => {
		patchReply = (_, index) => {
			if (index !== 1) return undefined;
			serverOffset += 3 * MiB;
			return 'hang';
		};
		const result = uploadFeedVideo(clip(20 * MiB), ticket(), {
			signal: new AbortController().signal,
			resign: vi.fn(),
		}).then(
			() => 'ok',
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(methods()).toEqual(['POST', 'PATCH', 'PATCH']);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.runAllTimersAsync();
		expect(methods()).toEqual(['POST', 'PATCH', 'PATCH', 'HEAD', 'PATCH', 'PATCH']);
		await expect(result).resolves.toBe('ok');
	});

	it('keeps a slow PATCH that still makes progress, however long it takes', async () => {
		patchReply = (_, index) => (index === 0 ? 'slow' : undefined);
		await expect(upload(clip(9 * MiB))).resolves.toBe('ok');
		expect(methods()).toEqual(['POST', 'PATCH', 'PATCH']);
		expect(serverOffset).toBe(9 * MiB);
	});

	it('resumes an earlier upload from the offset the server has, and names a new one when it creates it', async () => {
		serverOffset = 5 * MiB;
		await expect(upload(clip(9 * MiB), {uploadUrl: UPLOAD_URL})).resolves.toBe('ok');
		expect(methods()).toEqual(['HEAD', 'PATCH']);
		expect(patches()[0]!.headers['Upload-Offset']).toBe(String(5 * MiB));

		requests = [];
		serverOffset = 0;
		const onCreated = vi.fn();
		await expect(upload(clip(3 * MiB), {onCreated})).resolves.toBe('ok');
		expect(onCreated).toHaveBeenCalledExactlyOnceWith(UPLOAD_URL);
	});

	it('refuses an upload address on another host than the TUS endpoint', async () => {
		createReply = {status: 201, headers: {Location: 'https://uploads.example.com/tusupload/up-1'}};
		expect(await upload(clip(3 * MiB))).toBeInstanceOf(Error);
		expect(methods()).toEqual(['POST']);
	});
});
