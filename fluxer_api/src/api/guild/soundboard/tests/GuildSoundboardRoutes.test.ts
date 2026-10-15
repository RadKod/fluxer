// SPDX-License-Identifier: AGPL-3.0-or-later

import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {GuildSoundboardController} from '@app/api/guild/soundboard/GuildSoundboardController';
import * as Probe from '@app/api/guild/soundboard/GuildSoundboardDurationProbe';
import {fixture, savedSound, USER_ID} from '@app/api/guild/soundboard/tests/GuildSoundboardTestUtils';
import {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {GuildSoundboardUploadRequest} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {afterEach, describe, expect, it, vi} from 'vitest';

function appFixture(flags = 0n) {
	const f = fixture();
	const app = new Hono<HonoEnv>();
	app.use(async (ctx, next) => {
		ctx.set('user', new User({...EMPTY_USER_ROW, user_id: USER_ID, flags}));
		ctx.set('guildSoundboardService', f.service);
		await next();
	});
	app.onError((error) => (error instanceof HTTPException ? error.getResponse() : new Response(null, {status: 500})));
	GuildSoundboardController(app);
	const request = (method: string, path: string, body?: unknown) =>
		app.request(path, {
			method,
			headers: {'content-type': 'application/json'},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	return {...f, request};
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
			audio: 'a'.repeat(684001),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({code: 'FILE_SIZE_TOO_LARGE'});
		expect(f.media.getMetadata).not.toHaveBeenCalled();
	});
	it('accepts raw base64 only, rejecting data URIs before decoding', () => {
		expect(
			GuildSoundboardUploadRequest.safeParse({name: 'Sound', audio: 'data:audio/mpeg;base64,c291bmQ='}).success,
		).toBe(false);
	});
});
