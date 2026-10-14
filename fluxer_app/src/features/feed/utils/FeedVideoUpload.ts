// SPDX-License-Identifier: AGPL-3.0-or-later

import {http} from '@app/features/platform/transport/RestTransport';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {ExponentialBackoff} from '@app/features/platform/utils/RetryScheduler';
import type {FeedVideoUploadResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

// TUS 1.0 by hand, straight to Bunny Stream: a creation POST, 8 MiB PATCHes, and after a failure a HEAD for
// the offset the server really has, so a dropped connection loses at most the bytes in flight. Offline it waits for the
// connection, and a request without progress for FEED_VIDEO_STALL_MS is dropped (a half-open connection
// never fails by itself).
export const FEED_VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
export const FEED_VIDEO_STALL_MS = 60_000;
const RETRY_MIN_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
const RETRY_ATTEMPTS = 6;
const RETRY_AFTER_CAP_MS = 30_000;

export interface FeedVideoUploadHooks {
	signal: AbortSignal;
	onProgress?: (uploadedBytes: number, totalBytes: number) => void;
	// A new signature for the same video (POST /feed/videos/:id/signature), asked once when Bunny refuses the current one.
	resign: () => Promise<FeedVideoUploadResponse>;
	// The TUS upload of an earlier try: it goes on from the offset the server has instead of starting a new upload.
	uploadUrl?: string;
	onCreated?: (uploadUrl: string) => void;
}

class TusFailure extends Error {
	constructor(
		readonly status: number,
		readonly retryAfterMs: number,
	) {
		super(`Bunny TUS answered ${status}`);
	}
}

function failure(status: number, retryAfter: string | null | undefined): TusFailure {
	const seconds = Number(retryAfter);
	return new TusFailure(status, retryAfter && seconds >= 0 ? Math.min(seconds * 1000, RETRY_AFTER_CAP_MS) : 0);
}

// fetch fails with a TypeError, the REST client with these; any other error (a bad Upload-Offset) will not heal.
function isTransient(error: unknown): boolean {
	if (error instanceof TusFailure) {
		return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
	}
	if (error instanceof TypeError) return true;
	return error instanceof Error && (error.name === 'TimeoutError' || error.message === 'Network error during request');
}

function abortError(): DOMException {
	return new DOMException('Upload aborted', 'AbortError');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const stop = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop);
			resolve();
		}, ms);
		signal.addEventListener('abort', stop, {once: true});
	});
}

function onlineAgain(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const stop = () => {
			window.removeEventListener('online', done);
			reject(abortError());
		};
		const done = () => {
			window.removeEventListener('online', done);
			signal.removeEventListener('abort', stop);
			resolve();
		};
		window.addEventListener('online', done);
		signal.addEventListener('abort', stop, {once: true});
	});
}

// One request under a stall watchdog: aborted after FEED_VIDEO_STALL_MS without progress (touch() restarts the wait),
// then failing with a TimeoutError, which is retried like a dropped connection.
async function watched<T>(outer: AbortSignal, run: (signal: AbortSignal, touch: () => void) => Promise<T>): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const touch = () => {
		clearTimeout(timer);
		timer = setTimeout(() => controller.abort(), FEED_VIDEO_STALL_MS);
	};
	const forward = () => controller.abort();
	if (outer.aborted) controller.abort();
	outer.addEventListener('abort', forward, {once: true});
	touch();
	try {
		return await run(controller.signal, touch);
	} catch (error) {
		if (controller.signal.aborted && !outer.aborted) {
			throw Object.assign(new Error('Bunny TUS request stalled'), {name: 'TimeoutError'});
		}
		throw error;
	} finally {
		clearTimeout(timer);
		outer.removeEventListener('abort', forward);
	}
}

// Throws on failure; a DOMException named AbortError once the signal aborts.
export async function uploadFeedVideo(
	file: File,
	ticket: FeedVideoUploadResponse,
	hooks: FeedVideoUploadHooks,
): Promise<void> {
	const {signal} = hooks;
	let current = ticket;
	// Only Bunny's upload headers. The URLs are absolute and auth is 'none', so the REST client adds no session token.
	const tusHeaders = () => ({
		'Tus-Resumable': '1.0.0',
		AuthorizationSignature: current.upload.signature,
		AuthorizationExpire: String(current.upload.expires),
		LibraryId: current.library_id,
		VideoId: current.id,
	});
	const readOffset = (raw: string | null | undefined, min: number): number => {
		const offset = raw && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
		if (!(offset >= min && offset <= file.size)) throw new Error('Bunny TUS sent no usable Upload-Offset');
		return offset;
	};
	const send = async (reply: Promise<RestResponse<unknown>>) => {
		const response = await reply;
		if (!response.ok) throw failure(response.status, response.headers['retry-after']);
		return response;
	};

	const create = async (): Promise<string> => {
		const response = await watched(signal, (request) =>
			send(
				http.post(current.upload.endpoint, {
					headers: {
						...tusHeaders(),
						'Upload-Length': String(file.size),
						'Upload-Metadata': `filetype ${btoa(file.type)},title ${btoa(current.id)}`,
					},
					auth: 'none',
					mode: 'silent',
					signal: request,
				}),
			),
		);
		// The PATCHes carry the upload signature: only to the TUS endpoint's own host.
		const url = new URL(response.headers.location ?? '', current.upload.endpoint);
		if (
			!response.headers.location ||
			url.protocol !== 'https:' ||
			url.origin !== new URL(current.upload.endpoint).origin
		) {
			throw new Error('Bunny TUS sent no usable Location');
		}
		return url.toString();
	};
	// HEAD is not a REST client method.
	const head = async (url: string): Promise<number> => {
		const response = await watched(signal, (request) =>
			fetch(url, {
				method: 'HEAD',
				headers: tusHeaders(),
				credentials: 'omit',
				cache: 'no-store',
				signal: request,
			}),
		);
		if (!response.ok) throw failure(response.status, response.headers.get('retry-after'));
		return readOffset(response.headers.get('upload-offset'), 0);
	};
	const patch = async (url: string, offset: number): Promise<number> => {
		const chunk = file.slice(offset, offset + FEED_VIDEO_CHUNK_BYTES);
		const response = await watched(signal, (request, touch) =>
			send(
				http.patch(url, {
					body: chunk,
					headers: {
						...tusHeaders(),
						'Upload-Offset': String(offset),
						'Content-Type': 'application/offset+octet-stream',
					},
					auth: 'none',
					mode: 'silent',
					signal: request,
					onProgress: (event) => {
						touch();
						hooks.onProgress?.(offset + Math.min(event.loaded, chunk.size), file.size);
					},
				}),
			),
		);
		const next = readOffset(response.headers['upload-offset'], offset + 1);
		hooks.onProgress?.(next, file.size);
		return next;
	};

	const backoff = new ExponentialBackoff({
		minDelay: RETRY_MIN_DELAY_MS,
		maxDelay: RETRY_MAX_DELAY_MS,
		maxNumOfAttempts: RETRY_ATTEMPTS,
		jitter: true,
	});
	let resigned = false;
	let uploadUrl: string | null = hooks.uploadUrl ?? null;
	// null: ask the server with HEAD before the next PATCH.
	let offset: number | null = null;
	while (true) {
		try {
			if (uploadUrl === null) {
				uploadUrl = await create();
				offset = 0;
				hooks.onCreated?.(uploadUrl);
			} else if (offset === null) {
				offset = await head(uploadUrl);
			} else if (offset < file.size) {
				offset = await patch(uploadUrl, offset);
				backoff.reset();
				resigned = false;
			} else {
				return;
			}
		} catch (error) {
			if (signal.aborted) throw abortError();
			offset = null;
			// An expired or refused signature: one new one, then give up if Bunny refuses that too.
			if (error instanceof TusFailure && (error.status === 401 || error.status === 403)) {
				if (resigned) throw error;
				resigned = true;
				current = await hooks.resign();
				continue;
			}
			if (!isTransient(error)) throw error;
			// Offline: no retry is used up while waiting, however long the connection is gone.
			if (!navigator.onLine) {
				await onlineAgain(signal);
				continue;
			}
			if (backoff.isExhausted()) throw error;
			const retryAfterMs = error instanceof TusFailure ? error.retryAfterMs : 0;
			await sleep(Math.max(backoff.next(), retryAfterMs), signal);
		}
	}
}
