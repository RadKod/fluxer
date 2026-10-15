// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	SoundboardPlaybackEngine,
	type SoundboardPlaybackParams,
} from '@app/features/voice/engine/SoundboardPlaybackEngine';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/voice/engine/VoiceSharedAudioContext', () => ({acquireSharedVoiceAudioContext: () => null}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return {promise, resolve};
}

function buffer(overrides: Partial<AudioBuffer> = {}): AudioBuffer {
	return {duration: 1, numberOfChannels: 2, sampleRate: 48000, length: 48000, ...overrides} as AudioBuffer;
}

function params(id = '1', overrides: Partial<SoundboardPlaybackParams> = {}): SoundboardPlaybackParams {
	return {
		eventId: `event-${id}`,
		guildId: 'guild',
		channelId: 'channel',
		actorId: 'actor',
		actorSessionId: 'actor-session',
		recipientConnectionId: 'connection',
		recipientSoundboardEpoch: 1,
		serverTime: 10000,
		assetVersion: id.padStart(64, '0'),
		url: `https://cdn.example/sound-${id}.ogg`,
		sizeBytes: 4,
		durationMs: 1000,
		volume: 0.5,
		...overrides,
	};
}

function fixture(sampleRate = 48000) {
	const sources: Array<{
		buffer: AudioBuffer | null;
		onended: (() => void) | null;
		connect: ReturnType<typeof vi.fn>;
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		disconnect: ReturnType<typeof vi.fn>;
	}> = [];
	const gains: Array<{gain: {value: number}; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>}> =
		[];
	const decode = vi.fn(async (_bytes: ArrayBuffer) => buffer());
	const context = {
		state: 'running',
		sampleRate,
		destination: {},
		decodeAudioData: decode,
		createBufferSource: vi.fn(() => {
			const source = {
				buffer: null as AudioBuffer | null,
				onended: null as (() => void) | null,
				connect: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
				disconnect: vi.fn(),
			};
			sources.push(source);
			return source;
		}),
		createGain: vi.fn(() => {
			const gain = {gain: {value: 1}, connect: vi.fn(), disconnect: vi.fn()};
			gains.push(gain);
			return gain;
		}),
	} as unknown as AudioContext;
	const release = vi.fn();
	const acquireContext = vi.fn(() => ({context, release}));
	const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(new Uint8Array(4)));
	let eligible = true;
	let session = 'account:session:connection:1';
	let listener: (() => void) | null = null;
	const unsubscribe = vi.fn(() => {
		listener = null;
	});
	const engine = new SoundboardPlaybackEngine({
		fetch: fetcher,
		acquireContext,
		isEligible: () => eligible,
		getSessionKey: () => session,
		now: () => 10000,
		subscribe: (callback) => {
			listener = callback;
			return unsubscribe;
		},
	});
	return {
		engine,
		sources,
		gains,
		decode,
		fetcher,
		acquireContext,
		release,
		unsubscribe,
		setEligible: (value: boolean) => {
			eligible = value;
		},
		setSession: (value: string) => {
			session = value;
		},
		change: () => listener?.(),
	};
}

describe('soundboard playback lifecycle', () => {
	it('plays through the leased shared context and releases nodes and lease on end', async () => {
		const f = fixture();
		await f.engine.play(params());
		expect(f.sources).toHaveLength(1);
		expect(f.sources[0].start).toHaveBeenCalledOnce();
		expect(f.gains[0].gain.value).toBe(0.5);
		f.sources[0].onended?.();
		expect(f.sources[0].disconnect).toHaveBeenCalledOnce();
		expect(f.sources[0].buffer).toBeNull();
		expect(f.sources[0].onended).toBeNull();
		expect(f.gains[0].disconnect).toHaveBeenCalledOnce();
		expect(f.release).toHaveBeenCalledOnce();
	});

	it('dispose stops active sources, disconnects gains, releases listener and cannot restart', async () => {
		const f = fixture();
		await f.engine.play(params());
		f.engine.dispose();
		f.engine.dispose();
		await f.engine.play(params('2'));
		expect(f.sources[0].stop).toHaveBeenCalledOnce();
		expect(f.sources[0].disconnect).toHaveBeenCalledOnce();
		expect(f.gains[0].disconnect).toHaveBeenCalledOnce();
		expect(f.release).toHaveBeenCalledOnce();
		expect(f.unsubscribe).toHaveBeenCalledOnce();
		expect(f.fetcher).toHaveBeenCalledOnce();
	});

	it('aborts pending fetch on dispose and rejects its late response', async () => {
		const f = fixture();
		const pending = deferred<Response>();
		f.fetcher.mockImplementationOnce(() => pending.promise);
		const play = f.engine.play(params());
		f.engine.dispose();
		expect(f.fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
		pending.resolve(new Response(new Uint8Array(4)));
		await play;
		expect(f.decode).not.toHaveBeenCalled();
		expect(f.sources).toHaveLength(0);
		expect(f.release).toHaveBeenCalledOnce();
	});

	it('late decode cannot install sources after invalidation', async () => {
		const f = fixture();
		const pending = deferred<AudioBuffer>();
		f.decode.mockImplementationOnce(() => pending.promise);
		const play = f.engine.play(params());
		await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce());
		f.engine.invalidate();
		pending.resolve(buffer());
		await play;
		expect(f.sources).toHaveLength(0);
		expect(f.release).toHaveBeenCalledOnce();
	});

	it('rechecks session epoch after decode even before a change listener runs', async () => {
		const f = fixture();
		const pending = deferred<AudioBuffer>();
		f.decode.mockImplementationOnce(() => pending.promise);
		const play = f.engine.play(params());
		await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce());
		f.setSession('account:session:connection:2');
		pending.resolve(buffer());
		await play;
		expect(f.sources).toHaveLength(0);
	});

	it('rechecks eligibility after fetch and decode', async () => {
		const f = fixture();
		const pending = deferred<Response>();
		f.fetcher.mockImplementationOnce(() => pending.promise);
		const play = f.engine.play(params());
		f.setEligible(false);
		pending.resolve(new Response(new Uint8Array(4)));
		await play;
		expect(f.decode).not.toHaveBeenCalled();
		f.setEligible(true);
		const decoding = deferred<AudioBuffer>();
		f.decode.mockImplementationOnce(() => decoding.promise);
		const next = f.engine.play(params('2'));
		await vi.waitFor(() => expect(f.decode).toHaveBeenCalledOnce());
		f.setEligible(false);
		decoding.resolve(buffer());
		await next;
		expect(f.sources).toHaveLength(0);
	});

	it('state changes stop active sound and abort pending work when muted', async () => {
		const f = fixture();
		await f.engine.play(params());
		const pending = deferred<Response>();
		f.fetcher.mockImplementationOnce(() => pending.promise);
		const play = f.engine.play(params('2'));
		f.setEligible(false);
		f.change();
		expect(f.sources[0].stop).toHaveBeenCalledOnce();
		expect(f.fetcher.mock.calls[1][1].signal?.aborted).toBe(true);
		pending.resolve(new Response(new Uint8Array(4)));
		await play;
		expect(f.sources).toHaveLength(1);
	});

	it('clears cache on account or connection change', async () => {
		const f = fixture();
		await f.engine.play(params());
		f.sources[0].onended?.();
		f.setSession('another-account:session:connection:1');
		f.change();
		await f.engine.play(params('2', {assetVersion: params().assetVersion}));
		expect(f.fetcher).toHaveBeenCalledTimes(2);
	});

	it('cleans up partial source creation when start fails', async () => {
		const f = fixture();
		await f.engine.play(params());
		f.sources[0].onended?.();
		f.sources.length = 0;
		(f.acquireContext().context.createBufferSource as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			const source = {
				buffer: null,
				onended: null,
				connect: vi.fn(),
				start: vi.fn(() => {
					throw new Error('closed');
				}),
				stop: vi.fn(),
				disconnect: vi.fn(),
			};
			f.sources.push(source);
			return source;
		});
		await f.engine.play(params('2'));
		expect(f.sources[0].disconnect).toHaveBeenCalledOnce();
		expect(f.gains[1].disconnect).toHaveBeenCalledOnce();
	});
});

describe('soundboard playback bounds', () => {
	it('does not fetch ineligible, duplicate or invalid metadata events', async () => {
		const f = fixture();
		f.setEligible(false);
		await f.engine.play(params());
		f.setEligible(true);
		await f.engine.play(params('nonfinite', {serverTime: NaN}));
		await f.engine.play(params('invalid', {sizeBytes: 512001}));
		expect(f.fetcher).not.toHaveBeenCalled();
		await f.engine.play(params());
		await f.engine.play(params());
		expect(f.fetcher).toHaveBeenCalledOnce();
	});

	it.each([-10000, 10000])('plays despite a server clock offset of %i ms', async (offset) => {
		const f = fixture();
		await f.engine.play(params('1', {serverTime: 10000 + offset}));
		expect(f.sources).toHaveLength(1);
		expect(f.sources[0]?.start).toHaveBeenCalledOnce();
		f.engine.dispose();
	});

	it.each([88200, 96000, 192000])('accepts a 5.2 second decode at the device rate %i Hz', async (sampleRate) => {
		const f = fixture(sampleRate);
		f.decode.mockResolvedValueOnce(buffer({duration: 5.2, sampleRate, length: Math.ceil(5.2 * sampleRate)}));
		await f.engine.play(params('1', {durationMs: 5200}));
		expect(f.sources).toHaveLength(1);
		expect(f.sources[0]?.start).toHaveBeenCalledOnce();
		f.engine.dispose();
	});

	it('keeps high sample rate cache under the shared PCM budget', async () => {
		const f = fixture(192000);
		f.decode.mockImplementation(async () => buffer({duration: 5.2, sampleRate: 192000, length: 998400}));
		for (let id = 1; id <= 5; id++) {
			await f.engine.play(params(String(id), {durationMs: 5200}));
			f.sources.at(-1)?.onended?.();
		}
		expect(f.sources).toHaveLength(5);
		await f.engine.play(params('6', {assetVersion: params('1').assetVersion, durationMs: 5200}));
		expect(f.fetcher).toHaveBeenCalledTimes(6);
		f.engine.dispose();
	});

	it('drops a third active source without fetching', async () => {
		const f = fixture();
		await f.engine.play(params());
		await f.engine.play(params('2'));
		await f.engine.play(params('3'));
		expect(f.sources).toHaveLength(2);
		expect(f.fetcher).toHaveBeenCalledTimes(2);
	});

	it('bounds fetch/decode work to two jobs, including invalidated native decodes', async () => {
		const f = fixture();
		const pending = deferred<AudioBuffer>();
		f.decode.mockImplementation(() => pending.promise);
		const one = f.engine.play(params());
		const two = f.engine.play(params('2'));
		await vi.waitFor(() => expect(f.decode).toHaveBeenCalledTimes(2));
		f.engine.invalidate();
		await f.engine.play(params('3'));
		expect(f.fetcher).toHaveBeenCalledTimes(2);
		pending.resolve(buffer());
		await Promise.all([one, two]);
		expect(f.sources).toHaveLength(0);
	});

	it('limits cache to sixteen buffers and preserves an active LRU buffer', async () => {
		const f = fixture();
		await f.engine.play(params());
		for (let i = 2; i <= 17; i++) {
			await f.engine.play(params(String(i)));
			f.sources.at(-1)?.onended?.();
		}
		await f.engine.play(params('reuse', {assetVersion: params().assetVersion}));
		expect(f.fetcher).toHaveBeenCalledTimes(17);
		f.sources.at(-1)?.onended?.();
		await f.engine.play(params('evicted', {assetVersion: params('2').assetVersion}));
		expect(f.fetcher).toHaveBeenCalledTimes(18);
	});

	it.each([
		{duration: 5.201},
		{numberOfChannels: 3},
		{sampleRate: 48001},
		{sampleRate: 0},
		{length: 8388609},
		{duration: NaN},
		{numberOfChannels: 0},
		{length: 0},
	])('rejects unsafe decoded audio %j', async (overrides) => {
		const f = fixture();
		f.decode.mockResolvedValueOnce(buffer(overrides));
		await f.engine.play(params());
		expect(f.sources).toHaveLength(0);
		expect(f.release).toHaveBeenCalledOnce();
	});

	it('rejects encoded size before decoding and cancels the stream', async () => {
		const f = fixture();
		const cancel = vi.fn();
		f.fetcher.mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					start: (controller) => controller.enqueue(new Uint8Array(512001)),
					cancel,
				}),
			),
		);
		await f.engine.play(params());
		expect(f.decode).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('releases ownership on failed fetch or decode and admits another event', async () => {
		const f = fixture();
		f.fetcher.mockRejectedValueOnce(new Error('network'));
		await f.engine.play(params());
		f.decode.mockRejectedValueOnce(new Error('codec'));
		await f.engine.play(params('2'));
		await f.engine.play(params('3'));
		expect(f.sources).toHaveLength(1);
		expect(f.release).toHaveBeenCalledTimes(2);
	});
});
