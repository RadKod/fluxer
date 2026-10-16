// SPDX-License-Identifier: AGPL-3.0-or-later

import type {HonoEnv} from '@app/api/types/HonoEnv';
import {FileSizeTooLargeError} from '@fluxer/errors/src/domains/core/FileSizeTooLargeError';
import {createMiddleware} from 'hono/factory';

function declaredContentLength(headers: Headers): number | null {
	if (headers.has('transfer-encoding')) return null;
	const value = headers.get('content-length');
	if (value === null || !/^\d+$/.test(value.trim())) return null;
	const length = Number(value);
	return Number.isSafeInteger(length) ? length : null;
}

/**
 * Caps a request body at maxSize bytes and answers FILE_SIZE_TOO_LARGE above it.
 *
 * Replaces hono's bodyLimit, which reads `c.req.raw.body` directly whenever the request has no
 * Content-Length (chunked uploads, e.g. nginx with proxy_request_buffering off). App-level middleware
 * such as ContentFilterMiddleware may already have read the body through HonoRequest's cache, which
 * locks the raw stream; bodyLimit then fails with ERR_INVALID_STATE and the request turns into a 500.
 * This version measures the cached body in that case and otherwise reads the stream once, stopping
 * at the limit.
 */
export function RequestBodyLimit(maxSize: number) {
	return createMiddleware<HonoEnv>(async (ctx, next) => {
		const raw = ctx.req.raw;
		const declared = declaredContentLength(raw.headers);
		if (declared !== null && declared > maxSize) throw new FileSizeTooLargeError(maxSize);
		if (raw.body === null || declared !== null) return next();
		if (Object.keys(ctx.req.bodyCache).length > 0) {
			const text = await ctx.req.text();
			if (Buffer.byteLength(text, 'utf8') > maxSize) throw new FileSizeTooLargeError(maxSize);
			return next();
		}
		// Read outside HonoRequest's cache; the body validator reports the unreadable body as a 400.
		if (raw.bodyUsed || raw.body.locked) return next();
		const reader = raw.body.getReader();
		const chunks: Array<Uint8Array> = [];
		let size = 0;
		for (;;) {
			const {done, value} = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxSize) {
				await reader.cancel().catch(() => undefined);
				throw new FileSizeTooLargeError(maxSize);
			}
			chunks.push(value);
		}
		ctx.req.raw = new Request(raw, {body: Buffer.concat(chunks, size), duplex: 'half'} as RequestInit);
		return next();
	});
}
