// SPDX-License-Identifier: AGPL-3.0-or-later

import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {GuildSoundboardController} from '@app/api/guild/soundboard/GuildSoundboardController';
import * as Probe from '@app/api/guild/soundboard/GuildSoundboardDurationProbe';
import {fixture, savedSound, USER_ID} from '@app/api/guild/soundboard/tests/GuildSoundboardTestUtils';
import ContentFilterMiddleware from '@app/api/middleware/ContentFilterMiddleware';
import {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {GuildSoundboardUploadRequest} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {afterEach, describe, expect, it, vi} from 'vitest';

function appFixture(flags = 0n, {contentFilter = false} = {}) {
	const f = fixture();
	const app = new Hono<HonoEnv>();
	app.use(async (ctx, next) => {
		ctx.set('user', new User({...EMPTY_USER_ROW, user_id: USER_ID, flags}));
		ctx.set('guildSoundboardService', f.service);
		await next();
	});
	// Production runs the content filter app-wide, so it reads the JSON body before route middleware.
	if (contentFilter) app.use(ContentFilterMiddleware);
	app.onError((error) => (error instanceof HTTPException ? error.getResponse() : new Response(null, {status: 500})));
	GuildSoundboardController(app);
	const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
		app.request(path, {
			method,
			headers: {'content-type': 'application/json', ...headers},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	// A chunked request: no Content-Length header, body delivered as a stream.
	const streamRequest = (path: string, text: string) => {
		const bytes = new TextEncoder().encode(text);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < bytes.length; offset += 65536)
					controller.enqueue(bytes.subarray(offset, offset + 65536));
				controller.close();
			},
		});
		const request = new Request(`http://localhost${path}`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'transfer-encoding': 'chunked'},
			body,
			duplex: 'half',
		} as RequestInit);
		expect(request.headers.has('content-length')).toBe(false);
		return app.request(request);
	};
	return {...f, request, streamRequest};
}

afterEach(() => vi.restoreAllMocks());

describe('Guild soundboard HTTP routes', () => {
	it('rejects deletion by a limited account and preserves the sound', async () => {
		const f = appFixture(UserFlags.ACCOUNT_LIMITED);
		await f.repository.upsertSound(savedSound());
		const response = await f.request('DELETE', '/guilds/201/soundboard-sounds/401');
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({code: 'ACCOUNT_LIMITED'});
		expect(await f.repository.getSound(savedSound().guildId, savedSound().soundId)).not.toBeNull();
		expect(f.gateway.checkPermission).not.toHaveBeenCalled();
	});
	it('roundtrips create, list, update and delete through the controller', async () => {
		vi.spyOn(Probe, 'resolveGuildSoundboardDurationMs').mockResolvedValue(1000);
		const f = appFixture();
		const base = '/guilds/201/soundboard-sounds';
		const created = await f.request('POST', base, {name: 'Sound', audio: Buffer.from('sound').toString('base64')});
		expect(created.status).toBe(201);
		const sound = (await created.json()) as {id: string};
		expect(await (await f.request('GET', base)).json()).toMatchObject({sounds: [{id: sound.id}]});
		const updated = await f.request('PATCH', `${base}/${sound.id}`, {volume: 0});
		expect(updated.status).toBe(200);
		expect(await updated.json()).toMatchObject({volume: 0, version: 2});
		expect((await f.request('DELETE', `${base}/${sound.id}`)).status).toBe(204);
		expect(await (await f.request('GET', base)).json()).toEqual({sounds: []});
	});
	it('caps the request body before media parsing', async () => {
		const f = appFixture();
		const response = await f.request('POST', '/guilds/201/soundboard-sounds', {
			name: 'Sound',
			audio: 'a'.repeat(1_400_001),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({code: 'FILE_SIZE_TOO_LARGE'});
		expect(f.media.getMetadata).not.toHaveBeenCalled();
	});
	it('rejects an oversized Content-Length before reading the body', async () => {
		const f = appFixture();
		const response = await f.request('POST', '/guilds/201/soundboard-sounds', undefined, {'content-length': '1400001'});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({code: 'FILE_SIZE_TOO_LARGE'});
	});
	it.each([false, true])(
		'accepts a chunked upload without Content-Length (content filter first: %s)',
		async (contentFilter) => {
			vi.spyOn(Probe, 'resolveGuildSoundboardDurationMs').mockResolvedValue(10000);
			const f = appFixture(0n, {contentFilter});
			const audio = Buffer.alloc(1_000_000, 7).toString('base64');
			const response = await f.streamRequest('/guilds/201/soundboard-sounds', JSON.stringify({name: 'Sound', audio}));
			expect(response.status).toBe(201);
			expect(await response.json()).toMatchObject({size_bytes: 1_000_000, duration_ms: 10000});
		},
	);
	it.each([false, true])(
		'caps a chunked upload without Content-Length with 400, not 500 (content filter first: %s)',
		async (contentFilter) => {
			const f = appFixture(0n, {contentFilter});
			const response = await f.streamRequest(
				'/guilds/201/soundboard-sounds',
				JSON.stringify({name: 'Sound', audio: 'a'.repeat(1_400_001)}),
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({code: 'FILE_SIZE_TOO_LARGE'});
			expect(f.media.getMetadata).not.toHaveBeenCalled();
		},
	);
	it('accepts raw base64 only, rejecting data URIs before decoding', () => {
		expect(
			GuildSoundboardUploadRequest.safeParse({name: 'Sound', audio: 'data:audio/mpeg;base64,c291bmQ='}).success,
		).toBe(false);
	});
});
