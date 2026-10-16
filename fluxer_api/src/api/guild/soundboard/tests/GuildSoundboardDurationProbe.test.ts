// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ChildProcess, execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {Logger} from '@app/api/Logger';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const probe = vi.hoisted(() => {
	vi.resetModules();
	return {real: false, script: '', stderr: '', paths: [] as Array<string>, children: [] as Array<ChildProcess>};
});
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: vi.fn((_command: string, args: Array<string>) => {
			probe.paths.push(args.at(-1)!);
			const child = probe.real
				? actual.spawn('ffprobe', args, {stdio: ['ignore', 'pipe', 'pipe']})
				: actual.spawn(process.execPath, ['-e', probe.script], {stdio: ['ignore', 'pipe', 'pipe']});
			probe.children.push(child);
			child.stderr.on('data', (chunk) => {
				probe.stderr += chunk.toString();
			});
			return child;
		}),
	};
});
vi.mock('@app/api/Logger', () => ({Logger: {warn: vi.fn()}}));

import {resolveGuildSoundboardDurationMs} from '../GuildSoundboardDurationProbe';

function output(duration = '10.0') {
	return {
		frames: [{nb_samples: Math.ceil(Number(duration) * 48000)}],
		streams: [
			{codec_type: 'audio', codec_name: 'mp3', channels: 2, sample_rate: '48000', duration, initial_padding: 0},
		],
		format: {format_name: 'mp3', duration},
	};
}
function emit(value: unknown) {
	probe.script = `process.stdout.write(${JSON.stringify(JSON.stringify(value))})`;
}
function resolve(
	bytes = Buffer.alloc(1_000_000),
	extension: 'mp3' | 'ogg' = 'mp3',
	metadataDurationSeconds: number | null = 10,
) {
	return resolveGuildSoundboardDurationMs({bytes, extension, metadataDurationSeconds});
}

describe('GuildSoundboardDurationProbe', () => {
	beforeEach(() => {
		probe.real = false;
		probe.stderr = '';
		vi.mocked(Logger.warn).mockClear();
		probe.paths = [];
		probe.children = [];
		emit(output());
	});
	afterEach(async () => {
		for (const child of probe.children) {
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		}
		for (const path of probe.paths) {
			await expect(fs.stat(path)).rejects.toMatchObject({code: 'ENOENT'});
		}
	});
	it('accepts 1000000 bytes and exactly 10 seconds', async () => {
		const result = await resolve();
		expect(probe.stderr).toBe('');
		expect(vi.mocked(Logger.warn).mock.calls).toEqual([]);
		expect(result).toBe(10000);
	});
	it.skipIf(spawnSync('ffmpeg', ['-version'], {windowsHide: true}).status !== 0).each([
		['10', 10000],
		['10.0001', null],
	])('validates actual Ogg audio lasting %s seconds', async (duration, expected) => {
		const bytes = execFileSync(
			'ffmpeg',
			[
				'-v',
				'error',
				'-f',
				'lavfi',
				'-i',
				'anullsrc=r=48000:cl=stereo',
				'-t',
				String(duration),
				'-c:a',
				'libvorbis',
				'-f',
				'ogg',
				'pipe:1',
			],
			{windowsHide: true, timeout: 5000},
		);
		probe.real = true;
		await expect(resolve(bytes, 'ogg')).resolves.toBe(expected);
	});
	it.skipIf(spawnSync('ffmpeg', ['-version'], {windowsHide: true}).status !== 0)(
		'validates actual MP3 audio',
		async () => {
			const bytes = execFileSync(
				'ffmpeg',
				[
					'-v',
					'error',
					'-f',
					'lavfi',
					'-i',
					'anullsrc=r=48000:cl=stereo',
					'-t',
					'5',
					'-c:a',
					'libmp3lame',
					'-f',
					'mp3',
					'pipe:1',
				],
				{windowsHide: true, timeout: 5000},
			);
			probe.real = true;
			const duration = await resolve(bytes, 'mp3', 6);
			expect(duration).toBeGreaterThanOrEqual(5000);
			expect(duration).toBeLessThanOrEqual(5200);
		},
	);
	it.skipIf(spawnSync('ffmpeg', ['-version'], {windowsHide: true}).status !== 0).each([
		// The container duration includes the 6.5 ms Opus pre-skip, so the rounded metadata is one higher.
		['5', 5000, 6],
		['10', 10000, 11],
		['10.0001', null, 11],
	])('validates actual Opus audio lasting %s seconds with decoder pre-skip', async (duration, expected, metadata) => {
		const bytes = execFileSync(
			'ffmpeg',
			[
				'-v',
				'error',
				'-f',
				'lavfi',
				'-i',
				'anullsrc=r=48000:cl=stereo',
				'-t',
				String(duration),
				'-c:a',
				'libopus',
				'-f',
				'ogg',
				'pipe:1',
			],
			{windowsHide: true, timeout: 5000},
		);
		probe.real = true;
		await expect(resolve(bytes, 'ogg', metadata)).resolves.toBe(expected);
	});
	it.each([-1, 1.5, 48000])('rejects invalid or unexplained Opus pre-skip %s', async (padding) => {
		const value = output();
		value.streams[0].codec_name = 'opus';
		value.streams[0].initial_padding = padding;
		value.format.format_name = 'ogg';
		emit(value);
		await expect(resolve(Buffer.alloc(1), 'ogg')).resolves.toBeNull();
	});
	it('rejects incomplete decoded frame durations instead of summing a partial clip', async () => {
		const value = output();
		value.frames.push({nb_samples: 0});
		emit(value);
		await expect(resolve()).resolves.toBeNull();
	});
	it('rejects duration headers inconsistent with decoded frames', async () => {
		const value = output();
		value.frames[0].nb_samples = 144000;
		emit(value);
		await expect(resolve()).resolves.toBeNull();
	});
	it('rejects 1000001 bytes before spawning', async () => {
		await expect(resolve(Buffer.alloc(1_000_001))).resolves.toBeNull();
		expect(probe.paths).toHaveLength(0);
	});
	it('rejects 10.0001 seconds before rounding', async () => {
		emit(output('10.0001'));
		await expect(resolve()).resolves.toBeNull();
	});
	it('rounds accepted fractions upwards', async () => {
		emit(output('1.0001'));
		await expect(resolve(Buffer.alloc(1), 'mp3', 2)).resolves.toBe(1001);
	});
	it.each(['opus', 'vorbis'])('accepts ogg %s audio', async (codec) => {
		const value = output();
		value.streams[0].codec_name = codec;
		value.format.format_name = 'ogg';
		emit(value);
		await expect(resolve(Buffer.alloc(1), 'ogg')).resolves.toBe(10000);
	});
	it.each([
		[
			'missing stream duration',
			(value: ReturnType<typeof output>) => {
				value.streams[0].duration = '';
			},
		],
		[
			'missing format duration',
			(value: ReturnType<typeof output>) => {
				value.format.duration = '';
			},
		],
		[
			'inconsistent duration',
			(value: ReturnType<typeof output>) => {
				value.format.duration = '4.1';
			},
		],
		[
			'invalid number suffix',
			(value: ReturnType<typeof output>) => {
				value.streams[0].duration = '5.2garbage';
			},
		],
		[
			'nonfinite duration',
			(value: ReturnType<typeof output>) => {
				value.streams[0].duration = 'Infinity';
			},
		],
		[
			'video stream',
			(value: ReturnType<typeof output>) => {
				value.streams[0].codec_type = 'video';
			},
		],
		[
			'multiple streams',
			(value: ReturnType<typeof output>) => {
				value.streams.push({...value.streams[0]});
			},
		],
		[
			'wrong codec',
			(value: ReturnType<typeof output>) => {
				value.streams[0].codec_name = 'aac';
			},
		],
		[
			'wrong container',
			(value: ReturnType<typeof output>) => {
				value.format.format_name = 'mov,mp4';
			},
		],
		[
			'surround audio',
			(value: ReturnType<typeof output>) => {
				value.streams[0].channels = 6;
			},
		],
		[
			'high sample rate',
			(value: ReturnType<typeof output>) => {
				value.streams[0].sample_rate = '96000';
			},
		],
		[
			'no decoded frames',
			(value: ReturnType<typeof output>) => {
				value.frames = [];
			},
		],
	])('fails closed for %s', async (_name, mutate) => {
		const value = output();
		mutate(value);
		emit(value);
		await expect(resolve()).resolves.toBeNull();
	});
	it('does not substitute metadata when the probe fails', async () => {
		probe.script = 'process.exit(1)';
		await expect(resolve()).resolves.toBeNull();
	});
	it('rejects decoding errors even when the subprocess exits successfully', async () => {
		probe.script += ';process.stderr.write("invalid packet")';
		await expect(resolve()).resolves.toBeNull();
	});
	it('rejects conflicting rounded metadata', async () => {
		await expect(resolve(Buffer.alloc(1), 'mp3', 4)).resolves.toBeNull();
	});
	it('accepts authoritative duration when optional media metadata is absent', async () => {
		await expect(resolve(Buffer.alloc(1), 'mp3', null)).resolves.toBe(10000);
	});
	it('caps concurrent probes process-wide with queue-free 503 and releases slots', async () => {
		probe.script = `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(output()))}), 150)`;
		const first = resolve();
		const second = resolve();
		await expect(resolve()).rejects.toMatchObject({status: 503});
		await expect(Promise.all([first, second])).resolves.toEqual([10000, 10000]);
		await expect(resolve()).resolves.toBe(10000);
	});
	it('kills an overflowing child and removes its temporary input', async () => {
		probe.script = 'process.stdout.write("x".repeat(1048577));setInterval(() => {}, 1000)';
		await expect(resolve()).resolves.toBeNull();
	});
	it('kills a timed-out child and removes its temporary input', async () => {
		probe.script = 'setInterval(() => {}, 1000)';
		await expect(resolve()).resolves.toBeNull();
	}, 8000);
});
