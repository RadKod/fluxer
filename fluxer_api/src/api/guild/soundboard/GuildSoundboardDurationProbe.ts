// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Logger} from '@app/api/Logger';
import {isJsonRecord} from '@app/api/utils/JsonBoundaryUtils';
import {SOUNDBOARD_MAX_DURATION_MS, SOUNDBOARD_MAX_SIZE_BYTES} from '@fluxer/constants/src/SoundboardConstants';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 5000;
let activeProbes = 0;

export async function resolveGuildSoundboardDurationMs(params: {
	bytes: Buffer;
	extension: 'mp3' | 'ogg';
	metadataDurationSeconds: number | null;
}): Promise<number | null> {
	if (params.bytes.length === 0 || params.bytes.length > SOUNDBOARD_MAX_SIZE_BYTES) return null;
	if (activeProbes >= 2) throw new ServiceUnavailableError();
	activeProbes++;
	let directory: string | undefined;
	try {
		directory = await fs.mkdtemp(path.join(tmpdir(), 'guild-soundboard-'));
		const input = path.join(directory, `sound.${params.extension}`);
		await fs.writeFile(input, params.bytes);
		const stdout = await probe(input, params.extension);
		const output: unknown = JSON.parse(stdout);
		return durationMs(output, params.extension, params.metadataDurationSeconds);
	} catch (error) {
		Logger.warn({error}, 'Soundboard audio probe failed');
		return null;
	} finally {
		try {
			if (directory) await fs.rm(directory, {recursive: true, force: true});
		} finally {
			activeProbes--;
		}
	}
}

function probe(input: string, extension: 'mp3' | 'ogg'): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'ffprobe',
			[
				'-v',
				'error',
				'-protocol_whitelist',
				'file',
				'-f',
				extension,
				'-show_frames',
				'-show_entries',
				'frame=nb_samples:stream=codec_type,codec_name,channels,sample_rate,duration,initial_padding:format=format_name,duration',
				'-of',
				'json',
				input,
			],
			{stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true},
		);
		let failure: Error | undefined;
		let bytes = 0;
		let hasErrors = false;
		const chunks: Array<Buffer> = [];
		const stop = (error: Error) => {
			failure ??= error;
			child.kill('SIGKILL');
		};
		const timer = setTimeout(() => stop(new Error('Soundboard probe timed out')), TIMEOUT_MS);
		const receive = (chunk: Buffer, stderr: boolean) => {
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES) {
				stop(new Error('Soundboard probe output limit exceeded'));
				return;
			}
			if (stderr) hasErrors = true;
			else chunks.push(chunk);
		};
		child.stdout.on('data', (chunk: Buffer) => receive(chunk, false));
		child.stderr.on('data', (chunk: Buffer) => receive(chunk, true));
		child.on('error', (error) => {
			failure ??= error;
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (failure || code !== 0 || hasErrors) reject(failure ?? new Error('Soundboard probe rejected audio'));
			else resolve(Buffer.concat(chunks).toString('utf8'));
		});
	});
}

function positiveNumber(value: unknown): number | null {
	if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

function durationMs(output: unknown, extension: 'mp3' | 'ogg', metadata: number | null): number | null {
	if (!isJsonRecord(output) || !Array.isArray(output.streams) || output.streams.length !== 1) return null;
	const stream: unknown = output.streams[0];
	const format = output.format;
	if (!isJsonRecord(stream) || !isJsonRecord(format)) return null;
	if (stream.codec_type !== 'audio' || format.format_name !== extension) return null;
	if (extension === 'mp3' ? stream.codec_name !== 'mp3' : !['opus', 'vorbis'].includes(String(stream.codec_name)))
		return null;
	if (stream.channels !== 1 && stream.channels !== 2) return null;
	const sampleRate = positiveNumber(stream.sample_rate);
	const streamDuration = positiveNumber(stream.duration);
	const formatDuration = positiveNumber(format.duration);
	if (!sampleRate || !Number.isInteger(sampleRate) || sampleRate > 48000) return null;
	if (!streamDuration || !formatDuration || Math.abs(streamDuration - formatDuration) > 0.000001) return null;
	if (!Array.isArray(output.frames) || output.frames.length === 0) return null;
	let samples = 0;
	for (const frame of output.frames) {
		if (
			!isJsonRecord(frame) ||
			typeof frame.nb_samples !== 'number' ||
			!Number.isSafeInteger(frame.nb_samples) ||
			frame.nb_samples <= 0
		)
			return null;
		samples += frame.nb_samples;
		if (!Number.isSafeInteger(samples)) return null;
	}
	const decodedDuration = samples / sampleRate;
	let preSkip = 0;
	if (stream.codec_name === 'opus') {
		if (
			sampleRate !== 48000 ||
			typeof stream.initial_padding !== 'number' ||
			!Number.isSafeInteger(stream.initial_padding) ||
			stream.initial_padding < 0 ||
			stream.initial_padding > 65535
		)
			return null;
		preSkip = stream.initial_padding / 48000;
	}
	// Ogg Opus granules include the header's pre-skip; decoded frames already exclude it.
	if (Math.abs(decodedDuration + preSkip - streamDuration) > 1 / sampleRate + 0.000001) return null;
	const duration =
		stream.codec_name === 'opus' ? decodedDuration : Math.max(streamDuration, formatDuration, decodedDuration);
	if (duration > SOUNDBOARD_MAX_DURATION_MS / 1000) return null;
	// Media metadata is rounded up to whole seconds by the existing media service.
	if (metadata !== null && (!Number.isFinite(metadata) || metadata !== Math.ceil(formatDuration))) return null;
	return Math.ceil(duration * 1000);
}
