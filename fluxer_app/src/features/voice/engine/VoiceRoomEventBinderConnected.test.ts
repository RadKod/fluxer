// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomEventCallbacks, RoomEventDependencies} from '@app/features/voice/engine/VoiceRoomEventBinder';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));

const h = vi.hoisted(() => ({latestAttemptId: 1}));

vi.mock('@app/features/notification/utils/SoundUtils', () => ({SoundType: {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class Logger {
		static create() {
			return new Logger();
		}
		debug() {}
		info() {}
		warn() {}
		error() {}
	},
}));
vi.mock('@app/features/ui/commands/SoundCommands', () => ({playSound: () => {}}));
vi.mock('@app/features/voice/engine/ScreenShareCodecNegotiation', () => ({
	default: {bind: () => () => {}, dispose: () => {}},
}));
vi.mock('@app/features/voice/engine/ScreenSharePublicationMigration', () => ({
	default: {bind: () => () => {}, dispose: () => {}},
}));
vi.mock('@app/features/voice/engine/VoiceEffectiveAudioState', () => ({
	getEffectiveAudioState: () => ({effectiveDeaf: false}),
}));
vi.mock('@app/features/voice/engine/VoiceIdleActivityBridge', () => ({noteLocalVoiceActivity: () => {}}));
vi.mock('@app/features/voice/engine/mesh/VoiceMeshRoom', () => ({isVoiceMeshRoom: () => false}));
vi.mock('@app/features/voice/engine/VoiceMediaGraphStore', () => ({voiceMediaGraphStore: {}}));
vi.mock('@app/features/voice/engine/VoiceSelfJoinChime', () => ({
	playSelfJoinChimeOnce: async () => false,
	startVoiceJoinChimeSequence: async () => {},
}));
vi.mock('@app/features/voice/engine/VoiceStreamWatchState', () => ({
	cancelDeferredStopWatchingStreamKey: () => {},
	deferStopWatchingStreamKey: () => {},
	getStreamKeyForParticipantIdentity: () => null,
}));
vi.mock('@app/features/voice/engine/VoiceTrackSource', () => ({VoiceTrackSource: {}}));
vi.mock('@app/features/voice/state/ParticipantVolume', () => ({default: {}}));
vi.mock('@app/features/voice/state/ScreenShareWatchFailures', () => ({
	ScreenShareWatchErrorCode: {},
	ScreenShareWatchFailures: {},
}));
vi.mock('@app/features/voice/utils/ScreenShareCodecDiagnostics', () => ({
	monitorScreenShareDecodeHealth: () => () => {},
}));
vi.mock('@app/features/voice/utils/VideoDecoderCapabilities', () => ({markScreenShareDecodeFailure: () => false}));
vi.mock('livekit-client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('livekit-client')>();
	const eventNames = new Proxy({}, {get: (_target, key) => String(key)});
	return {
		...actual,
		ConnectionState: {Disconnected: 'disconnected', Connecting: 'connecting', Connected: 'connected'},
		ParticipantEvent: eventNames,
		RoomEvent: eventNames,
		Track: {Source: {}, Kind: {Audio: 'audio', Video: 'video'}},
	};
});

class FakeRoom {
	state = 'connecting';
	readonly handlers = new Map<string, () => void>();
	readonly remoteParticipants = new Map<string, object>();
	readonly localParticipant = {identity: 'user_1_connection-1', on() {}, off() {}};

	on(event: string, handler: () => void): this {
		this.handlers.set(event, handler);
		return this;
	}
}

function createDependencies(playEntranceSound: () => Promise<void>) {
	const ensureMicrophone = vi.fn(async () => {});
	const syncWithPermissionState = vi.fn();
	const applyAllLocalAudioPreferences = vi.fn();
	const noop = () => {};
	const dependencies = {
		connection: {
			createGuardedHandler:
				(attemptId: number, handler: (...args: Array<unknown>) => void | Promise<void>) =>
				(...args: Array<unknown>) => {
					if (attemptId !== h.latestAttemptId) return;
					void handler(...args);
				},
			isDisconnecting: () => false,
			isUserMovePending: () => false,
			markConnected: noop,
			markDisconnected: noop,
			markReconnecting: noop,
			markReconnected: noop,
		},
		media: {applyAllLocalAudioPreferences, ensureMicrophone, playEntranceSound, resetStreamTracking: noop},
		mediaState: {handleLocalTrackStateChange: () => false, resetLocalMediaState: noop},
		participants: {
			clear: noop,
			hydrateFromRoom: noop,
			removeParticipant: noop,
			updateActiveSpeakers: noop,
			upsertParticipant: noop,
		},
		permissions: {applyDeafen: noop, syncWithPermissionState},
		remoteSpeaking: {
			attachIfApplicable: noop,
			clear: noop,
			detachByIdentity: noop,
			detachIfTrackMatches: noop,
			hydrateFromRoom: noop,
		},
		screenShare: {
			cleanupLingeringScreenShareTracks: async () => {},
			handleLocalScreenShareTrackUnpublished: noop,
			isScreenSharePublicationReplaceInFlight: () => false,
		},
		subscriptions: {
			isScreenShareSubscribed: () => false,
			reattachScreenShareAfterPublish: noop,
			reconcileSubscriptions: noop,
		},
	} as unknown as RoomEventDependencies;
	return {dependencies, ensureMicrophone, syncWithPermissionState, applyAllLocalAudioPreferences};
}

const callbacks: RoomEventCallbacks = {
	onConnected: async () => {},
	onDisconnected: () => {},
	onReconnecting: () => {},
	onReconnected: () => {},
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	h.latestAttemptId = 1;
});

describe('voice room connected handler', () => {
	it('does not open the microphone when the connection attempt went stale while the room was connecting', async () => {
		const {bindRoomEvents} = await import('@app/features/voice/engine/VoiceRoomEventBinder');
		let releaseEntranceSound!: () => void;
		const entranceSound = new Promise<void>((resolve) => {
			releaseEntranceSound = resolve;
		});
		const room = new FakeRoom();
		const deps = createDependencies(() => entranceSound);
		bindRoomEvents(room as never, 1, 'guild-1', 'channel-1', callbacks, deps.dependencies);

		room.handlers.get('Connected')?.();
		await flush();
		h.latestAttemptId = 2;
		releaseEntranceSound();
		await flush();

		expect(deps.syncWithPermissionState).not.toHaveBeenCalled();
		expect(deps.ensureMicrophone).not.toHaveBeenCalled();
	});

	it('opens the microphone for the latest connection attempt', async () => {
		const {bindRoomEvents} = await import('@app/features/voice/engine/VoiceRoomEventBinder');
		const room = new FakeRoom();
		const deps = createDependencies(async () => {});
		bindRoomEvents(room as never, 1, 'guild-1', 'channel-1', callbacks, deps.dependencies);

		room.handlers.get('Connected')?.();
		await flush();

		expect(deps.syncWithPermissionState).toHaveBeenCalledWith('guild-1', 'channel-1', room);
		expect(deps.ensureMicrophone).toHaveBeenCalledWith(room, 'channel-1');
		expect(deps.applyAllLocalAudioPreferences).toHaveBeenCalledWith(room);
	});
});
