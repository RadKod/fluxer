// SPDX-License-Identifier: AGPL-3.0-or-later

import {BunnyStreamClient, BunnyStreamError} from '@app/api/feed/video/BunnyStreamClient';
import {BUNNY_TEST_SETTINGS, fakeBunnyStream} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {server} from '@app/api/test/msw/server';
import {HttpResponse, http} from 'msw';
import {beforeEach, describe, expect, it} from 'vitest';

const settings = BUNNY_TEST_SETTINGS;

async function readAll(body: ReadableStream<Uint8Array>): Promise<Buffer> {
	const chunks: Array<Uint8Array> = [];
	for await (const chunk of body) chunks.push(chunk);
	return Buffer.concat(chunks);
}

describe('BunnyStreamClient', () => {
	let client: BunnyStreamClient;

	beforeEach(() => {
		fakeBunnyStream.reset();
		client = new BunnyStreamClient(settings);
	});

	it('creates, reads and deletes a video with the library key', async () => {
		const {guid} = await client.createVideo('1234567890');
		expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(fakeBunnyStream.getVideo(guid)?.title).toBe('1234567890');

		await fakeBunnyStream.finishVideo(guid, {length: 29, width: 3840, height: 2160, rotation: -90, category: 'adult'});
		const video = await client.getVideo(guid);
		expect(video).toEqual({
			guid,
			status: 4,
			length: 29,
			width: 3840,
			height: 2160,
			rotation: -90,
			thumbnailCount: 15,
			category: 'adult',
			dateUploaded: fakeBunnyStream.getVideo(guid)!.dateUploaded,
			originalHash: fakeBunnyStream.getVideo(guid)!.originalHash,
		});

		await client.deleteVideo(guid);
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
		expect(await client.getVideo(guid)).toBeNull();

		const calls = fakeBunnyStream.getCalls();
		expect(calls.map((call) => `${call.method} ${call.service}`)).toEqual([
			'POST api',
			'GET api',
			'DELETE api',
			'GET api',
		]);
		expect(calls.every((call) => call.accessKey === settings.apiKey)).toBe(true);
	});

	it('lists storage files with their byte length using the storage password', async () => {
		const guid = fakeBunnyStream.putVideo();
		await fakeBunnyStream.finishVideo(guid, {length: 90, originalBytes: 132_860_195});

		const root = await client.listFiles(guid);
		expect(root).toContainEqual({name: 'original', length: 132_860_195, isDirectory: false});
		expect(root).toContainEqual({name: 'thumbnail.jpg', length: expect.any(Number), isDirectory: false});
		expect(root).toContainEqual({name: 'play_720p.mp4', length: expect.any(Number), isDirectory: false});
		expect(root).toContainEqual({name: 'seek', length: 0, isDirectory: true});
		const seek = await client.listFiles(guid, 'seek');
		expect(seek?.map((entry) => entry.name)).toEqual(['_0.jpg', '_1.jpg']);

		const calls = fakeBunnyStream.getCalls().filter((call) => call.service === 'storage');
		expect(calls).toHaveLength(2);
		expect(calls.every((call) => call.accessKey === settings.storagePassword)).toBe(true);
		expect(fakeBunnyStream.getCalls().filter((call) => call.method !== 'GET' && call.service === 'storage')).toEqual(
			[],
		);
	});

	it('reads a storage file up to a byte cap', async () => {
		const guid = fakeBunnyStream.putVideo();
		fakeBunnyStream.setFile(guid, 'thumbnail_2.jpg', Buffer.alloc(100, 7));

		expect(await client.readFile(guid, 'thumbnail_2.jpg', 100)).toEqual(Buffer.alloc(100, 7));
		await expect(client.readFile(guid, 'thumbnail_2.jpg', 99)).rejects.toThrow();

		await fakeBunnyStream.finishVideo(guid, {length: 90});
		const sheet = await client.readFile(guid, 'seek/_0.jpg', 8 * 1024 * 1024);
		expect(sheet?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
	});

	it('streams a storage file and reads the HLS playlists and segments', async () => {
		const guid = fakeBunnyStream.putVideo();
		await fakeBunnyStream.finishVideo(guid, {length: 9, resolutions: ['360p', '720p']});

		const master = (await client.readFile(guid, 'playlist.m3u8', 64 * 1024))!.toString('utf8');
		expect(master).toContain('RESOLUTION=720x1280');
		expect(master).toContain('720p/video.m3u8');
		const variants = await client.listFiles(guid, '720p');
		expect(variants?.map((entry) => entry.name)).toEqual(['video.m3u8', 'video0.ts', 'video1.ts', 'video2.ts']);
		expect(await client.listFiles(guid, '720p/')).toEqual(variants);
		const media = (await client.readFile(guid, '720p/video.m3u8', 1024 * 1024))!.toString('utf8');
		expect(media.split('\n').filter((line) => line.endsWith('.ts'))).toEqual(['video0.ts', 'video1.ts', 'video2.ts']);

		const segment = await client.streamFile(guid, '720p/video1.ts');
		const expected = fakeBunnyStream.getFile(guid, '720p/video1.ts')!;
		expect(segment?.length).toBe(expected.length);
		expect(await readAll(segment!.body)).toEqual(expected);
		expect(fakeBunnyStream.getCalls().every((call) => call.accessKey === settings.storagePassword)).toBe(true);
	});

	it('treats 404 on delete as done and on read as gone', async () => {
		const missing = '7d1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
		await expect(client.deleteVideo(missing)).resolves.toBeUndefined();
		expect(await client.getVideo(missing)).toBeNull();
		expect(await client.listFiles(missing)).toBeNull();
		expect(await client.readFile(missing, 'thumbnail.jpg', 1024)).toBeNull();
		expect(await client.streamFile(missing, '720p/video0.ts')).toBeNull();
		expect(await client.listFiles(missing, '720p')).toBeNull();
		expect(fakeBunnyStream.getCalls()).toHaveLength(6);
	});

	it('never calls Bunny with a malformed guid or path', async () => {
		const guid = fakeBunnyStream.putVideo();
		const badGuids = ['../other', '6F1C2D3E-4A5B-4C6D-8E7F-0A1B2C3D4E5F', `${guid}/..`, ''];
		for (const bad of badGuids) {
			await expect(client.getVideo(bad)).rejects.toThrow();
			await expect(client.deleteVideo(bad)).rejects.toThrow();
			await expect(client.listFiles(bad)).rejects.toThrow();
			await expect(client.readFile(bad, 'thumbnail.jpg', 1024)).rejects.toThrow();
			await expect(client.streamFile(bad, '720p/video0.ts')).rejects.toThrow();
		}
		const badPaths = [
			'../x/original',
			'thumbnail_6.jpg',
			'seek/../original',
			'seek/_1.png',
			'play_7p.mp4',
			'720p/../original',
			'720p/video0.ts/..',
			'720p/other.ts',
			'720/video0.ts',
			'720p/playlist.m3u8',
			'',
			'/',
		];
		for (const bad of badPaths) {
			await expect(client.readFile(guid, bad, 1024)).rejects.toThrow();
			await expect(client.streamFile(guid, bad)).rejects.toThrow();
		}
		for (const bad of ['original', '720p//', '720p/video0.ts', '../seek', 'seekx', '4k', '']) {
			await expect(client.listFiles(guid, bad)).rejects.toThrow();
		}
		expect(fakeBunnyStream.getCalls()).toEqual([]);
	});

	it('keeps keys and urls out of its error messages', async () => {
		const guid = fakeBunnyStream.putVideo();
		fakeBunnyStream.setFile(guid, 'original', Buffer.alloc(10));
		fakeBunnyStream.failWhen(() => true, 500);
		const failures: Array<unknown> = await Promise.all([
			client.createVideo('1').catch((error: unknown) => error),
			client.getVideo(guid).catch((error: unknown) => error),
			client.deleteVideo(guid).catch((error: unknown) => error),
			client.listFiles(guid).catch((error: unknown) => error),
			client.readFile(guid, 'original', 100).catch((error: unknown) => error),
			client.streamFile(guid, 'original').catch((error: unknown) => error),
		]);
		server.use(http.get(`https://${settings.storageHost}/*`, () => HttpResponse.error()));
		failures.push(await client.listFiles(guid, 'seek').catch((error: unknown) => error));

		const secrets = [
			settings.apiKey,
			settings.storagePassword,
			settings.readOnlyApiKey,
			settings.tokenKey,
			new URL(settings.apiBase).host,
			settings.storageHost,
			settings.storageZone,
			guid,
		];
		for (const failure of failures) {
			expect(failure).toBeInstanceOf(BunnyStreamError);
			const text = `${(failure as Error).message} ${String((failure as Error).stack)} ${JSON.stringify(failure)}`;
			for (const secret of secrets) expect(text).not.toContain(secret);
		}
		expect(failures.slice(0, 6).map((failure) => (failure as BunnyStreamError).status)).toEqual([
			500, 500, 500, 500, 500, 500,
		]);
		expect((failures[6] as BunnyStreamError).status).toBeNull();
	});
});
