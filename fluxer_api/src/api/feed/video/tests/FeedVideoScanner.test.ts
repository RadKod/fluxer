// SPDX-License-Identifier: AGPL-3.0-or-later

import {type BunnyStorageEntry, BunnyStreamClient, type BunnyVideo} from '@app/api/feed/video/BunnyStreamClient';
import {
	decideVideo,
	displaySize,
	FeedVideoScanner,
	fullSheetTile,
	planSeekFrames,
} from '@app/api/feed/video/FeedVideoScanner';
import type {MediaProxyMetadataRequest, MediaProxyMetadataResponse} from '@app/api/infrastructure/IMediaService';
import {BUNNY_TEST_SETTINGS, fakeBunnyStream} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import sharp from 'sharp';
import {beforeEach, describe, expect, it, vi} from 'vitest';

// The fake's frame colours: the poster, thumbnail_1..5, and grey seek sheets.
const PALETTE: Record<string, [number, number, number]> = {
	poster: [192, 48, 48],
	thumbnail_1: [48, 192, 48],
	thumbnail_2: [48, 48, 192],
	thumbnail_3: [192, 192, 48],
	thumbnail_4: [48, 192, 192],
	thumbnail_5: [192, 48, 192],
	tile: [128, 128, 128],
};

async function frameName(base64: string): Promise<string> {
	const {channels} = await sharp(Buffer.from(base64, 'base64')).stats();
	const rgb = channels.slice(0, 3).map((channel) => channel.mean);
	let best = '';
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const [name, colour] of Object.entries(PALETTE)) {
		const distance = colour.reduce((sum, value, index) => sum + (value - rgb[index]!) ** 2, 0);
		if (distance < bestDistance) {
			best = name;
			bestDistance = distance;
		}
	}
	return best;
}

type Answer = (name: string) => Partial<MediaProxyMetadataResponse> | null;

// A media proxy that recognises each frame by its colour and answers what the test says about it.
function mediaProxy(answer: Answer = () => ({})) {
	const requests: Array<MediaProxyMetadataRequest> = [];
	const seen: Array<string> = [];
	const getMetadata = vi.fn(async (request: MediaProxyMetadataRequest) => {
		requests.push(request);
		const name = request.type === 'base64' ? await frameName(request.base64) : 'url';
		seen.push(name);
		const verdict = answer(name);
		if (verdict === null) return null;
		return {
			format: 'jpeg',
			content_type: 'image/jpeg',
			content_hash: 'hash',
			size: 1,
			nsfw: false,
			nsfw_probability: 0.02,
			...verdict,
		} satisfies MediaProxyMetadataResponse;
	});
	return {getMetadata, requests, seen};
}

async function finished(options: Parameters<typeof fakeBunnyStream.finishVideo>[1] = {}) {
	const guid = fakeBunnyStream.putVideo();
	await fakeBunnyStream.finishVideo(guid, options);
	const client = new BunnyStreamClient(BUNNY_TEST_SETTINGS);
	const video = (await client.getVideo(guid)) as BunnyVideo;
	const files = (await client.listFiles(guid)) as Array<BunnyStorageEntry>;
	return {guid, client, video, files};
}

function scannerFor(client: BunnyStreamClient, media: ReturnType<typeof mediaProxy>) {
	return new FeedVideoScanner({client, media, randomInt: () => 0});
}

async function jpeg(width: number, height: number, colour = '#808080'): Promise<Buffer> {
	return sharp({create: {width, height, channels: 3, background: colour}})
		.jpeg()
		.toBuffer();
}

describe('FeedVideoScanner', () => {
	beforeEach(() => {
		fakeBunnyStream.reset();
	});

	it('plans 54 seek frames spread over the video with a random start below one step', () => {
		const randomInt = vi.fn((max: number) => max - 1);
		const plan = planSeekFrames(1000, 54, randomInt);
		const step = 1000 / 54;
		expect(randomInt).toHaveBeenCalledWith(Math.floor(step * 1000));
		expect(plan).toHaveLength(54);
		expect(plan[0]!.frame).toBeLessThan(step);
		for (const [index, entry] of plan.entries()) {
			expect(entry.frame).toBe(Math.floor((Math.floor(step * 1000) - 1) / 1000 + index * step));
			expect(entry.frame).toBeLessThan(1000);
			expect(entry.sheet).toBe(Math.floor(entry.frame / 36));
			expect(entry.slot).toBe(entry.frame % 36);
		}
		expect(new Set(plan.map((entry) => entry.frame)).size).toBe(54);
		expect(planSeekFrames(1000, 54, () => 0)[0]!.frame).toBe(0);
	});

	it('plans every frame of a short video', () => {
		expect(planSeekFrames(20, 54, (max) => max - 1).map((entry) => entry.frame)).toEqual(
			Array.from({length: 20}, (_, index) => index),
		);
		expect(planSeekFrames(0, 54, () => 0)).toEqual([]);
	});

	it('reads a full 1800×3198 sheet as 6×6 tiles of 300×533', async () => {
		expect(fullSheetTile({width: 1800, height: 3198}, {width: 2160, height: 3840})).toEqual({tileW: 300, tileH: 533});
		// Bunny's landscape sheet (640×360 on live Bunny): 1800×1008, tiles of 300×168.
		expect(fullSheetTile({width: 1800, height: 1008}, {width: 640, height: 360})).toEqual({tileW: 300, tileH: 168});

		const {client, video, files} = await finished({length: 90, width: 1080, height: 1920});
		const media = mediaProxy();
		const result = await scannerFor(client, media).scan(video, files, {taggingPending: false});
		expect(result).toMatchObject({verdict: 'clean', tile: {w: 300, h: 533}, over: 0});
		// 6 thumbnails + one tile of each of 45 seek frames (below the 54 budget, every frame).
		expect(result.frames).toBe(51);
		expect(media.seen.filter((name) => name === 'tile')).toHaveLength(45);
	});

	// Bunny: a partly filled sheet is the full 6×6 canvas too, its unused cells left empty.
	it('reads the last, partly filled sheet as the full 6×6 canvas and scans only its filled cells', async () => {
		// 396 s: 198 frames, sheets 0-5; the last holds 18 frames on a 1800×3198 canvas.
		const long = await finished({length: 396});
		expect(await sharp(fakeBunnyStream.getFile(long.guid, 'seek/_5.jpg')!).metadata()).toMatchObject({
			width: 1800,
			height: 3198,
		});
		const longMedia = mediaProxy();
		const longResult = await scannerFor(long.client, longMedia).scan(long.video, long.files, {taggingPending: false});
		expect(longResult).toMatchObject({verdict: 'clean', tile: {w: 300, h: 533}});
		expect(longMedia.seen.filter((name) => name === 'tile')).toHaveLength(54);

		// 90 s: 45 frames, sheet 1 with 9 of its 36 cells filled.
		const {client, video, files} = await finished({length: 90});
		const media = mediaProxy();
		const result = await scannerFor(client, media).scan(video, files, {taggingPending: false});
		expect(result.verdict).toBe('clean');
		expect(media.seen.filter((name) => name === 'tile')).toHaveLength(45);
	});

	it('is inconclusive, not a thumbnails-only decision, when a last sheet with planned tiles is not a 6×6 canvas', async () => {
		const {guid, client, video, files} = await finished({length: 90});
		fakeBunnyStream.setFile(guid, 'seek/_1.jpg', await jpeg(1800, 1066));
		const media = mediaProxy();
		const result = await scannerFor(client, media).scan(video, files, {taggingPending: false});
		expect(result).toMatchObject({verdict: 'inconclusive', reason: 'sheet_canvas'});
		expect(media.getMetadata).not.toHaveBeenCalled();
	});

	it("reads a short video's only sheet as the full canvas: 1800×3198 portrait, 1800×1008 landscape", async () => {
		// 29 s portrait: 15 frames.
		const {guid, client, video, files} = await finished({length: 29});
		expect(await sharp(fakeBunnyStream.getFile(guid, 'seek/_0.jpg')!).metadata()).toMatchObject({
			width: 1800,
			height: 3198,
		});
		const media = mediaProxy();
		const result = await scannerFor(client, media).scan(video, files, {taggingPending: false});
		expect(result).toMatchObject({verdict: 'clean', tile: {w: 300, h: 533}, frames: 21});
		expect(media.seen.filter((name) => name === 'tile')).toHaveLength(15);

		// 15 s landscape 640×360: 8 frames on a 1800×1008 canvas of 300×168 tiles.
		const landscape = await finished({length: 15, width: 640, height: 360});
		expect(await sharp(fakeBunnyStream.getFile(landscape.guid, 'seek/_0.jpg')!).metadata()).toMatchObject({
			width: 1800,
			height: 1008,
		});
		const wide = mediaProxy();
		const wideResult = await scannerFor(landscape.client, wide).scan(landscape.video, landscape.files, {
			taggingPending: false,
		});
		expect(wideResult).toMatchObject({verdict: 'clean', tile: {w: 300, h: 168}});
		expect(wide.seen.filter((name) => name === 'tile')).toHaveLength(8);

		// A sheet cut to its frames (3 rows) is not what Bunny serves: no decision from the thumbnails alone.
		fakeBunnyStream.setFile(guid, 'seek/_0.jpg', await jpeg(1800, 1599));
		const cut = mediaProxy();
		expect(await scannerFor(client, cut).scan(video, files, {taggingPending: false})).toMatchObject({
			verdict: 'inconclusive',
			reason: 'sheet_canvas',
		});
		expect(cut.getMetadata).not.toHaveBeenCalled();
	});

	it('accepts a 3840×2160 video with rotation -90 whose sheets are 1800×3198', async () => {
		const {guid, client, video, files} = await finished({length: 90, width: 3840, height: 2160, rotation: -90});
		expect(video).toMatchObject({width: 3840, height: 2160, rotation: -90});
		for (const sheet of ['seek/_0.jpg', 'seek/_1.jpg']) {
			expect(await sharp(fakeBunnyStream.getFile(guid, sheet)!).metadata()).toMatchObject({width: 1800, height: 3198});
		}
		const result = await scannerFor(client, mediaProxy()).scan(video, files, {taggingPending: false});
		expect(result).toMatchObject({verdict: 'clean', tile: {w: 300, h: 533}});
	});

	it('reports a layout failure when a full sheet is not a whole 6×6 grid, its tile aspect fits neither orientation within 5 % or a tile is under 128×72', async () => {
		const portrait = {width: 1080, height: 1920};
		expect(fullSheetTile({width: 1799, height: 3198}, portrait)).toBeNull();
		expect(fullSheetTile({width: 1800, height: 3197}, portrait)).toBeNull();
		expect(fullSheetTile({width: 1800, height: 1800}, portrait)).toBeNull();
		// Either orientation within 5 %: a portrait sheet for a landscape display passes, 6 % off does not.
		expect(fullSheetTile({width: 1800, height: 3198}, {width: 1920, height: 1080})).toEqual({tileW: 300, tileH: 533});
		expect(fullSheetTile({width: 1800, height: 3390}, portrait)).toBeNull();
		expect(fullSheetTile({width: 762, height: 432}, {width: 1920, height: 1080})).toBeNull();
		expect(fullSheetTile({width: 1800, height: 426}, {width: 4200, height: 1000})).toBeNull();

		const {client, video, files} = await finished({length: 90, sheet: {width: 1799, height: 3198}});
		const media = mediaProxy();
		const result = await scannerFor(client, media).scan(video, files, {taggingPending: false});
		expect(result.verdict).toBe('layout');
		expect(media.getMetadata).not.toHaveBeenCalled();
	});

	it('swaps width and height for a rotation of ±90 or ±270', () => {
		for (const rotation of [90, -90, 270, -270]) {
			expect(displaySize({width: 3840, height: 2160, rotation})).toEqual({width: 2160, height: 3840});
		}
		for (const rotation of [0, 180, -180, null]) {
			expect(displaySize({width: 3840, height: 2160, rotation})).toEqual({width: 3840, height: 2160});
		}
	});

	it('is inconclusive when the poster is missing, any frame cannot be read or the media proxy answers null', async () => {
		const noPoster = await finished({length: 20});
		const media = mediaProxy();
		const withoutPoster = noPoster.files.filter((file) => file.name !== 'thumbnail.jpg');
		expect(
			(await scannerFor(noPoster.client, media).scan(noPoster.video, withoutPoster, {taggingPending: false})).verdict,
		).toBe('inconclusive');
		expect(media.getMetadata).not.toHaveBeenCalled();

		const lostSheet = await finished({length: 20});
		fakeBunnyStream.removeFile(lostSheet.guid, 'seek/_0.jpg');
		expect(
			(await scannerFor(lostSheet.client, mediaProxy()).scan(lostSheet.video, lostSheet.files, {taggingPending: false}))
				.verdict,
		).toBe('inconclusive');

		const failingRead = await finished({length: 20});
		fakeBunnyStream.failWhen((call) => call.guid === failingRead.guid && call.path === 'thumbnail_2.jpg', 500);
		expect(
			(
				await scannerFor(failingRead.client, mediaProxy()).scan(failingRead.video, failingRead.files, {
					taggingPending: false,
				})
			).verdict,
		).toBe('inconclusive');

		const nullAnswer = await finished({length: 20});
		const silent = mediaProxy((name) => (name === 'thumbnail_4' ? null : {}));
		expect(
			(await scannerFor(nullAnswer.client, silent).scan(nullAnswer.video, nullAnswer.files, {taggingPending: false}))
				.verdict,
		).toBe('inconclusive');
	});

	it('is inconclusive when every frame scores exactly 0', async () => {
		const {client, video, files} = await finished({length: 20});
		const result = await scannerFor(
			client,
			mediaProxy(() => ({nsfw_probability: 0})),
		).scan(video, files, {
			taggingPending: false,
		});
		expect(result).toMatchObject({verdict: 'inconclusive', maxProbability: 0});
		expect(
			decideVideo({
				frames: [
					{source: 'poster', nsfw: false, probability: 0},
					{source: 'tile', nsfw: false, probability: 0},
				],
				unreadable: false,
				category: 'other',
			}),
		).toBe('inconclusive');
		expect(decideVideo({frames: [], unreadable: false, category: 'other'})).toBe('inconclusive');
	});

	it('calls a video NSFW when Bunny tags it adult or the poster is NSFW', async () => {
		const adult = await finished({length: 20, category: 'Adult'});
		const untouched = mediaProxy();
		expect(
			(await scannerFor(adult.client, untouched).scan(adult.video, adult.files, {taggingPending: false})).verdict,
		).toBe('nsfw');
		expect(untouched.getMetadata).not.toHaveBeenCalled();

		const poster = await finished({length: 20});
		const posterOnly = mediaProxy((name) => (name === 'poster' ? {nsfw: true, nsfw_probability: 0.97} : {}));
		expect(
			(await scannerFor(poster.client, posterOnly).scan(poster.video, poster.files, {taggingPending: false})).verdict,
		).toBe('nsfw');
		expect(
			decideVideo({
				frames: [
					{source: 'poster', nsfw: true, probability: 0.9},
					{source: 'tile', nsfw: false, probability: 0.1},
				],
				unreadable: false,
				category: null,
			}),
		).toBe('nsfw');
	});

	it('needs two NSFW frames otherwise', async () => {
		const one = await finished({length: 20});
		const single = mediaProxy((name) => (name === 'thumbnail_1' ? {nsfw: true, nsfw_probability: 0.95} : {}));
		expect(await scannerFor(one.client, single).scan(one.video, one.files, {taggingPending: false})).toMatchObject({
			verdict: 'clean',
			over: 1,
			maxProbability: 0.95,
		});

		const two = await finished({length: 20});
		const double = mediaProxy((name) =>
			name === 'thumbnail_1' || name === 'thumbnail_2' ? {nsfw: true, nsfw_probability: 0.95} : {},
		);
		expect(await scannerFor(two.client, double).scan(two.video, two.files, {taggingPending: false})).toMatchObject({
			verdict: 'nsfw',
			over: 2,
		});
		expect(
			decideVideo({frames: [{source: 'tile', nsfw: true, probability: 0.8}], unreadable: false, category: null}),
		).toBe('nsfw');
		expect(
			decideVideo({
				frames: [{source: 'tile', nsfw: true, probability: 0.8}],
				unreadable: true,
				category: null,
			}),
		).toBe('inconclusive');
	});

	it('sends frames as base64 no larger than 512 px with nsfw flag and never a url', async () => {
		const {guid, client, video, files} = await finished({length: 40, width: 3840, height: 2160});
		fakeBunnyStream.setFile(guid, 'thumbnail_3.jpg', await jpeg(3840, 2160, '#c0c030'));
		const media = mediaProxy();
		await scannerFor(client, media).scan(video, files, {taggingPending: false});
		expect(media.requests.length).toBeGreaterThan(6);
		for (const request of media.requests) {
			expect(request).toMatchObject({type: 'base64', nsfw: 'flag'});
			expect(request).not.toHaveProperty('url');
			const base64 = (request as {base64: string}).base64;
			const {width = 0, height = 0, format} = await sharp(Buffer.from(base64, 'base64')).metadata();
			expect(format).toBe('jpeg');
			expect(Math.max(width, height)).toBeLessThanOrEqual(512);
		}
		expect(JSON.stringify(media.requests)).not.toContain(BUNNY_TEST_SETTINGS.storageHost);
	});
});
