// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import type {SoundboardPlayPayload} from '@app/features/voice/events/SoundboardPlay';
import type {GuildSoundboardSoundResponse} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const adapters = vi.hoisted(() => ({
	media: {
		connected: true,
		reconnecting: false,
		guildId: '100000000000000001',
		channelId: '100000000000000002',
		connectionId: 'connection',
		epoch: 3,
		actorSession: 'actor-session',
		effectiveMute: false,
		effectiveDeaf: false,
	},
	list: vi.fn(),
	stored: new Map<string, unknown>(),
	listeners: new Set<() => void>(),
}));

vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: adapters.list}}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {
		getJSON: (key: string) => adapters.stored.get(key),
		setJSON: (key: string, value: unknown) => adapters.stored.set(key, value),
		getItem: () => null,
	},
	onBeforeAppStorageScopeChange: () => () => {},
	subscribeAppStorageScope: () => () => {},
}));
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({
	default: {foregroundConnection: {sessionId: 'receiver-session'}},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		viewAccountKey: 'receiver-account',
		getCurrentUser: () => ({id: '100000000000000003'}),
	},
}));
vi.mock('@app/features/voice/engine/VoiceEffectiveAudioState', () => ({getEffectiveAudioState: () => adapters.media}));
vi.mock('@app/features/voice/state/ParticipantVolume', () => ({
	default: {
		isLocalMuted: () => false,
		subscribe: (listener: () => void) => {
			adapters.listeners.add(listener);
			return () => adapters.listeners.delete(listener);
		},
	},
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		get connected() {
			return adapters.media.connected;
		},
		get reconnecting() {
			return adapters.media.reconnecting;
		},
		get guildId() {
			return adapters.media.guildId;
		},
		get channelId() {
			return adapters.media.channelId;
		},
		get connectionId() {
			return adapters.media.connectionId;
		},
		getVoiceStateByConnectionId: (id: string) =>
			id === adapters.media.connectionId
				? {
						user_id: '100000000000000003',
						session_id: 'receiver-session',
						channel_id: adapters.media.channelId,
						soundboard_epoch: adapters.media.epoch,
						suppress: false,
					}
				: null,
		getAllVoiceStatesInChannel: () => ({
			actor: {
				user_id: '100000000000000004',
				session_id: adapters.media.actorSession,
				channel_id: adapters.media.channelId,
				mute: false,
				deaf: false,
				self_mute: false,
				self_deaf: false,
				suppress: false,
			},
		}),
	},
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return {promise, resolve};
}

interface FakeGain {
	gain: {value: number};
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
}

interface FakeSource {
	buffer: AudioBuffer | null;
	onended: (() => void) | null;
	connect: ReturnType<typeof vi.fn>;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
}

class FakeNativeAudioContext extends EventTarget {
	static contexts: Array<FakeNativeAudioContext> = [];
	state = 'running';
	readonly sampleRate = 48000;
	readonly destination = {};
	readonly sources: Array<FakeSource> = [];
	readonly gains: Array<FakeGain> = [];
	readonly decodeAudioData = vi.fn(
		async (_bytes: ArrayBuffer): Promise<AudioBuffer> =>
			({
				duration: 0.25,
				sampleRate: 48000,
				numberOfChannels: 2,
				length: 12000,
			}) as AudioBuffer,
	);
	readonly suspend = vi.fn(async () => {
		this.state = 'suspended';
	});
	readonly resume = vi.fn(async () => {
		this.state = 'running';
	});
	constructor() {
		super();
		FakeNativeAudioContext.contexts.push(this);
	}
	createWaveShaper() {
		return {curve: null, oversample: 'none', connect: vi.fn()};
	}
	createGain(): FakeGain {
		const gain = {gain: {value: 1}, connect: vi.fn(), disconnect: vi.fn()};
		this.gains.push(gain);
		return gain;
	}
	createBufferSource(): FakeSource {
		const source = {
			buffer: null as AudioBuffer | null,
			onended: null as (() => void) | null,
			connect: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
			disconnect: vi.fn(),
		};
		this.sources.push(source);
		return source;
	}
}

const sound: GuildSoundboardSoundResponse = {
	id: '100000000000000005',
	guild_id: '100000000000000001',
	creator_id: '100000000000000004',
	name: 'Short chime',
	asset_hash: 'a'.repeat(64),
	extension: 'ogg',
	size_bytes: 4,
	duration_ms: 250,
	volume: 0.8,
	created_at: '2026-10-14T00:00:00.000Z',
	version: 1,
	url: `https://cdn.example/soundboard-sounds/100000000000000001/${'a'.repeat(64)}.ogg`,
};
const context = {
	accountKey: 'receiver-account',
	expectedUserId: '100000000000000003',
	isReplay: false,
	socket: {getSessionId: () => 'receiver-session'},
} as unknown as GatewayHandlerContext;
function event(overrides: Partial<SoundboardPlayPayload> = {}): SoundboardPlayPayload {
	return {
		guild_id: sound.guild_id,
		channel_id: '100000000000000002',
		sound_id: sound.id,
		actor_id: sound.creator_id,
		session_id: 'actor-session',
		event_id: '13855621-2c5e-40b9-8108-c65bb114d1f8',
		server_time: Date.now(),
		asset_version: sound.asset_hash,
		volume: 0.8,
		recipient_connection_id: 'connection',
		recipient_soundboard_epoch: 3,
		...overrides,
	};
}

describe('soundboard B contract client playback integration', () => {
	let runtime: typeof import('./SoundboardPlay');
	let shared: typeof import('@app/features/voice/engine/VoiceSharedAudioContext');
	let library: typeof import('@app/features/voice/state/SoundboardLibrary')['default'];
	let settings: typeof import('@app/features/voice/state/SoundboardSettings')['default'];
	let dispose: () => void;
	let change: (action: () => void) => void;
	let mediaFetch: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.resetModules();
		vi.clearAllMocks();
		adapters.listeners.clear();
		adapters.stored.clear();
		FakeNativeAudioContext.contexts.length = 0;
		const {observable, runInAction} = await import('mobx');
		change = runInAction;
		adapters.media = observable({
			connected: true,
			reconnecting: false,
			guildId: sound.guild_id,
			channelId: '100000000000000002',
			connectionId: 'connection',
			epoch: 3,
			actorSession: 'actor-session',
			effectiveMute: false,
			effectiveDeaf: false,
		});
		vi.stubGlobal('window', {AudioContext: FakeNativeAudioContext});
		mediaFetch = vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array([1, 2]));
							controller.enqueue(new Uint8Array([3, 4]));
							controller.close();
						},
					}),
					{headers: {'content-length': '4'}},
				),
		);
		vi.stubGlobal('fetch', mediaFetch);
		const schema = await import('@fluxer/schema/src/domains/guild/GuildSoundboardSchemas');
		adapters.list.mockImplementation(async (url: string, options: {signal: AbortSignal}) => {
			expect(url).toBe(`/guilds/${sound.guild_id}/soundboard-sounds`);
			expect(options.signal.aborted).toBe(false);
			return {body: {sounds: [schema.GuildSoundboardSoundResponse.parse(sound)]}};
		});
		runtime = await import('./SoundboardPlay');
		shared = await import('@app/features/voice/engine/VoiceSharedAudioContext');
		library = (await import('@app/features/voice/state/SoundboardLibrary')).default;
		settings = (await import('@app/features/voice/state/SoundboardSettings')).default;
		dispose = runtime.initSoundboardRuntime();
	});

	afterEach(() => {
		dispose?.();
		vi.unstubAllGlobals();
	});

	it('accepts the frozen DTO/endpoint, distinct actor session and recipient epoch, then releases playback ownership', async () => {
		settings.setVolume(0.5);
		await runtime.handleSoundboardPlay(event(), context);
		expect(adapters.list).toHaveBeenCalledOnce();
		expect(library.getSound(sound.id)).toMatchObject(sound);
		expect(mediaFetch).toHaveBeenCalledWith(
			sound.url,
			expect.objectContaining({credentials: 'omit', signal: expect.any(AbortSignal)}),
		);
		expect(FakeNativeAudioContext.contexts).toHaveLength(1);
		const audio = FakeNativeAudioContext.contexts[0];
		expect(audio.decodeAudioData).toHaveBeenCalledOnce();
		expect(audio.sources).toHaveLength(1);
		expect(audio.sources[0].start).toHaveBeenCalledOnce();
		expect(audio.gains[1].gain.value).toBe(0.4);
		expect(shared.getSharedVoiceAudioContextLeaseCount()).toBe(1);
		dispose();
		expect(audio.sources[0].stop).toHaveBeenCalledOnce();
		expect(audio.sources[0].disconnect).toHaveBeenCalledOnce();
		expect(audio.sources[0].buffer).toBeNull();
		expect(audio.sources[0].onended).toBeNull();
		expect(audio.gains[1].disconnect).toHaveBeenCalledOnce();
		expect(shared.getSharedVoiceAudioContextLeaseCount()).toBe(0);
		expect(adapters.listeners.size).toBe(0);
		expect(library.sounds).toHaveLength(0);
		expect(settings.accountId).toBeNull();
	});

	it.each(['epoch', 'reconnect', 'dispose'] as const)(
		'a late real decode after %s cannot create a source or retain leases',
		async (transition) => {
			const audio = shared.getSharedVoiceAudioContext() as unknown as FakeNativeAudioContext;
			const late = deferred<AudioBuffer>();
			audio.decodeAudioData.mockImplementationOnce(() => late.promise);
			const pending = runtime.handleSoundboardPlay(event(), context);
			await vi.waitFor(() => expect(audio.decodeAudioData).toHaveBeenCalledOnce());
			expect(shared.getSharedVoiceAudioContextLeaseCount()).toBe(1);
			if (transition === 'dispose') dispose();
			else
				change(() => {
					if (transition === 'epoch') adapters.media.epoch++;
					else adapters.media.reconnecting = true;
				});
			expect(shared.getSharedVoiceAudioContextLeaseCount()).toBe(0);
			late.resolve({duration: 0.25, sampleRate: 48000, numberOfChannels: 2, length: 12000} as AudioBuffer);
			await pending;
			expect(audio.sources).toHaveLength(0);
			expect(audio.gains).toHaveLength(1);
			expect(shared.getSharedVoiceAudioContextLeaseCount()).toBe(0);
		},
	);

	it('snapshot/replay headers and stale recipient epoch or actor session never request metadata or media', async () => {
		await runtime.handleSoundboardPlay(event(), {...context, socket: null});
		await runtime.handleSoundboardPlay(event(), {...context, isReplay: true});
		await runtime.handleSoundboardPlay(event({recipient_soundboard_epoch: 2}), context);
		await runtime.handleSoundboardPlay(event({session_id: 'receiver-session'}), context);
		expect(adapters.list).not.toHaveBeenCalled();
		expect(mediaFetch).not.toHaveBeenCalled();
		expect(FakeNativeAudioContext.contexts).toHaveLength(0);
	});

	it('preserves active playback, decoded cache and event dedupe while volume is dragged', async () => {
		await runtime.handleSoundboardPlay(event(), context);
		const audio = FakeNativeAudioContext.contexts[0];
		settings.setVolume(0.5);
		settings.setVolume(0.25);
		expect(audio.sources[0].stop).not.toHaveBeenCalled();
		await runtime.handleSoundboardPlay(event(), context);
		expect(audio.sources).toHaveLength(1);
		audio.sources[0].onended?.();
		await runtime.handleSoundboardPlay(event({event_id: 'second-event'}), context);
		expect(mediaFetch).toHaveBeenCalledOnce();
		expect(audio.decodeAudioData).toHaveBeenCalledOnce();
		expect(audio.gains[2].gain.value).toBe(0.2);
	});

	it('does not repeat failed metadata requests for each live play event', async () => {
		adapters.list.mockRejectedValue(new Error('offline'));
		for (let id = 0; id < 5; id++) await runtime.handleSoundboardPlay(event({event_id: `event-${id}`}), context);
		expect(adapters.list).toHaveBeenCalledOnce();
		expect(mediaFetch).not.toHaveBeenCalled();
	});
});
