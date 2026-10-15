// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import {makeAutoObservable, observable, observableRef, runInAction} from 'mobx';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	media: {
		connected: true,
		reconnecting: false,
		guildId: 'guild',
		channelId: 'channel',
		connectionId: 'connection',
		getVoiceStateByConnectionId: vi.fn(),
		getAllVoiceStatesInChannel: vi.fn(),
	},
	settings: {accountId: 'account', disabled: false, volume: 1, setAccount: vi.fn(), dispose: vi.fn()},
	audio: {effectiveMute: false, effectiveDeaf: false},
	localMute: false,
	load: vi.fn(),
	getSound: vi.fn(),
	play: vi.fn(),
	configure: vi.fn(),
	invalidate: vi.fn(),
	dispose: vi.fn(),
	libraryReset: vi.fn(),
	libraryDispose: vi.fn(),
	changed: vi.fn(),
	subscribe: vi.fn(),
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: state.media}));
vi.mock('@app/features/voice/engine/VoiceEffectiveAudioState', () => ({getEffectiveAudioState: () => state.audio}));
vi.mock('@app/features/voice/state/ParticipantVolume', () => ({
	default: {isLocalMuted: () => state.localMute, subscribe: state.subscribe},
}));
vi.mock('@app/features/voice/state/SoundboardSettings', () => ({default: state.settings}));
vi.mock('@app/features/voice/state/SoundboardLibrary', () => ({
	default: {load: state.load, getSound: state.getSound, reset: state.libraryReset, dispose: state.libraryDispose},
}));
vi.mock('@app/features/voice/engine/SoundboardPlaybackEngine', () => ({
	default: {play: state.play, configure: state.configure, invalidate: state.invalidate, dispose: state.dispose},
}));
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({
	default: {foregroundConnection: {sessionId: 'receiver-session'}},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {getCurrentUser: () => ({id: 'receiver'}), viewAccountKey: 'account'},
}));

import {
	handleSoundboardPlay,
	initSoundboardRuntime,
	isSoundboardPlaybackEligible,
	resetSoundboardPlay,
	type SoundboardPlayPayload,
} from './SoundboardPlay';

makeAutoObservable(state.settings, {setAccount: false, dispose: false});
const runtime = observable(
	{actors: {} as Record<string, {user_id: string; channel_id: string; session_id: string; mute?: boolean}>},
	{actors: observableRef},
);

const context = {
	accountKey: 'account',
	expectedUserId: 'receiver',
	socket: {getSessionId: () => 'receiver-session'},
} as unknown as GatewayHandlerContext;
function event(overrides: Partial<SoundboardPlayPayload> = {}): SoundboardPlayPayload {
	return {
		guild_id: 'guild',
		channel_id: 'channel',
		sound_id: 'sound',
		actor_id: 'actor',
		session_id: 'actor-session',
		event_id: 'event',
		server_time: Date.now(),
		asset_version: 'a'.repeat(64),
		volume: 1,
		recipient_connection_id: 'connection',
		recipient_soundboard_epoch: 3,
		...overrides,
	};
}

describe('soundboard event admission', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetSoundboardPlay();
		Object.assign(state.media, {
			connected: true,
			reconnecting: false,
			guildId: 'guild',
			channelId: 'channel',
			connectionId: 'connection',
		});
		Object.assign(state.settings, {accountId: 'account', disabled: false, volume: 1});
		Object.assign(state.audio, {effectiveMute: false, effectiveDeaf: false});
		state.localMute = false;
		state.media.getVoiceStateByConnectionId.mockReturnValue({
			user_id: 'receiver',
			channel_id: 'channel',
			session_id: 'receiver-session',
			soundboard_epoch: 3,
		});
		state.media.getAllVoiceStatesInChannel.mockReturnValue({
			actor: {user_id: 'actor', channel_id: 'channel', session_id: 'actor-session'},
		});
		state.load.mockResolvedValue(undefined);
		state.getSound.mockReturnValue({
			id: 'sound',
			guild_id: 'guild',
			asset_hash: 'a'.repeat(64),
			url: 'https://cdn.example/sound.mp3',
			size_bytes: 12,
			duration_ms: 200,
		});
	});

	it('uses the actor session and rejects a duplicate live event', async () => {
		await handleSoundboardPlay(event(), context);
		await handleSoundboardPlay(event(), context);
		expect(state.play).toHaveBeenCalledTimes(1);
		expect(state.play.mock.calls[0][0]).toMatchObject({actorSessionId: 'actor-session', recipientSoundboardEpoch: 3});
	});

	it.each([
		{guild_id: 'wrong'},
		{channel_id: 'wrong'},
		{recipient_connection_id: 'wrong'},
		{recipient_soundboard_epoch: 2},
		{session_id: 'receiver-session'},
		{server_time: NaN},
	])('drops an ineligible identity or invalid timestamp before loading: %o', async (change) => {
		await handleSoundboardPlay(event(change), context);
		expect(state.load).not.toHaveBeenCalled();
		expect(state.play).not.toHaveBeenCalled();
	});

	it.each([-10000, 10000])('plays a live event when the server clock differs by %i ms', async (offset) => {
		await handleSoundboardPlay(event({server_time: Date.now() + offset}), context);
		expect(state.play).toHaveBeenCalledOnce();
	});

	it('ignores wall clock corrections while metadata is being loaded', async () => {
		let complete!: () => void;
		state.load.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
		);
		const data = event();
		const pending = handleSoundboardPlay(data, context);
		const clock = vi.spyOn(Date, 'now').mockReturnValue(data.server_time + 10000);
		try {
			complete();
			await pending;
			expect(state.play).toHaveBeenCalledOnce();
		} finally {
			clock.mockRestore();
		}
	});

	it('drops metadata that took over five local monotonic seconds to arrive', async () => {
		let complete!: () => void;
		state.load.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
		);
		const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
		try {
			const pending = handleSoundboardPlay(event(), context);
			clock.mockReturnValue(6001);
			complete();
			await pending;
			expect(state.play).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	it('does not invalidate playback or dedupe when volume changes', () => {
		state.configure.mockImplementation(() => {});
		const dispose = initSoundboardRuntime();
		try {
			for (const volume of [0.8, 0.4, 0])
				runInAction(() => {
					state.settings.volume = volume;
				});
			expect(state.invalidate).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it('drops snapshot replay without a live socket and wrong account context', async () => {
		await handleSoundboardPlay(event(), {...context, socket: null});
		await handleSoundboardPlay(event(), {...context, isReplay: true});
		await handleSoundboardPlay(event(), {...context, accountKey: 'other'});
		expect(state.load).not.toHaveBeenCalled();
	});

	it.each(['disabled', 'localMute', 'effectiveMute', 'effectiveDeaf'] as const)(
		'applies %s before metadata fetch',
		async (flag) => {
			if (flag === 'disabled') state.settings.disabled = true;
			else if (flag === 'localMute') state.localMute = true;
			else state.audio[flag] = true;
			await handleSoundboardPlay(event(), context);
			expect(state.load).not.toHaveBeenCalled();
		},
	);

	it('rejects a late metadata response after channel leave and return increments epoch', async () => {
		let complete!: () => void;
		state.load.mockReturnValue(
			new Promise<void>((resolve) => {
				complete = resolve;
			}),
		);
		const pending = handleSoundboardPlay(event(), context);
		state.media.getVoiceStateByConnectionId.mockReturnValue({
			user_id: 'receiver',
			channel_id: 'channel',
			session_id: 'receiver-session',
			soundboard_epoch: 5,
		});
		complete();
		await pending;
		expect(state.play).not.toHaveBeenCalled();
	});

	it('requires metadata hash to match the event asset version', async () => {
		state.getSound.mockReturnValue({asset_hash: 'b'.repeat(64)});
		await handleSoundboardPlay(event(), context);
		expect(state.play).not.toHaveBeenCalled();
	});

	it('notifies playback when the active actor changes or is locally muted and releases listeners', async () => {
		let participantListener: (() => void) | null = null;
		let unsubscribe: (() => void) | null = null;
		const stopParticipant = vi.fn(() => {
			participantListener = null;
		});
		state.subscribe.mockImplementation((listener: () => void) => {
			participantListener = listener;
			return stopParticipant;
		});
		state.configure.mockImplementation((deps: {subscribe: (listener: () => void) => () => void}) => {
			unsubscribe?.();
			unsubscribe = deps.subscribe(state.changed);
		});
		state.dispose.mockImplementation(() => {
			unsubscribe?.();
			unsubscribe = null;
		});
		runtime.actors = {actor: {user_id: 'actor', channel_id: 'channel', session_id: 'actor-session'}};
		state.media.getAllVoiceStatesInChannel.mockImplementation(() => runtime.actors);
		const dispose = initSoundboardRuntime();
		await handleSoundboardPlay(event(), context);
		const params = state.play.mock.calls[0][0];
		expect(isSoundboardPlaybackEligible(params)).toBe(true);
		runInAction(() => {
			runtime.actors = {actor: {...runtime.actors.actor, mute: true}};
		});
		expect(state.changed).toHaveBeenCalledTimes(1);
		expect(isSoundboardPlaybackEligible(params)).toBe(false);
		state.localMute = true;
		(participantListener as (() => void) | null)?.();
		expect(state.changed).toHaveBeenCalledTimes(2);
		dispose();
		expect(stopParticipant).toHaveBeenCalledTimes(1);
		expect(participantListener).toBeNull();
		expect(state.libraryDispose).toHaveBeenCalledTimes(1);
		state.changed.mockClear();
		runInAction(() => {
			runtime.actors = {};
			state.settings.disabled = true;
		});
		expect(state.changed).not.toHaveBeenCalled();
	});

	it('does not let an older root cleanup dispose a replacement runtime', () => {
		state.configure.mockImplementation(() => {});
		state.dispose.mockImplementation(() => {});
		const first = initSoundboardRuntime();
		const second = initSoundboardRuntime();
		state.dispose.mockClear();
		first();
		expect(state.dispose).not.toHaveBeenCalled();
		second();
		expect(state.dispose).toHaveBeenCalledTimes(1);
	});
});
