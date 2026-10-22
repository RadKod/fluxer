// SPDX-License-Identifier: AGPL-3.0-or-later

// Jam mode's instrument samples: hosted next to the song library on sanalyer.com (static nginx, CORS open), fetched
// when a jam starts and kept in Cache Storage, so a device downloads the ~2 MB once per set version. The folder is
// produced by sanalyer.com's scripts/sarkilar/dogaclama-paketle.py; a new set goes to a new version folder.
//
// Ogg Opus is used where it decodes (Chromium and Electron, Firefox, Safari from 18.4 / macOS 15.4 / iOS 18.4);
// older Safari gets MP3. The first file decides: if it does not decode as Opus, the whole set loads as MP3.
// Every decoded buffer is cut to 1 ms before its onset, which removes encoder delay (MP3 priming, or a decoder that
// ignores Opus pre-skip) whatever the format.

import {bakePinch, bakeSustainLoop, feedbackNorm, reverbImpulse} from '@app/features/activities/band/jam/JamBake';
import {leadingSilenceFrames} from '@app/features/activities/band/jam/JamDsp';
import {FEEDBACK, midiToHz, PINCH_HARMONIC, PINCH_METHOD} from '@app/features/activities/band/jam/JamTechniques';
import {nearestSample} from '@app/features/activities/band/jam/JamVoices';
import {Logger} from '@app/features/platform/utils/AppLogger';

const logger = new Logger('JamAssets');

export const JAM_ASSET_BASE_URL = 'https://sanalyer.com/sarkilar/dogaclama/v1/';
const MANIFEST_FILE = 'manifest.json';
const CACHE_NAME = 'band-jam-v1';
const PARALLEL_DOWNLOADS = 6;
// Smallest file of the set; decoding it tells whether the browser takes the format.
const PROBE = {group: 'davul', key: 'hh_kapali'} as const;

export const JAM_SAMPLE_GROUPS = ['gitar_temiz', 'gitar_di', 'gitar_guc', 'bas', 'klavye', 'davul'] as const;
export type JamSampleGroup = (typeof JAM_SAMPLE_GROUPS)[number];
export const JAM_ASSET_FORMATS = ['opus', 'mp3'] as const;
export type JamAssetFormat = (typeof JAM_ASSET_FORMATS)[number];

const FORMAT_MIME: Readonly<Record<JamAssetFormat, string>> = {
	opus: 'audio/ogg; codecs="opus"',
	mp3: 'audio/mpeg',
};

export interface JamManifest {
	readonly version: number;
	readonly groups: Readonly<Record<JamSampleGroup, ReadonlyArray<number | string>>>;
	// Path template per format, `{name}` standing for <group>_<key>.
	readonly formats: Readonly<Partial<Record<JamAssetFormat, string>>>;
}

export function parseJamManifest(json: unknown): JamManifest {
	if (typeof json !== 'object' || json === null) throw new TypeError('Jam manifest is not an object');
	const {version, groups, formats} = json as {version?: unknown; groups?: unknown; formats?: unknown};
	if (typeof version !== 'number') throw new TypeError('Jam manifest has no version');
	if (typeof groups !== 'object' || groups === null) throw new TypeError('Jam manifest has no groups');
	if (typeof formats !== 'object' || formats === null) throw new TypeError('Jam manifest has no formats');
	const parsedGroups = {} as Record<JamSampleGroup, ReadonlyArray<number | string>>;
	for (const group of JAM_SAMPLE_GROUPS) {
		const keys = (groups as Record<string, unknown>)[group];
		if (!Array.isArray(keys) || keys.length === 0) throw new TypeError(`Jam manifest has no ${group} samples`);
		for (const key of keys) {
			const ok = group === 'davul' ? typeof key === 'string' : Number.isInteger(key);
			if (!ok) throw new TypeError(`Jam manifest has a bad ${group} key`);
		}
		parsedGroups[group] = keys as ReadonlyArray<number | string>;
	}
	const parsedFormats: Partial<Record<JamAssetFormat, string>> = {};
	for (const format of JAM_ASSET_FORMATS) {
		const template = (formats as Record<string, unknown>)[format];
		if (typeof template === 'string' && template.includes('{name}')) parsedFormats[format] = template;
	}
	return {version, groups: parsedGroups, formats: parsedFormats};
}

// Formats to try, best first. canPlayType speaks for the media element, not decodeAudioData, so a "maybe" is only
// a reason to try; the probe decode has the final word.
export function candidateFormats(
	manifest: JamManifest,
	canPlayType: ((mime: string) => string) | null,
): ReadonlyArray<JamAssetFormat> {
	return JAM_ASSET_FORMATS.filter(
		(format) =>
			manifest.formats[format] !== undefined &&
			(format === 'mp3' || canPlayType === null || canPlayType(FORMAT_MIME[format]) !== ''),
	);
}

export function jamAssetUrl(
	baseUrl: string,
	manifest: JamManifest,
	format: JamAssetFormat,
	group: JamSampleGroup,
	key: number | string,
): string {
	const template = manifest.formats[format];
	if (!template) throw new RangeError(`Jam set has no ${format} files`);
	return new URL(template.replace('{name}', `${group}_${key}`), baseUrl).toString();
}

export interface LeadSample {
	readonly sustain: AudioBuffer;
	readonly loopStart: number;
	readonly loopEnd: number;
	// Pinch buffers by harmonic, baked on first use (the default harmonic at load).
	readonly pinch: Map<number, AudioBuffer>;
	// Band-pass gain that brings the feedback harmonic to the note's level.
	readonly feedbackNorm: number;
}

// Decoded and baked samples, shared by every player's instruments on one AudioContext.
export interface JamSampleBank {
	readonly format: JamAssetFormat;
	readonly buffers: ReadonlyMap<JamSampleGroup, ReadonlyMap<number | string, AudioBuffer>>;
	readonly lead: ReadonlyMap<number, LeadSample>;
	readonly reverb: AudioBuffer;
}

export function sampleKeys(bank: JamSampleBank, group: Exclude<JamSampleGroup, 'davul'>): ReadonlyArray<number> {
	return [...(bank.buffers.get(group)?.keys() ?? [])].filter((key): key is number => typeof key === 'number');
}

export function trimLeadingSilence(context: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
	const channels = Array.from({length: buffer.numberOfChannels}, (_, c) => buffer.getChannelData(c));
	const start = leadingSilenceFrames(channels, buffer.sampleRate);
	if (start === 0) return buffer;
	const trimmed = context.createBuffer(buffer.numberOfChannels, buffer.length - start, buffer.sampleRate);
	channels.forEach((data, c) => trimmed.copyToChannel(data.subarray(start), c));
	return trimmed;
}

function monoBuffer(context: BaseAudioContext, data: Float32Array<ArrayBuffer>): AudioBuffer {
	const buffer = context.createBuffer(1, Math.max(1, data.length), context.sampleRate);
	buffer.copyToChannel(data, 0);
	return buffer;
}

// Lets the page breathe between the heavier bakes.
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function diSignals(bank: Pick<JamSampleBank, 'buffers'>): Map<number, Float32Array> {
	const signals = new Map<number, Float32Array>();
	for (const [key, buffer] of bank.buffers.get('gitar_di') ?? []) {
		if (typeof key === 'number') signals.set(key, buffer.getChannelData(0));
	}
	return signals;
}

function bakePinchBuffer(
	context: BaseAudioContext,
	signals: ReadonlyMap<number, Float32Array>,
	key: number,
	harmonic: number,
): AudioBuffer {
	const keys = [...signals.keys()];
	const nearest = (midi: number) => {
		const choice = nearestSample(keys, midi).key;
		return {midi: choice, signal: signals.get(choice) ?? new Float32Array(0)};
	};
	const signal = signals.get(key) ?? new Float32Array(0);
	return monoBuffer(context, bakePinch(PINCH_METHOD, {midi: key, signal}, nearest, context.sampleRate, harmonic));
}

// The pinch buffer of one lead sample for a harmonic; other than the default it is baked when first played.
export function leadPinchBuffer(
	context: BaseAudioContext,
	bank: JamSampleBank,
	key: number,
	harmonic: number,
): AudioBuffer | null {
	const lead = bank.lead.get(key);
	if (!lead) return null;
	let buffer = lead.pinch.get(harmonic);
	if (!buffer) {
		buffer = bakePinchBuffer(context, diSignals(bank), key, harmonic);
		lead.pinch.set(harmonic, buffer);
	}
	return buffer;
}

async function bakeLead(
	context: BaseAudioContext,
	bank: Pick<JamSampleBank, 'buffers'>,
): Promise<Map<number, LeadSample>> {
	const signals = diSignals(bank);
	const lead = new Map<number, LeadSample>();
	for (const [key, signal] of signals) {
		const f0 = midiToHz(key);
		const loop = bakeSustainLoop(signal, context.sampleRate, f0);
		lead.set(key, {
			sustain: monoBuffer(context, loop.buffer),
			loopStart: loop.loopStart / context.sampleRate,
			loopEnd: loop.loopEnd / context.sampleRate,
			pinch: new Map([[PINCH_HARMONIC, bakePinchBuffer(context, signals, key, PINCH_HARMONIC)]]),
			feedbackNorm: feedbackNorm(loop, context.sampleRate, f0, FEEDBACK.harmonic),
		});
		await yieldToEventLoop();
	}
	return lead;
}

function reverbBuffer(context: BaseAudioContext): AudioBuffer {
	const [left, right] = reverbImpulse(context.sampleRate);
	const buffer = context.createBuffer(2, left.length, context.sampleRate);
	buffer.copyToChannel(left, 0);
	buffer.copyToChannel(right, 1);
	return buffer;
}

export interface JamAssetLoadOptions {
	readonly baseUrl?: string;
	readonly signal?: AbortSignal;
	// Files decoded so far and the total.
	readonly onProgress?: (done: number, total: number) => void;
}

async function fetchBytes(url: string, cache: Cache | null, signal?: AbortSignal): Promise<ArrayBuffer> {
	const cached = await cache?.match(url).catch(() => undefined);
	if (cached) return cached.arrayBuffer();
	const response = await fetch(url, {signal});
	if (!response.ok) throw new Error(`Jam sample ${url} answered ${response.status}`);
	if (cache) {
		cache.put(url, response.clone()).catch((error: unknown) => logger.debug('Jam sample not cached', {url, error}));
	}
	return response.arrayBuffer();
}

async function openCache(): Promise<Cache | null> {
	if (typeof caches === 'undefined') return null;
	try {
		return await caches.open(CACHE_NAME);
	} catch (error) {
		logger.debug('Cache Storage unavailable for jam samples', error);
		return null;
	}
}

async function mapLimited<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<Array<R>> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index]);
		}
	};
	await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
	return results;
}

export async function loadJamSamples(
	context: BaseAudioContext,
	{baseUrl = JAM_ASSET_BASE_URL, signal, onProgress}: JamAssetLoadOptions = {},
): Promise<JamSampleBank> {
	const manifestResponse = await fetch(new URL(MANIFEST_FILE, baseUrl), {cache: 'no-cache', signal});
	if (!manifestResponse.ok) throw new Error(`Jam manifest answered ${manifestResponse.status}`);
	const manifest = parseJamManifest(await manifestResponse.json());
	const cache = await openCache();
	const decode = async (format: JamAssetFormat, group: JamSampleGroup, key: number | string) => {
		const bytes = await fetchBytes(jamAssetUrl(baseUrl, manifest, format, group, key), cache, signal);
		return trimLeadingSilence(context, await context.decodeAudioData(bytes));
	};

	const canPlayType =
		typeof document === 'undefined' ? null : (mime: string) => document.createElement('audio').canPlayType(mime);
	let format: JamAssetFormat | null = null;
	let probe: AudioBuffer | null = null;
	for (const candidate of candidateFormats(manifest, canPlayType)) {
		try {
			probe = await decode(candidate, PROBE.group, PROBE.key);
			format = candidate;
			break;
		} catch (error) {
			if (signal?.aborted) throw error;
			logger.info('Jam samples: format not decodable, trying the next', {format: candidate, error});
		}
	}
	if (!format || !probe) throw new Error('No jam sample format decodes here');

	const files = JAM_SAMPLE_GROUPS.flatMap((group) => manifest.groups[group].map((key) => ({group, key})));
	let done = 0;
	onProgress?.(done, files.length);
	const chosen = format;
	const decoded = await mapLimited(files, PARALLEL_DOWNLOADS, async ({group, key}) => {
		const buffer = group === PROBE.group && key === PROBE.key && probe ? probe : await decode(chosen, group, key);
		onProgress?.(++done, files.length);
		return {group, key, buffer};
	});
	const buffers = new Map<JamSampleGroup, Map<number | string, AudioBuffer>>();
	for (const {group, key, buffer} of decoded) {
		let entries = buffers.get(group);
		if (!entries) {
			entries = new Map();
			buffers.set(group, entries);
		}
		entries.set(key, buffer);
	}
	const lead = await bakeLead(context, {buffers});
	return {format, buffers, lead, reverb: reverbBuffer(context)};
}
