// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeMediaTrack {
	id: string;
	label: string;
	readyState: 'live' | 'ended';
	endedListeners: Set<() => void>;
	stop(): void;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

const h = vi.hoisted(() => ({
	gates: new Map<string, Promise<void>>(),
	reached: new Set<string>(),
	captured: [] as Array<FakeMediaTrack>,
	processed: [] as Array<FakeMediaTrack>,
	camera: [] as Array<FakeMediaTrack>,
	desktop: false,
	activeRoom: null as unknown,
	connecting: false,
	connected: false,
	selfMute: false,
	pushToTalk: false,
	browserNoiseSuppression: undefined as boolean | undefined,
	speakingMeters: new Set<{readTrack: () => unknown}>(),
	muteCalls: 0,
	permissionGranted: vi.fn(),
	syncVoiceState: vi.fn(),
	updateSelfMute: vi.fn(),
}));

async function step(name: string): Promise<void> {
	h.reached.add(name);
	await h.gates.get(name);
}

function gate(name: string): () => void {
	let release!: () => void;
	h.gates.set(
		name,
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	return release;
}

function createMediaTrack(label: string, into: Array<FakeMediaTrack>): FakeMediaTrack {
	const track: FakeMediaTrack = {
		id: `${label}#${into.length}`,
		label,
		readyState: 'live',
		endedListeners: new Set(),
		stop() {
			track.readyState = 'ended';
		},
		addEventListener(type, listener) {
			if (type === 'ended') track.endedListeners.add(listener);
		},
		removeEventListener(type, listener) {
			if (type === 'ended') track.endedListeners.delete(listener);
		},
	};
	into.push(track);
	return track;
}

vi.mock('@app/features/app/constants/Endpoints', () => ({Endpoints: {}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/app/utils/LimitUtils', () => ({isLimitToggleEnabled: () => false}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => null}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => null}}));
vi.mock('@app/features/input/state/InputKeybind', () => ({
	default: {
		isPushToTalkEffective: () => h.pushToTalk,
		isPushToMuteEffective: () => false,
		pushToTalkHeld: false,
		pushToMuteHeld: false,
	},
}));
vi.mock('@app/features/notification/utils/EntranceSoundScopes', () => ({
	getVoiceContextEntranceSoundScope: () => null,
}));
vi.mock('@app/features/permissions/system/commands/MacPermissionsModalCommands', () => ({
	handleMediaPermissionBlocked: () => {},
}));
vi.mock('@app/features/permissions/system/state/MediaPermission', () => ({
	default: {
		isMicrophoneExplicitlyDenied: () => false,
		updateMicrophonePermissionGranted: () => h.permissionGranted(),
		markMicrophoneExplicitlyDenied: () => {},
	},
}));
vi.mock('@app/features/permissions/system/utils/NativePermissions', () => ({
	ensureNativePermission: async () => 'granted',
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
		info() {}
		warn() {}
		error() {}
	},
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({isDesktop: () => h.desktop}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {
		ensureDevices: () => step('ensureDevices'),
		getState: () => ({inputDevices: []}),
	},
}));
vi.mock('@app/features/voice/engine/VoiceEffectiveAudioState', () => ({
	getEffectiveAudioState: () => ({
		selfMute: false,
		selfDeaf: false,
		serverMute: false,
		serverDeaf: false,
		effectiveMute: false,
		effectiveDeaf: false,
	}),
}));
vi.mock('@app/features/voice/engine/VoiceInputAudioContext', () => ({acquireVoiceInputContext: () => null}));
vi.mock('@app/features/voice/engine/VoiceMediaEngineBridge', () => ({
	getRoomFromMediaEngine: () => h.activeRoom,
	// The channel id comes from the gateway voice state and stays set until the server echoes the hang-up; the
	// connection flags are cleared synchronously with the hang-up.
	getVoiceConnectionContextFromMediaEngine: () => ({
		guildId: 'guild-1',
		channelId: 'channel-1',
		connectionId: 'connection-1',
		connecting: h.connecting,
		connected: h.connected,
	}),
	getVoiceEngineV2SnapshotFromMediaEngine: () => null,
	setVoiceEngineV2ParticipantAudioLevelSpeaking: () => true,
	syncLocalVoiceStateWithServer: (partial: object) => h.syncVoiceState(partial),
	updateLocalParticipantFromRoom: () => {},
}));
vi.mock('@app/features/voice/engine/v2/VoiceEngineV2AppCameraTransition', () => ({
	runCameraTransition: async ({publish}: {publish: () => Promise<void>}) => {
		await publish();
		return 'applied';
	},
}));
vi.mock('@app/features/voice/engine/v2/VoiceEngineV2AppCameraResolutionPresets', () => ({
	getCameraCaptureDimensions: () => ({}),
}));
vi.mock('@app/features/voice/engine/v2/VoiceEngineV2AppSelectors', () => ({
	selectVoiceEngineV2AppEffectiveSelfMuteFromAudioControls: () => h.selfMute,
	selectVoiceEngineV2AppMuteReason: () => null,
	selectVoiceEngineV2AppParticipant: () => null,
}));
vi.mock('@app/features/voice/engine/voice_screen_share_manager/NativePermissionGate', () => ({
	ensureNativeMediaPermission: () => step('nativePermission'),
}));
vi.mock('@app/features/voice/state/CallMediaPrefs', () => ({default: {}}));
vi.mock('@app/features/voice/state/EntranceSoundLibrary', () => ({default: {}}));
vi.mock('@app/features/voice/state/LocalVoiceState', () => ({
	default: {
		getSelfMute: () => false,
		getSelfDeaf: () => false,
		getMutedByPermission: () => false,
		getHasUserSetMute: () => false,
		getHasUserSetDeaf: () => false,
		shouldUnmuteOnUndeafen: false,
		updateSelfMute: (muted: boolean) => h.updateSelfMute(muted),
	},
}));
vi.mock('@app/features/voice/state/ParticipantVolume', () => ({default: {applySettingsToRoom: () => {}}}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({
	default: {
		getInputDeviceId: () => 'default',
		getMuteStreamAudio: () => false,
		getCameraResolution: () => '720p',
		inputVolume: 100,
		outputVolume: 100,
	},
}));
vi.mock('@app/features/voice/utils/AudioPublishOptions', () => ({
	buildMicrophonePublishOptions: () => undefined,
	sendsStereoMicrophone: () => false,
}));
vi.mock('@app/features/voice/utils/CodecCapabilityDetector', () => ({
	buildCameraPublishOptions: () => ({}),
	findVideoPublishCodecPolicyViolation: () => null,
}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({
	awaitMicrophoneSessionWarmup: () => step('warmup'),
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability', () => ({
	default: {setVoiceInputGraphUnavailable() {}, setVoiceInputRuntime() {}, clearVoiceInputRuntime() {}},
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', () => ({
	readCaptureNoiseSuppressionBackend: () => 'standard',
	resolveRuntimeVoiceProcessing: (profile: object) => profile,
}));
vi.mock('@app/features/voice/utils/VideoBackgroundProcessor', () => ({
	applyBackgroundProcessor: async () => {},
	clearCameraVideoProcessor: async () => {},
}));
vi.mock('@app/features/voice/engine/VoiceSpeakingDetection', () => ({
	VoiceSpeakingMeter: class {
		speaking = false;
		constructor(readonly readTrack: () => unknown) {
			h.speakingMeters.add(this);
		}
		tick(): void {}
		dispose(): void {
			h.speakingMeters.delete(this);
		}
	},
}));
vi.mock('@app/features/voice/utils/VoiceInputProcessor', () => {
	class VoiceInputTrackProcessor {
		processedTrack?: FakeMediaTrack;
		async init(): Promise<void> {
			await step('processorInit');
			this.processedTrack = createMediaTrack('MediaStreamAudioDestinationNode', h.processed);
		}
		async destroy(): Promise<void> {
			this.processedTrack?.stop();
		}
		async configure(): Promise<void> {
			await step('configure');
		}
		reportRuntime(): void {}
	}
	return {
		VoiceInputTrackProcessor,
		readVoiceInputProcessor: (track: {getProcessor?(): unknown} | null | undefined) => {
			const processor = track?.getProcessor?.();
			return processor instanceof VoiceInputTrackProcessor ? processor : null;
		},
	};
});
vi.mock('@app/features/voice/utils/VoicePermissionUtils', () => ({
	isVoicePermissionMuteActive: () => false,
	isVoiceSpeakPermissionDenied: () => false,
}));
vi.mock('@app/features/voice/utils/VoiceProcessingProfile', () => ({
	applyContentHintToTrack: () => {},
	getActiveVoiceProcessingMode: () => 'custom',
	resolveVoiceProcessingFromStateForDeviceLabel: () => ({
		contentHint: 'speech',
		browserNoiseSuppression: h.browserNoiseSuppression,
	}),
}));
vi.mock('@fluxer/constants/src/GuildConstants', () => ({resolveVoiceChannelBitrate: () => 64_000}));
vi.mock('livekit-client', () => ({
	ConnectionState: {Disconnected: 'disconnected', Connecting: 'connecting', Connected: 'connected'},
	Track: {
		Source: {
			Microphone: 'microphone',
			Camera: 'camera',
			ScreenShare: 'screen_share',
			ScreenShareAudio: 'screen_share_audio',
			Unknown: 'unknown',
		},
		Kind: {Audio: 'audio', Video: 'video'},
	},
	TrackEvent: {TrackProcessorUpdate: 'trackProcessorUpdate'},
}));

// Upstream LiveKit LocalAudioTrack: stop() destroys the processor and stops the captured (getUserMedia) track, and
// unmute() of a muted track whose capture has ended, or restartTrack(), opens a new getUserMedia capture even after
// stop().
class FakeLocalAudioTrack {
	readonly source = 'microphone';
	readonly kind = 'audio';
	constraints: Record<string, unknown> = {};
	readonly sender = {getParameters: () => ({encodings: [{}]}), setParameters: async () => {}};
	isMuted = false;
	processor: {processedTrack?: FakeMediaTrack; destroy(): Promise<void>} | undefined;

	constructor(private captured: FakeMediaTrack) {}

	get mediaStreamTrack(): FakeMediaTrack {
		return this.processor?.processedTrack ?? this.captured;
	}

	get mediaStream() {
		return {getAudioTracks: () => [this.mediaStreamTrack]};
	}

	getProcessor() {
		return this.processor;
	}

	async mute(): Promise<void> {
		h.muteCalls++;
		await step(`mute#${h.muteCalls}`);
		this.isMuted = true;
	}

	async unmute(): Promise<void> {
		await step('unmute');
		if (this.isMuted && this.captured.readyState === 'ended') this.reacquire();
		this.isMuted = false;
	}

	async restartTrack(): Promise<void> {
		this.reacquire();
	}

	private reacquire(): void {
		this.captured.stop();
		this.captured = createMediaTrack('Fake Default Audio Input', h.captured);
	}

	stop(): void {
		const processor = this.processor;
		this.processor = undefined;
		void processor?.destroy();
		this.captured.stop();
	}

	on(): void {}
	off(): void {}
}

const PUBLISH_SIGNAL_TIMEOUT_MS = 15_000;

const ROOM_CLEANUP_DELAY_MS = 50;

// LiveKit Room.disconnect(): the engine closes at once, so a later publishTrack waits for a signal connection that
// never comes and stops the track after 15 s. Room.state and the published tracks are only cleaned up after the
// engine finished closing.
class FakeRoom {
	constructor(private readonly cleanupDelayMs = ROOM_CLEANUP_DELAY_MS) {}

	state = 'connected';
	engineClosed = false;
	publishCallsAfterHangUp = 0;
	readonly remoteParticipants = new Map<string, object>();
	readonly localParticipant = {
		identity: 'user_1_connection',
		audioTrackPublications: new Map<string, object>(),
		videoTrackPublications: new Map<string, object>(),
		trackPublications: new Map<string, object>(),
		isCameraEnabled: false,
		setCameraEnabled: async (enabled: boolean) => {
			this.localParticipant.isCameraEnabled = enabled;
			if (!enabled) return;
			const mediaStreamTrack = createMediaTrack('Fake Camera Input', h.camera);
			const track = {mediaStreamTrack, stop: () => mediaStreamTrack.stop()};
			const publication = {source: 'camera', kind: 'video', trackSid: 'TR_camera', track, videoTrack: track};
			this.localParticipant.videoTrackPublications.set(publication.trackSid, publication);
			this.localParticipant.trackPublications.set(publication.trackSid, publication);
		},
		createTracks: async (options: {
			audio: {processor?: NonNullable<FakeLocalAudioTrack['processor']> & {init(): Promise<void>}};
		}) => {
			await step('getUserMedia');
			const track = new FakeLocalAudioTrack(createMediaTrack('Fake Default Audio Input', h.captured));
			const processor = options.audio.processor;
			if (processor) {
				await processor.init();
				track.processor = processor;
			}
			return [track];
		},
		publishTrack: async (track: FakeLocalAudioTrack) => {
			await step('publish');
			if (this.engineClosed) {
				this.publishCallsAfterHangUp++;
				await new Promise<never>((_, reject) => {
					setTimeout(() => {
						track.stop();
						reject(new Error('publishing rejected as engine not connected within timeout'));
					}, PUBLISH_SIGNAL_TIMEOUT_MS);
				});
			}
			const publication = {
				source: 'microphone',
				kind: 'audio',
				track,
				trackSid: 'TR_microphone',
				isMuted: track.isMuted,
				mute: async () => {
					publication.isMuted = true;
				},
				unmute: async () => {
					publication.isMuted = false;
				},
			};
			this.localParticipant.audioTrackPublications.set(publication.trackSid, publication);
			this.localParticipant.trackPublications.set(publication.trackSid, publication);
			return publication;
		},
		unpublishTrack: async (track: FakeLocalAudioTrack, stopOnUnpublish = true) => {
			for (const publications of [
				this.localParticipant.audioTrackPublications,
				this.localParticipant.videoTrackPublications,
				this.localParticipant.trackPublications,
			]) {
				for (const [sid, publication] of publications) {
					if ((publication as {track: unknown}).track === track) publications.delete(sid);
				}
			}
			if (stopOnUnpublish) track.stop();
		},
	};

	disconnect(stopTracks = true): void {
		this.engineClosed = true;
		setTimeout(() => {
			this.state = 'disconnected';
			if (stopTracks) {
				for (const publication of this.localParticipant.trackPublications.values()) {
					(publication as {track: FakeLocalAudioTrack}).track.stop();
				}
			}
			this.localParticipant.trackPublications.clear();
			this.localParticipant.audioTrackPublications.clear();
			this.localParticipant.videoTrackPublications.clear();
		}, this.cleanupDelayMs);
	}
}

type Adapter = Awaited<ReturnType<typeof createAdapter>>;

function connect(room: FakeRoom): void {
	h.activeRoom = room;
	h.connected = true;
}

// Same order as MediaEngineFacade.runDisconnectFromVoiceChannel: local media reset, connection state cleared, then
// the LiveKit room is disconnected. The room keeps its connected state until LiveKit finished closing it.
function hangUp(adapter: Adapter, room: FakeRoom): void {
	adapter.resetStreamTracking();
	h.activeRoom = null;
	h.connected = false;
	h.connecting = false;
	room.disconnect();
}

// Same as the region hot-swap in VoiceEngineV2AppConnectionHostAdapter: the new room publishes the MediaStreamTrack the
// old room sends (the processed track while a processor is installed) in a track that owns only that MediaStreamTrack.
async function republishLocalTracks(from: FakeRoom, to: FakeRoom): Promise<void> {
	const publications = [...from.localParticipant.trackPublications.values()] as Array<{track: FakeLocalAudioTrack}>;
	for (const publication of publications) {
		await to.localParticipant.publishTrack(new FakeLocalAudioTrack(publication.track.mediaStreamTrack));
	}
}

// The new room becomes the active room, then the old room is closed without stopping its tracks.
async function completeHotSwap(from: FakeRoom, to: FakeRoom): Promise<void> {
	await republishLocalTracks(from, to);
	h.activeRoom = to;
	from.disconnect(false);
	await vi.advanceTimersByTimeAsync(ROOM_CLEANUP_DELAY_MS);
}

// Same as a VOICE_SERVER_UPDATE for the current channel that is not a region change: the local media is kept (no reset),
// the connection has no room while the new one connects, then the previous room is closed with its tracks.
async function reconnectSameChannel(from: FakeRoom, to: FakeRoom): Promise<void> {
	h.activeRoom = null;
	h.connected = false;
	h.connecting = true;
	from.disconnect();
	await vi.advanceTimersByTimeAsync(ROOM_CLEANUP_DELAY_MS);
	h.connecting = false;
	connect(to);
}

function microphoneTrackOf(room: FakeRoom): FakeLocalAudioTrack {
	const [publication] = room.localParticipant.audioTrackPublications.values() as Iterable<{
		track: FakeLocalAudioTrack;
	}>;
	return publication.track;
}

function liveTracks(): Array<string> {
	return [...h.captured, ...h.processed].filter((track) => track.readyState === 'live').map((track) => track.label);
}

function microphoneState(adapter: Adapter): string {
	return (adapter as unknown as {mediaStateSnapshot: {context: {microphone: {state: string}}}}).mediaStateSnapshot
		.context.microphone.state;
}

async function createAdapter() {
	const {VoiceEngineV2AppMediaExecutionAdapter} = await import(
		'@app/features/voice/engine/v2/VoiceEngineV2AppMediaExecutionAdapter'
	);
	const adapter = new VoiceEngineV2AppMediaExecutionAdapter();
	adapter.resetMicrophoneFailureLatch();
	return adapter;
}

beforeEach(() => {
	vi.useFakeTimers();
	h.gates.clear();
	h.reached.clear();
	h.captured.length = 0;
	h.processed.length = 0;
	h.camera.length = 0;
	h.desktop = false;
	h.activeRoom = null;
	h.connecting = false;
	h.connected = false;
	h.selfMute = false;
	h.pushToTalk = false;
	h.browserNoiseSuppression = undefined;
	h.muteCalls = 0;
	h.permissionGranted.mockClear();
	h.syncVoiceState.mockClear();
	h.updateSelfMute.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

const LIVE_MICROPHONE = ['Fake Default Audio Input', 'MediaStreamAudioDestinationNode'];

function settleState(promise: Promise<unknown>): {settled: boolean} {
	const state = {settled: false};
	void promise.then(
		() => {
			state.settled = true;
		},
		() => {
			state.settled = true;
		},
	);
	return state;
}

function isSpeakingMetered(track: {mediaStreamTrack: unknown}): boolean {
	return [...h.speakingMeters].some((meter) => meter.readTrack() === track.mediaStreamTrack);
}

describe('local capture lifecycle reset', () => {
	it('removes both ended listeners and bridge registrations on reset, then permits fresh room bindings', async () => {
		const adapter = await createAdapter();
		const registrations = new Map<string, string>();
		const lifecycle = {
			bind: vi.fn(({captureId, sourceId}: {captureId: string; sourceId: string}) => {
				if (registrations.has(captureId)) return false;
				registrations.set(captureId, sourceId);
				return true;
			}),
			unbind: vi.fn((captureId: string) => registrations.delete(captureId)),
			reportLifecycle: vi.fn(),
		};
		adapter.setSourceLifecycleBridge(lifecycle as never);
		const endedListenerCount = () =>
			[...h.captured, ...h.processed, ...h.camera].reduce((count, track) => count + track.endedListeners.size, 0);

		for (let round = 0; round < 2; round++) {
			const room = new FakeRoom();
			connect(room);
			await adapter.enableMicrophone(room as never, `channel-${round + 1}`);
			await expect(adapter.setCameraEnabled(true)).resolves.toBe('applied');
			const microphone = microphoneTrackOf(room).mediaStreamTrack;
			const camera = h.camera[round];
			expect(endedListenerCount()).toBe(2);
			expect([...registrations.keys()].sort()).toEqual([`voice-mic:${microphone.id}`, `voice-cam:${camera.id}`].sort());
			expect(registrations.size).toBe(2);

			adapter.resetStreamTracking();

			expect(endedListenerCount()).toBe(0);
			expect(registrations.size).toBe(0);
			expect(liveTracks()).toEqual([]);
			expect(lifecycle.unbind).toHaveBeenCalledTimes((round + 1) * 2);
			adapter.resetStreamTracking();
			expect(lifecycle.unbind).toHaveBeenCalledTimes((round + 1) * 2);
			for (const track of [microphone, camera]) {
				for (const listener of track.endedListeners) listener();
			}
			expect(lifecycle.reportLifecycle).not.toHaveBeenCalled();
			room.disconnect();
			await vi.advanceTimersByTimeAsync(ROOM_CLEANUP_DELAY_MS);
			expect(h.camera.filter((track) => track.readyState === 'live')).toEqual([]);
		}
	});
});

describe('microphone enable when the user hangs up while voice is connecting', () => {
	it('publishes a live microphone when the room stays connected', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		connect(room);

		await adapter.enableMicrophone(room as never, 'channel-1');

		expect(room.localParticipant.audioTrackPublications.size).toBe(1);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
	});

	it.each([
		{step: 'nativePermission', desktop: true, capturedBeforeHangUp: false},
		{step: 'ensureDevices', desktop: false, capturedBeforeHangUp: false},
		{step: 'warmup', desktop: false, capturedBeforeHangUp: false},
		{step: 'getUserMedia', desktop: false, capturedBeforeHangUp: false},
		{step: 'processorInit', desktop: false, capturedBeforeHangUp: true},
	])('hang-up during $step leaves no live microphone and never publishes to the closed room', async (scenario) => {
		h.desktop = scenario.desktop;
		const adapter = await createAdapter();
		const room = new FakeRoom();
		connect(room);
		const releaseStep = gate(scenario.step);
		const enable = settleState(adapter.enableMicrophone(room as never, 'channel-1'));
		await vi.advanceTimersByTimeAsync(0);
		expect(h.reached.has(scenario.step)).toBe(true);
		expect(h.captured.length > 0).toBe(scenario.capturedBeforeHangUp);

		hangUp(adapter, room);
		releaseStep();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(room.publishCallsAfterHangUp).toBe(0);
		expect(liveTracks()).toEqual([]);
		expect(enable.settled).toBe(true);
		if (!scenario.capturedBeforeHangUp && scenario.step !== 'getUserMedia') {
			expect(h.captured).toEqual([]);
		}
	});

	it('an enable request for a room that has already hung up does not open the microphone', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		connect(room);
		hangUp(adapter, room);

		void adapter.enableMicrophone(room as never, 'channel-1').catch(() => {});
		await vi.advanceTimersByTimeAsync(1_000);

		expect(h.captured).toEqual([]);
		expect(room.publishCallsAfterHangUp).toBe(0);
	});

	it('does not re-acquire the microphone in the mute loop after the room stopped the published track', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		connect(room);
		h.selfMute = true;
		const releaseLoopMute = gate('mute#2');
		const enabled = adapter.enableMicrophone(room as never, 'channel-1');
		await vi.advanceTimersByTimeAsync(0);
		expect(h.reached.has('mute#2')).toBe(true);

		hangUp(adapter, room);
		h.selfMute = false;
		await vi.advanceTimersByTimeAsync(ROOM_CLEANUP_DELAY_MS);
		releaseLoopMute();
		await vi.advanceTimersByTimeAsync(1_000);
		await enabled;

		expect(h.captured).toHaveLength(1);
		expect(liveTracks()).toEqual([]);
	});

	it('stops the capture at once when the user hangs up while the publish is in flight and keeps the next session unmuted', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		connect(room);
		const releasePublish = gate('publish');
		const reconciled = adapter.reconcileEffectiveAudioState(room as never, {
			channelId: 'channel-1',
			serverMute: false,
			serverDeaf: false,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.reached.has('publish')).toBe(true);

		hangUp(adapter, room);
		expect(liveTracks()).toEqual([]);
		releasePublish();
		await vi.advanceTimersByTimeAsync(PUBLISH_SIGNAL_TIMEOUT_MS + 1_000);
		await reconciled;

		expect(liveTracks()).toEqual([]);
		expect(adapter.isMicrophoneFailureLatched()).toBe(false);
		expect(h.updateSelfMute).not.toHaveBeenCalled();
		expect(h.syncVoiceState).not.toHaveBeenCalled();
	});

	it('does not report the microphone as granted or sync the voice state when the room hangs up during the enable', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		connect(room);
		const releaseWarmup = gate('warmup');
		const ensured = adapter.ensureMicrophone(room as never, 'channel-1');
		await vi.advanceTimersByTimeAsync(0);
		expect(h.reached.has('warmup')).toBe(true);

		hangUp(adapter, room);
		releaseWarmup();
		await vi.advanceTimersByTimeAsync(PUBLISH_SIGNAL_TIMEOUT_MS + 1_000);
		await ensured;

		expect(h.permissionGranted).not.toHaveBeenCalled();
		expect(h.syncVoiceState).not.toHaveBeenCalled();
		expect(liveTracks()).toEqual([]);
	});

	it('a capture-settings refresh does not restart the microphone of a room that hung up meanwhile', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		connect(room);
		await adapter.enableMicrophone(room as never, 'channel-1');
		const [publication] = room.localParticipant.audioTrackPublications.values() as Iterable<{
			track: FakeLocalAudioTrack;
		}>;
		publication.track.constraints = {noiseSuppression: true};
		h.browserNoiseSuppression = false;
		const releaseConfigure = gate('configure');
		const refreshed = adapter.requestMicrophoneRefresh(room as never, {republish: false});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.reached.has('configure')).toBe(true);

		hangUp(adapter, room);
		await vi.advanceTimersByTimeAsync(ROOM_CLEANUP_DELAY_MS);
		releaseConfigure();
		await vi.advanceTimersByTimeAsync(1_000);
		await refreshed;

		expect(h.captured).toHaveLength(1);
		expect(liveTracks()).toEqual([]);
	});

	function holdRefreshQueue(room: FakeRoom): () => void {
		microphoneTrackOf(room).constraints = {noiseSuppression: true};
		h.browserNoiseSuppression = false;
		return gate('configure');
	}

	it('a republish queued before the hang-up leaves the microphone of the next room alone', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		await adapter.enableMicrophone(previousRoom as never, 'channel-1');
		const releaseQueue = holdRefreshQueue(previousRoom);
		void adapter.requestMicrophoneRefresh(previousRoom as never, {republish: false});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.reached.has('configure')).toBe(true);
		const republished = adapter.requestMicrophoneRefresh(previousRoom as never, {republish: true});

		hangUp(adapter, previousRoom);
		const nextRoom = new FakeRoom();
		connect(nextRoom);
		h.browserNoiseSuppression = undefined;
		await adapter.enableMicrophone(nextRoom as never, 'channel-2');
		const nextCapture = microphoneTrackOf(nextRoom);
		expect(isSpeakingMetered(nextCapture)).toBe(true);
		releaseQueue();
		await vi.advanceTimersByTimeAsync(1_000);
		await republished;

		expect(isSpeakingMetered(nextCapture)).toBe(true);
		expect(nextRoom.localParticipant.audioTrackPublications.size).toBe(1);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
	});

	it('a republish queued before the hang-up does not open the microphone of the old room while rejoining', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom(5_000);
		connect(previousRoom);
		await adapter.enableMicrophone(previousRoom as never, 'channel-1');
		const releaseQueue = holdRefreshQueue(previousRoom);
		void adapter.requestMicrophoneRefresh(previousRoom as never, {republish: false});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.reached.has('configure')).toBe(true);
		const republished = adapter.requestMicrophoneRefresh(previousRoom as never, {republish: true});

		hangUp(adapter, previousRoom);
		h.connecting = true;
		releaseQueue();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(previousRoom.publishCallsAfterHangUp).toBe(0);
		expect(liveTracks()).toEqual([]);
		await vi.advanceTimersByTimeAsync(PUBLISH_SIGNAL_TIMEOUT_MS);
		await republished;
	});
});

describe('microphone enable keeps working across legitimate room changes', () => {
	it('unpublishes and stops a capture published to a room replaced by a region hot-swap, then enables the new room', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		const releaseUnmute = gate('unmute');
		const pending = adapter.enableMicrophone(previousRoom as never, 'channel-1');
		await vi.advanceTimersByTimeAsync(0);
		expect(previousRoom.localParticipant.audioTrackPublications.size).toBe(1);

		const nextRoom = new FakeRoom();
		h.activeRoom = nextRoom;
		releaseUnmute();
		await vi.advanceTimersByTimeAsync(0);
		await pending;

		expect(previousRoom.localParticipant.audioTrackPublications.size).toBe(0);
		expect(liveTracks()).toEqual([]);

		await adapter.enableMicrophone(nextRoom as never, 'channel-1');

		expect(nextRoom.localParticipant.audioTrackPublications.size).toBe(1);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
	});

	it('keeps the microphone a region hot-swap moved to the new room live when the enable of the old room ends afterwards', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		const releaseUnmute = gate('unmute');
		const pending = adapter.enableMicrophone(previousRoom as never, 'channel-1');
		await vi.advanceTimersByTimeAsync(0);
		expect(previousRoom.localParticipant.audioTrackPublications.size).toBe(1);

		const nextRoom = new FakeRoom();
		await republishLocalTracks(previousRoom, nextRoom);
		h.activeRoom = nextRoom;
		releaseUnmute();
		await vi.advanceTimersByTimeAsync(0);
		await pending;

		expect(previousRoom.localParticipant.audioTrackPublications.size).toBe(0);
		expect(microphoneTrackOf(nextRoom).mediaStreamTrack.readyState).toBe('live');
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);

		previousRoom.disconnect(false);
		await vi.advanceTimersByTimeAsync(ROOM_CLEANUP_DELAY_MS);
		hangUp(adapter, nextRoom);
		await vi.advanceTimersByTimeAsync(ROOM_CLEANUP_DELAY_MS);

		expect(liveTracks()).toEqual([]);
	});

	it('a microphone a region hot-swap moved to the new room during the enable drives the speaking indicator and the capture lifecycle', async () => {
		const adapter = await createAdapter();
		const lifecycle = {bind: vi.fn(() => true), unbind: vi.fn(), reportLifecycle: vi.fn()};
		adapter.setSourceLifecycleBridge(lifecycle as never);
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		const releaseUnmute = gate('unmute');
		const pending = adapter.enableMicrophone(previousRoom as never, 'channel-1');
		await vi.advanceTimersByTimeAsync(0);
		const capture = microphoneTrackOf(previousRoom);

		const nextRoom = new FakeRoom();
		await republishLocalTracks(previousRoom, nextRoom);
		h.activeRoom = nextRoom;
		releaseUnmute();
		await pending;

		expect(isSpeakingMetered(capture)).toBe(true);
		const captureId = `voice-mic:${capture.mediaStreamTrack.id}`;
		expect(lifecycle.bind).toHaveBeenCalledWith({captureId, sourceId: captureId});
		expect(microphoneState(adapter)).toBe('enabled');
	});

	it.each(['ensureDevices', 'warmup', 'getUserMedia', 'unmute'])(
		'an enable abandoned at %s because a region hot-swap replaced the room settles as disabled',
		async (stepName) => {
			const adapter = await createAdapter();
			const previousRoom = new FakeRoom();
			connect(previousRoom);
			const releaseStep = gate(stepName);
			const pending = adapter.enableMicrophone(previousRoom as never, 'channel-1');
			await vi.advanceTimersByTimeAsync(0);
			expect(h.reached.has(stepName)).toBe(true);
			expect(microphoneState(adapter)).toBe('enabling');

			h.activeRoom = new FakeRoom();
			releaseStep();
			await pending;

			expect(microphoneState(adapter)).toBe('disabled');
			expect(liveTracks()).toEqual([]);
		},
	);

	it('an enable whose device permission fails after a region hot-swap replaced the room settles as disabled', async () => {
		h.desktop = true;
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		let deny!: (error: Error) => void;
		h.gates.set(
			'nativePermission',
			new Promise<void>((_, reject) => {
				deny = reject;
			}),
		);
		const pending = adapter.enableMicrophone(previousRoom as never, 'channel-1');
		await vi.advanceTimersByTimeAsync(0);
		expect(microphoneState(adapter)).toBe('enabling');

		h.activeRoom = new FakeRoom();
		deny(new Error('Permission denied'));
		await pending;

		expect(microphoneState(adapter)).toBe('disabled');
		expect(adapter.isMicrophoneFailureLatched()).toBe(false);
	});

	it('an enable abandoned for the previous room leaves the media state of the next room alone', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		const releasePublish = gate('publish');
		void adapter.enableMicrophone(previousRoom as never, 'channel-1').catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		hangUp(adapter, previousRoom);
		releasePublish();
		const nextRoom = new FakeRoom();
		connect(nextRoom);
		await adapter.enableMicrophone(nextRoom as never, 'channel-2');
		expect(microphoneState(adapter)).toBe('enabled');

		await vi.advanceTimersByTimeAsync(PUBLISH_SIGNAL_TIMEOUT_MS + 1_000);

		expect(previousRoom.publishCallsAfterHangUp).toBe(1);
		expect(microphoneState(adapter)).toBe('enabled');
	});

	it('leaves no live microphone after a region hot-swap once the user hangs up', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		await adapter.enableMicrophone(previousRoom as never, 'channel-1');
		const nextRoom = new FakeRoom();
		await completeHotSwap(previousRoom, nextRoom);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);

		hangUp(adapter, nextRoom);
		await vi.advanceTimersByTimeAsync(ROOM_CLEANUP_DELAY_MS);

		expect(liveTracks()).toEqual([]);
	});

	it('turning the microphone off after a region hot-swap releases the capture', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		await adapter.enableMicrophone(previousRoom as never, 'channel-1');
		const nextRoom = new FakeRoom();
		await completeHotSwap(previousRoom, nextRoom);

		await adapter.disableMicrophone(nextRoom as never);

		expect(liveTracks()).toEqual([]);
		await adapter.enableMicrophone(nextRoom as never, 'channel-1');
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
	});

	it('a reconnect to the same channel after a region hot-swap keeps a single live microphone capture', async () => {
		const adapter = await createAdapter();
		const firstRoom = new FakeRoom();
		connect(firstRoom);
		await adapter.enableMicrophone(firstRoom as never, 'channel-1');
		const swappedRoom = new FakeRoom();
		await completeHotSwap(firstRoom, swappedRoom);
		const reconnectedRoom = new FakeRoom();
		await reconnectSameChannel(swappedRoom, reconnectedRoom);

		await adapter.ensureMicrophone(reconnectedRoom as never, 'channel-1');

		expect(h.captured).toHaveLength(2);
		expect(reconnectedRoom.localParticipant.audioTrackPublications.size).toBe(1);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
	});

	it('a channel change does not wait for the hung publish of the previous room', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		const releasePublish = gate('publish');
		void adapter.enableMicrophone(previousRoom as never, 'channel-1').catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.reached.has('publish')).toBe(true);

		hangUp(adapter, previousRoom);
		releasePublish();
		const nextRoom = new FakeRoom();
		connect(nextRoom);
		const enabled = adapter.enableMicrophone(nextRoom as never, 'channel-2');
		await vi.advanceTimersByTimeAsync(1_000);

		expect(nextRoom.localParticipant.audioTrackPublications.size).toBe(1);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);

		await vi.advanceTimersByTimeAsync(PUBLISH_SIGNAL_TIMEOUT_MS);
		await enabled;

		expect(nextRoom.localParticipant.audioTrackPublications.size).toBe(1);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
		expect(adapter.isMicrophoneFailureLatched()).toBe(false);
	});

	it('rejoining the same channel after a hang-up during the enable publishes a live microphone', async () => {
		const adapter = await createAdapter();
		const previousRoom = new FakeRoom();
		connect(previousRoom);
		const releaseWarmup = gate('warmup');
		void adapter.enableMicrophone(previousRoom as never, 'channel-1').catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		hangUp(adapter, previousRoom);
		releaseWarmup();
		await vi.advanceTimersByTimeAsync(1_000);

		const nextRoom = new FakeRoom();
		connect(nextRoom);
		await adapter.enableMicrophone(nextRoom as never, 'channel-1');

		expect(previousRoom.publishCallsAfterHangUp).toBe(0);
		expect(nextRoom.localParticipant.audioTrackPublications.size).toBe(1);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
	});

	it('publishes while the room is connected but the connection has not stored it as ready yet', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		h.connecting = true;

		await adapter.enableMicrophone(room as never, 'channel-1');

		expect(room.localParticipant.audioTrackPublications.size).toBe(1);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
	});

	it('a hang-up before the connection stored the room as ready leaves no live microphone', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		h.connecting = true;
		const releaseCapture = gate('getUserMedia');
		void adapter.enableMicrophone(room as never, 'channel-1').catch(() => {});
		await vi.advanceTimersByTimeAsync(0);

		hangUp(adapter, room);
		releaseCapture();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(room.publishCallsAfterHangUp).toBe(0);
		expect(liveTracks()).toEqual([]);
	});

	it('push-to-talk publishes a live microphone that stays muted until the key is held', async () => {
		const adapter = await createAdapter();
		const room = new FakeRoom();
		connect(room);
		h.pushToTalk = true;
		h.selfMute = true;

		await adapter.ensureMicrophone(room as never, 'channel-1');

		const [publication] = room.localParticipant.audioTrackPublications.values() as Iterable<{
			isMuted: boolean;
			track: FakeLocalAudioTrack;
		}>;
		expect(publication.track.isMuted).toBe(true);
		expect(publication.isMuted).toBe(true);
		expect(liveTracks()).toEqual(LIVE_MICROPHONE);
		expect(h.permissionGranted).toHaveBeenCalled();
		expect(h.syncVoiceState).toHaveBeenCalledWith({self_mute: true});
	});
});
