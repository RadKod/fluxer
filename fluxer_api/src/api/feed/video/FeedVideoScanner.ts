// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomInt as cryptoRandomInt} from 'node:crypto';
import type {BunnyStorageEntry, BunnyStreamClient, BunnyVideo} from '@app/api/feed/video/BunnyStreamClient';
import {type IMediaService, mediaProxyMetadataPolicy} from '@app/api/infrastructure/IMediaService';
import {Logger} from '@app/api/Logger';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import sharp from 'sharp';

export const FEED_VIDEO_MAX_FRAMES = 60;
export const FEED_VIDEO_THUMBNAILS = [
	'thumbnail.jpg',
	'thumbnail_1.jpg',
	'thumbnail_2.jpg',
	'thumbnail_3.jpg',
	'thumbnail_4.jpg',
	'thumbnail_5.jpg',
];
export const SEEK_PER_SHEET = 36;
export const MIN_TILE = {width: 128, height: 72};
export const TAGGING_GRACE_MS = 30 * 60_000;
export const FEED_VIDEO_EVIDENCE_MAX_BYTES = 2 * 1024 ** 3;

const POSTER = 'thumbnail.jpg';
const SHEET_COLUMNS = 6;
const ASPECT_TOLERANCE = 0.05;
const THUMBNAIL_MAX_BYTES = 16 * 1024 * 1024;
const SHEET_MAX_BYTES = 8 * 1024 * 1024;
const FRAME_EDGE = 512;
const CONCURRENCY = 4;
const MASTER_VARIANT_PATTERN = /^(\d{3,4}p)\/video\.m3u8$/;
const SEGMENT_PATTERN = /^video\d+\.ts$/;
const RESOLUTION_PATTERN = /RESOLUTION=(\d+)x(\d+)/;
const LINE_BREAK = /\r?\n/;

export type FrameVerdict = 'clean' | 'nsfw' | 'inconclusive' | 'layout';

interface Size {
	width: number;
	height: number;
}

interface Tile {
	tileW: number;
	tileH: number;
}

export interface FeedVideoScanResult {
	verdict: FrameVerdict;
	frames: number;
	over: number;
	maxProbability: number;
	tile: {w: number; h: number} | null;
	reason?: string;
}

/** Up to `budget` seek frames at an even step from a random start below one step (every frame of a short video). */
export function planSeekFrames(
	seekFrames: number,
	budget: number,
	randomInt: (max: number) => number,
): Array<{frame: number; sheet: number; slot: number}> {
	if (seekFrames <= 0) return [];
	const step = Math.max(1, seekFrames / budget);
	const offset = randomInt(Math.floor(step * 1000)) / 1000;
	const frames = new Set<number>();
	for (let index = 0; index < budget; index++) {
		const frame = Math.floor(offset + index * step);
		if (frame >= seekFrames) break;
		frames.add(frame);
	}
	return [...frames].map((frame) => ({
		frame,
		sheet: Math.floor(frame / SEEK_PER_SHEET),
		slot: frame % SEEK_PER_SHEET,
	}));
}

/** The picture as shown: Bunny's width and height are before rotation, its images after (rotation is signed). */
export function displaySize(video: {width: number; height: number; rotation: number | null}): Size {
	return Math.abs(video.rotation ?? 0) % 180 === 90
		? {width: video.height, height: video.width}
		: {width: video.width, height: video.height};
}

// Either orientation, so a wrong rotation reading cannot fail a video on its own.
function aspectOk(tile: Tile, display: Size): boolean {
	const ratio = tile.tileW / tile.tileH;
	const aspect = display.width / display.height;
	return (
		Math.abs(ratio - aspect) <= ASPECT_TOLERANCE * aspect || Math.abs(ratio - 1 / aspect) <= ASPECT_TOLERANCE / aspect
	);
}

function tileFits(tile: Tile, display: Size): boolean {
	return aspectOk(tile, display) && tile.tileW >= MIN_TILE.width && tile.tileH >= MIN_TILE.height;
}

/**
 * A sheet's 6×6 tile, or null for a layout the scanner cannot trust. Every sheet is the whole 6×6 canvas, the last,
 * partly filled one too (Bunny: 1800×3198 for 15 of 36 frames), so frame k sits in cell k mod 36.
 */
export function fullSheetTile(sheet: Size, display: Size): Tile | null {
	if (sheet.width % SHEET_COLUMNS !== 0 || sheet.height % SHEET_COLUMNS !== 0) return null;
	const tile = {tileW: sheet.width / SHEET_COLUMNS, tileH: sheet.height / SHEET_COLUMNS};
	return tileFits(tile, display) ? tile : null;
}

/** The renditions of a Bunny master playlist: each `<res>/video.m3u8` directory with its pixel count. */
export function parseMasterPlaylist(text: string): Array<{path: string; pixels: number}> {
	const lines = text.split(LINE_BREAK).map((line) => line.trim());
	const variants: Array<{path: string; pixels: number}> = [];
	for (const [index, line] of lines.entries()) {
		if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
		const resolution = RESOLUTION_PATTERN.exec(line);
		const uri = MASTER_VARIANT_PATTERN.exec(lines[index + 1] ?? '');
		if (!resolution || !uri) throw new Error('Unexpected HLS master playlist');
		variants.push({path: uri[1]!, pixels: Number(resolution[1]) * Number(resolution[2])});
	}
	if (variants.length === 0) throw new Error('HLS master playlist has no renditions');
	return variants;
}

/** A rendition's segment names in play order; anything but `video<N>.ts` (or a byte range) is refused. */
export function parseMediaPlaylist(text: string): Array<string> {
	const segments: Array<string> = [];
	for (const line of text.split(LINE_BREAK).map((entry) => entry.trim())) {
		if (line.startsWith('#EXT-X-BYTERANGE')) throw new Error('HLS byte ranges are not expected');
		if (line === '' || line.startsWith('#')) continue;
		if (!SEGMENT_PATTERN.test(line)) throw new Error('Unexpected HLS segment name');
		segments.push(line);
	}
	if (segments.length === 0) throw new Error('HLS media playlist has no segments');
	return segments;
}

export function isAdultCategory(category: string | null): boolean {
	return category?.toLowerCase() === 'adult';
}

/** Fail closed: anything unread, unscored or all-zero is inconclusive, never clean. */
export function decideVideo(input: {
	frames: Array<{source: 'poster' | 'thumbnail' | 'tile'; nsfw: boolean; probability: number}>;
	unreadable: boolean;
	category: string | null;
}): FrameVerdict {
	const {frames} = input;
	if (input.unreadable) return 'inconclusive';
	if (isAdultCategory(input.category)) return 'nsfw';
	// Every probability exactly 0 is what the media proxy answers with NSFW scanning off.
	if (frames.length === 0 || frames.every((frame) => frame.probability === 0)) return 'inconclusive';
	if (frames.some((frame) => frame.source === 'poster' && frame.nsfw)) return 'nsfw';
	const over = frames.filter((frame) => frame.nsfw).length;
	return over >= (frames.length >= 2 ? 2 : 1) ? 'nsfw' : 'clean';
}

interface Frame {
	source: 'poster' | 'thumbnail' | 'tile';
	jpeg: Buffer;
}

async function encodeFrame(image: ReturnType<typeof sharp>, source: Frame['source']): Promise<Frame> {
	const jpeg = await image
		.resize({width: FRAME_EDGE, height: FRAME_EDGE, fit: 'inside', withoutEnlargement: true})
		.jpeg({quality: 85})
		.toBuffer();
	return {source, jpeg};
}

interface FeedVideoScannerDeps {
	client: Pick<BunnyStreamClient, 'listFiles' | 'readFile'>;
	media: Pick<IMediaService, 'getMetadata'>;
	randomInt?: (max: number) => number;
}

/**
 * NSFW frames of a finished Bunny video, read from its Storage zone (a configured host and a checked GUID, so no
 * token, referer or SSRF surface) and sent to the media proxy as base64 only. Budget: the poster, thumbnails 1-5 and
 * 54 seek tiles. TEMPORARY: sprite tiles are small; path: N frames by seek in the media proxy (Rust); trigger:
 * `layout` failures or `sheet_canvas` inconclusive scans above 0.5 % of videos, or an NSFW miss in the live sample set.
 */
export class FeedVideoScanner {
	private readonly randomInt: (max: number) => number;

	constructor(private readonly deps: FeedVideoScannerDeps) {
		this.randomInt = deps.randomInt ?? ((max) => cryptoRandomInt(max));
	}

	async scan(
		video: BunnyVideo,
		files: Array<BunnyStorageEntry>,
		o: {taggingPending: boolean},
	): Promise<FeedVideoScanResult> {
		const result = await this.scanFrames(video, files);
		Logger.info(
			{
				guid: video.guid,
				verdict: result.verdict,
				frames: result.frames,
				over: result.over,
				maxProbability: result.maxProbability,
				tile: result.tile,
				reason: result.reason,
				...(o.taggingPending ? {content_tagging: 'missing'} : {}),
			},
			'Feed video scanned',
		);
		return result;
	}

	private async scanFrames(video: BunnyVideo, files: Array<BunnyStorageEntry>): Promise<FeedVideoScanResult> {
		const empty = {frames: 0, over: 0, maxProbability: 0, tile: null};
		if (isAdultCategory(video.category)) return {...empty, verdict: 'nsfw', reason: 'adult_category'};
		const listed = new Set(files.filter((file) => !file.isDirectory).map((file) => file.name));
		if (!listed.has(POSTER)) return {...empty, verdict: 'inconclusive', reason: 'poster_missing'};

		const display = displaySize(video);
		const seekFrames = video.thumbnailCount;
		const plan = planSeekFrames(seekFrames, FEED_VIDEO_MAX_FRAMES - FEED_VIDEO_THUMBNAILS.length, this.randomInt);
		const sheets = [...new Set(plan.map((entry) => entry.sheet))];
		const thumbnails = FEED_VIDEO_THUMBNAILS.filter((name) => listed.has(name));

		let unreadable = false;
		const read = async (path: string, maxBytes: number): Promise<Buffer | null> => {
			try {
				const bytes = await this.deps.client.readFile(video.guid, path, maxBytes);
				if (bytes === null) unreadable = true;
				return bytes;
			} catch {
				unreadable = true;
				return null;
			}
		};
		// Every frame is cut and encoded before any NSFW call, one small JPEG each, so a scan holds at most CONCURRENCY
		// decoded sheets at a time and an unreadable or badly laid out sheet costs no media proxy call.
		const frames: Array<Frame> = [];
		const cutThumbnail = async (name: string): Promise<Array<Frame>> => {
			const bytes = await read(name, THUMBNAIL_MAX_BYTES);
			return bytes ? [await encodeFrame(sharp(bytes), name === POSTER ? 'poster' : 'thumbnail')] : [];
		};
		// Set inside cutSheet; the cast keeps TypeScript from narrowing it to null here.
		let tile = null as Tile | null;
		let layoutFailed = false;
		let canvasMissed = false;
		const cutSheet = async (sheet: number): Promise<Array<Frame>> => {
			const bytes = await read(`seek/_${sheet}.jpg`, SHEET_MAX_BYTES);
			if (!bytes) return [];
			const pixels = await sharp(bytes).raw().toBuffer({resolveWithObject: true});
			const sheetTile = fullSheetTile({width: pixels.info.width, height: pixels.info.height}, display);
			if (!sheetTile) {
				// A full sheet off the grid fails the video; the last one is inconclusive, never skipped, so no video
				// is judged on its thumbnails alone.
				if (seekFrames - sheet * SEEK_PER_SHEET >= SEEK_PER_SHEET) layoutFailed = true;
				else canvasMissed = true;
				return [];
			}
			tile ??= sheetTile;
			const cut: Array<Frame> = [];
			// Only planned frames, all below thumbnailCount: the empty cells of the last sheet are never read.
			for (const entry of plan.filter((planned) => planned.sheet === sheet)) {
				const region = {
					left: (entry.slot % SHEET_COLUMNS) * sheetTile.tileW,
					top: Math.floor(entry.slot / SHEET_COLUMNS) * sheetTile.tileH,
					width: sheetTile.tileW,
					height: sheetTile.tileH,
				};
				cut.push(await encodeFrame(sharp(pixels.data, {raw: pixels.info}).extract(region), 'tile'));
			}
			return cut;
		};
		try {
			const tiles = await mapWithConcurrency(sheets, CONCURRENCY, cutSheet);
			frames.push(...(await mapWithConcurrency(thumbnails, CONCURRENCY, cutThumbnail)).flat(), ...tiles.flat());
		} catch {
			unreadable = true;
		}
		if (layoutFailed) return {...empty, verdict: 'layout', reason: 'layout'};
		if (unreadable) return {...empty, verdict: 'inconclusive', reason: 'unreadable'};
		if (canvasMissed) return {...empty, verdict: 'inconclusive', reason: 'sheet_canvas'};

		const scored = await mapWithConcurrency(frames, CONCURRENCY, async (frame) => {
			try {
				const answer = await this.deps.media.getMetadata({
					type: 'base64',
					base64: frame.jpeg.toString('base64'),
					...mediaProxyMetadataPolicy('flag'),
				});
				if (answer === null) unreadable = true;
				return {source: frame.source, nsfw: answer?.nsfw === true, probability: answer?.nsfw_probability ?? 0};
			} catch {
				unreadable = true;
				return {source: frame.source, nsfw: false, probability: 0};
			}
		});
		const over = scored.filter((frame) => frame.nsfw).length;
		const verdict = decideVideo({frames: scored, unreadable, category: video.category});
		return {
			verdict,
			frames: scored.length,
			over,
			maxProbability: Math.max(0, ...scored.map((frame) => frame.probability)),
			tile: tile ? {w: tile.tileW, h: tile.tileH} : null,
			...(unreadable ? {reason: 'unreadable'} : {}),
		};
	}
}
