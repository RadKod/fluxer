// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {type Room, RoomEvent} from 'livekit-client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({
	electron: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));

vi.mock('@app/features/ui/utils/NativeUtils', () => ({getElectronAPI: () => env.electron}));

import {resetBrowserVoiceDebugEventSinkPopoutForTests} from '@app/features/voice/diagnostics/VoiceDebugBrowserEventSinkPopout';
import {
	VOICE_ENGINE_V2_APP_DEBUG_EVENT_SINK_MAX_ENTRIES,
	VoiceEngineV2AppDebugEventSinkHostAdapter,
} from '@app/features/voice/engine/v2/VoiceEngineV2AppDebugEventSinkHostAdapter';
import type {DesktopVoiceDebugEventSinkEntry} from '@app/types/electron.d';

type Handler = (...args: Array<unknown>) => void;

const HISTORY_BYTE_BUDGET = 4 * 1024 * 1024;

function createFakeRoom(): {room: Room; emit: (event: RoomEvent, ...args: Array<unknown>) => void} {
	const handlers = new Map<RoomEvent, Set<Handler>>();
	const room = {
		name: 'room',
		state: 'connected',
		numParticipants: 1,
		localParticipant: undefined,
		remoteParticipants: new Map(),
		on(event: RoomEvent, handler: Handler) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)?.add(handler);
			return room;
		},
		off(event: RoomEvent, handler: Handler) {
			handlers.get(event)?.delete(handler);
			return room;
		},
	};
	return {
		room: room as unknown as Room,
		emit: (event, ...args) => {
			for (const handler of handlers.get(event) ?? []) handler(...args);
		},
	};
}

function createParticipant(identity: string, metadataChars: number): unknown {
	return {
		identity,
		sid: `PA_${identity}`,
		isLocal: false,
		metadata: 'm'.repeat(metadataChars),
		trackPublications: new Map(),
	};
}

function historyBytes(entries: ReadonlyArray<DesktopVoiceDebugEventSinkEntry>): number {
	return entries.reduce((total, entry) => total + entry.line.length * 2, 0);
}

function createDesktopApi(): Record<string, ReturnType<typeof vi.fn>> {
	return {
		openVoiceDebugEventSinkPopout: vi.fn(async () => undefined),
		appendVoiceDebugEventSinkEntries: vi.fn(),
		setVoiceDebugEventSinkStatsHtml: vi.fn(),
	};
}

describe('VoiceEngineV2AppDebugEventSinkHostAdapter history', () => {
	beforeEach(() => {
		env.electron = null;
		resetBrowserVoiceDebugEventSinkPopoutForTests();
	});

	afterEach(() => {
		resetBrowserVoiceDebugEventSinkPopoutForTests();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('drops the oldest events once the byte budget is exceeded and keeps the newest', () => {
		const adapter = new VoiceEngineV2AppDebugEventSinkHostAdapter();
		const {room, emit} = createFakeRoom();
		adapter.start({guildId: null, channelId: 'channel', connectionId: 'connection', room});
		const largeEventCount = 40;
		for (let index = 0; index < largeEventCount; index += 1) {
			emit(RoomEvent.ParticipantConnected, createParticipant(`user-${index}`, 200_000));
		}
		const entries = adapter.getEventSinkEntries();
		expect(largeEventCount).toBeLessThan(VOICE_ENGINE_V2_APP_DEBUG_EVENT_SINK_MAX_ENTRIES);
		expect(historyBytes(entries)).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.length).toBeLessThan(largeEventCount);
		expect(entries.at(-1)?.sequence).toBe(largeEventCount + 1);
		const sequences = entries.map((entry) => entry.sequence);
		expect(sequences).toEqual(sequences.map((_, index) => sequences[0] + index));
		expect(entries.at(-1)?.line).toContain('user-39');
	});

	it('keeps the entry count limit for small events', () => {
		const adapter = new VoiceEngineV2AppDebugEventSinkHostAdapter();
		const {room, emit} = createFakeRoom();
		adapter.start({guildId: null, channelId: 'channel', connectionId: 'connection', room});
		for (let index = 0; index < VOICE_ENGINE_V2_APP_DEBUG_EVENT_SINK_MAX_ENTRIES + 50; index += 1) {
			emit(RoomEvent.ParticipantConnected, createParticipant(`user-${index}`, 0));
		}
		const entries = adapter.getEventSinkEntries();
		expect(entries).toHaveLength(VOICE_ENGINE_V2_APP_DEBUG_EVENT_SINK_MAX_ENTRIES);
		expect(entries.at(-1)?.sequence).toBe(VOICE_ENGINE_V2_APP_DEBUG_EVENT_SINK_MAX_ENTRIES + 51);
	});

	it('sends no desktop IPC for events until the desktop window is opened', async () => {
		const desktop = createDesktopApi();
		env.electron = desktop;
		const adapter = new VoiceEngineV2AppDebugEventSinkHostAdapter();
		const {room, emit} = createFakeRoom();
		adapter.start({guildId: null, channelId: 'channel', connectionId: 'connection', room});
		emit(RoomEvent.ParticipantConnected, createParticipant('before-open', 10));
		expect(desktop.appendVoiceDebugEventSinkEntries).not.toHaveBeenCalled();
		await adapter.openEventSinkPopout();
		const openedWith = desktop.openVoiceDebugEventSinkPopout.mock
			.calls[0]?.[0] as Array<DesktopVoiceDebugEventSinkEntry>;
		expect(openedWith.map((entry) => entry.sequence)).toEqual([1, 2]);
		emit(RoomEvent.ParticipantConnected, createParticipant('after-open', 10));
		expect(desktop.appendVoiceDebugEventSinkEntries).toHaveBeenCalledTimes(1);
	});

	it('keeps the browser window history within the byte budget while it is open', async () => {
		vi.stubGlobal('BroadcastChannel', undefined);
		const popout = {closed: false, focus: vi.fn(), postMessage: vi.fn()};
		vi.spyOn(window, 'open').mockReturnValue(popout as unknown as Window);
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:popout');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
		const adapter = new VoiceEngineV2AppDebugEventSinkHostAdapter();
		const {room, emit} = createFakeRoom();
		adapter.start({guildId: null, channelId: 'channel', connectionId: 'connection', room});
		await adapter.openEventSinkPopout();
		for (let index = 0; index < 40; index += 1) {
			emit(RoomEvent.ParticipantConnected, createParticipant(`user-${index}`, 200_000));
		}
		popout.postMessage.mockClear();
		window.dispatchEvent(
			new MessageEvent('message', {data: {protocol: 'fluxer.voice.debug.event_sink.v1', type: 'ready'}}),
		);
		const snapshot = popout.postMessage.mock.calls
			.map(([message]) => message as {type: string; entries?: Array<DesktopVoiceDebugEventSinkEntry>})
			.find((message) => message.type === 'setEntries');
		expect(snapshot?.entries?.length).toBeGreaterThan(0);
		expect(historyBytes(snapshot?.entries ?? [])).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
	});
});
