// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import type {TrackReferenceOrPlaceholder} from '@livekit/components-react';
import {observer} from 'mobx-react-lite';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({
	room: true,
	tv: false,
	layout: 'focus',
	track: null as TrackReferenceOrPlaceholder | null,
}));
const applyAudio = vi.hoisted(() => vi.fn());
const mediaUpdates = vi.hoisted(() => ({version: 0, listeners: new Set<() => void>()}));

vi.mock('@lingui/core/macro', () => ({msg: (value: unknown) => value, plural: () => '2 participants'}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (value: {message: string}) => value.message, locale: 'en'}}),
}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: vi.fn()}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {showFavorites: false}}));
vi.mock('@app/features/channel/utils/ChannelUtils', () => ({getIcon: () => null}));
vi.mock('@app/features/messaging/state/Favorites', () => ({default: {getChannel: () => null}}));
vi.mock('@app/features/platform/components/router/NavigationAdapter', () => ({goBackOr: vi.fn()}));
vi.mock('@app/features/table_game/components/TableGamesEntry', () => ({TableGamesEntry: () => null}));
vi.mock('@app/features/ui/action_menu/items/voice_participant_menu_data/shared', () => ({
	STREAM_VOLUME_DESCRIPTOR: {message: 'Stream Volume'},
}));
vi.mock('@app/features/ui/bottom_sheet/BottomSheet', () => ({BottomSheet: () => null}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/app/components/layout/NativeDragRegion', () => ({
	NativeDragRegion: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/ui/hooks/usePopout', () => ({usePopout: () => ({isOpen: false, openProps: {}})}));
vi.mock('@app/features/ui/overlay/PortalHostContext', async () => {
	const {createContext} = await import('react');
	return {PortalHostContext: createContext(null), setActivePortalHost: vi.fn()};
});
vi.mock('@app/features/ui/popover/PopoverPopout', () => ({Popout: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/state/ContextMenu', () => ({
	default: {contextMenu: null},
	isContextMenuNodeTarget: () => false,
}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: false}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/ui/state/Popout', () => ({default: {isOpen: () => false}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: () => null}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: () => 'Streamer'}));
vi.mock('@app/features/voice/components/CompactVoiceCallView', () => ({CompactVoiceCallView: () => null}));
vi.mock('@app/features/voice/components/popout/PoppedOutOverlay', () => ({PoppedOutOverlay: () => null}));
vi.mock('@app/features/voice/components/popout/PoppedOutSurfaceStateMachine', () => ({
	selectPoppedOutOverlayTransition: () => null,
	shouldRenderPoppedOutOverlay: () => false,
}));
vi.mock('@app/features/voice/components/popout/usePoppedOutTransition', () => ({
	usePoppedOutTransition: () => ({snapshot: null, handleTransitionEnd: vi.fn()}),
}));
vi.mock('@app/features/voice/components/StreamFocusHeaderInfo', () => ({StreamFocusHeaderInfo: () => null}));
vi.mock('@app/features/voice/components/useStreamSpectators', () => ({
	useStreamSpectators: () => ({viewerUsers: [], spectatorEntries: []}),
}));
vi.mock('@app/features/voice/components/useStreamTrackInfo', () => ({useStreamTrackInfo: () => ({})}));
// Keep the fullscreen view state hook real. Native fullscreen is supplied by the browser harness.
vi.mock('@app/features/voice/components/useVoiceCallAppFullscreen', async (original) => ({
	...(await original<object>()),
	useVoiceCallAppFullscreen: () => ({
		isFullscreen: false,
		supportsFullscreen: true,
		enterFullscreen: vi.fn(async () => {}),
		exitFullscreen: vi.fn(async () => {}),
		toggleFullscreen: vi.fn(),
	}),
}));
vi.mock('@app/features/voice/components/useVoiceCallTracksAndLayout', () => ({
	useVoiceCallTracksAndLayout: () => ({
		layoutMode: env.layout,
		pinnedParticipantIdentity: env.track?.participant.identity ?? null,
		hasScreenShare: env.track?.source === 'screen_share',
		filteredCameraTracks: [],
		gridEntries: [],
		focusMainTrack: env.track,
		carouselTracks: [],
		pipTrack: null,
		participantCount: 2,
	}),
}));
vi.mock('@app/features/voice/components/useVoiceEngineConnectionState', () => ({
	useVoiceEngineConnectionState: () => 'connected',
}));
vi.mock('@app/features/voice/components/VoiceCallLayoutContent', () => ({
	VoiceCallLayoutContent: ({
		layoutMode,
		focusMainTrack,
	}: {
		layoutMode: string;
		focusMainTrack: TrackReferenceOrPlaceholder | null;
	}) =>
		createElement('div', {
			'data-call-layout': layoutMode,
			'data-focused-identity': focusMainTrack?.participant.identity,
		}),
}));
vi.mock('@app/features/voice/components/VoiceControlBar', () => ({VoiceControlBar: () => null}));
vi.mock('@app/features/voice/components/VoiceRegionTeleportOverlay', () => ({VoiceRegionTeleportOverlay: () => null}));
vi.mock('@app/features/voice/components/VoiceParticipantAvatarList', () => ({
	useVoiceParticipantAvatarEntries: () => [],
	VoiceParticipantWrappedAvatarList: () => null,
}));
vi.mock('@app/features/voice/components/voice_connection_status/VoiceDetailsPopout', () => ({
	VoiceDetailsPopout: () => null,
}));
vi.mock('@app/features/voice/diagnostics/VoiceDebugStatsForwarder', () => ({VoiceDebugStatsForwarder: () => null}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', async () => {
	const {useSyncExternalStore} = await import('react');
	return {
		default: {applyLocalAudioPreferencesForUser: applyAudio},
		useMediaEngineVersion: () =>
			useSyncExternalStore(
				(listener) => {
					mediaUpdates.listeners.add(listener);
					return () => mediaUpdates.listeners.delete(listener);
				},
				() => mediaUpdates.version,
			),
	};
});
vi.mock('@app/features/voice/state/PopoutWindowManager', () => ({
	default: {isCallPopoutOpenForChannel: () => false},
	getVoiceCallPopoutKey: () => 'call',
	isVoicePopoutSupported: () => false,
}));
vi.mock('@app/features/voice/state/VoiceCallLayout', () => ({default: {focusMembersRowVisible: false}}));
vi.mock('@app/features/voice/utils/VoiceCallContext', () => ({hasValidRoomForVoiceCallContext: () => true}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: env.room}),
}));
vi.mock('@app/features/voice_scene/utils/WebglSupport', () => ({
	getWebglSupport: () => ({webgl2: true, renderer: 'GPU', hardwareConcurrency: 8, deviceMemory: 8}),
}));
vi.mock('@app/features/voice_scene/state/VoiceSceneTvRequest', () => ({useVoiceSceneTvFullscreen: () => env.tv}));
vi.mock('@app/features/voice_scene/components/VoiceSceneView', () => ({
	VoiceSceneView: () => createElement('div', {'data-room': true}),
}));
vi.mock('@app/features/channel/components/channel_header_components/ChannelHeaderIcon', () => ({
	ChannelHeaderIcon: ({label, onClick}: {label: string; onClick?: () => void}) =>
		createElement('button', {type: 'button', 'aria-label': label, onClick}, label),
}));
vi.mock('@app/features/channel/components/channel_header_components/UtilityButtons', () => ({
	InboxButton: () => null,
	StaffToolsButton: () => null,
}));
vi.mock('@app/features/voice/components/media_player/components/MediaVerticalVolumeControl', () => ({
	MediaVerticalVolumeControl: ({
		onVolumeChange,
		onToggleMute,
	}: {
		onVolumeChange: (volume: number) => void;
		onToggleMute: () => void;
	}) =>
		createElement(
			'div',
			{'data-stream-volume': true},
			createElement('button', {type: 'button', onClick: () => onVolumeChange(0.45)}, 'Set stream volume'),
			createElement('button', {type: 'button', onClick: onToggleMute}, 'Mute stream'),
		),
}));

const {VoiceCallView} = await import('./VoiceCallView');
const {useVoiceCallFullscreenViewState} = await import('./useVoiceCallAppFullscreen');
const {default: VoiceCallFullscreen} = await import('@app/features/voice/state/VoiceCallFullscreen');
const {default: VoiceSceneSettings} = await import('@app/features/voice_scene/state/VoiceSceneSettings');
const {default: StreamAudioPrefs} = await import('@app/features/voice/state/StreamAudioPrefs');
const channel = {id: 'c', guildId: 'g', name: 'voice', roomTheme: 'kahvehane'} as Channel;
let host: HTMLDivElement;
let root: Root;

function track(audio = true, local = false, source = 'screen_share'): TrackReferenceOrPlaceholder {
	return {
		source,
		participant: {
			identity: 'user_123_conn',
			isLocal: local,
			audioTrackPublications: new Map(audio ? [['audio', {source: 'screen_share_audio'}]] : []),
		},
	} as unknown as TrackReferenceOrPlaceholder;
}
function CompactFullscreenTrigger() {
	const {openFullscreenView} = useVoiceCallFullscreenViewState({active: true, scopeKey: 'guild-voice:c'});
	return createElement('button', {type: 'button', onClick: openFullscreenView}, 'Compact fullscreen');
}
const FullscreenSurface = observer(function FullscreenSurface() {
	const {showFullscreenView, openFullscreenView} = useVoiceCallFullscreenViewState({
		active: true,
		scopeKey: 'guild-voice:c',
	});
	return showFullscreenView
		? createElement(VoiceCallView, {channel})
		: createElement('button', {type: 'button', onClick: openFullscreenView}, 'Compact fullscreen');
});
function render() {
	act(() => root.render(createElement(VoiceCallView, {channel})));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	Object.assign(env, {room: true, tv: false, layout: 'focus', track: track()});
	VoiceCallFullscreen.close();
	VoiceSceneSettings.retry();
	vi.clearAllMocks();
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('fullscreen call presentation', () => {
	it('returns to compact when the browser exits fullscreen and preserves the viewed track', () => {
		const viewedTrack = env.track;
		act(() => root.render(createElement(FullscreenSurface)));
		act(() => host.querySelector('button')!.click());
		expect(host.querySelector('[data-room]')).toBeNull();
		expect(host.querySelector('[data-call-layout]')).not.toBeNull();
		act(() => document.dispatchEvent(new Event('fullscreenchange')));
		expect(host.querySelector('[data-call-layout]')).toBeNull();
		expect(host.textContent).toBe('Compact fullscreen');
		expect(VoiceCallFullscreen.activeScopeKey).toBeNull();
		expect(env.track).toBe(viewedTrack);
		expect(VoiceSceneSettings.preferRoom).toBe(true);
	});
	it.each(['focus', 'grid'])('keeps the viewed %s layout when compact fullscreen opens a themed channel', (layout) => {
		env.layout = layout;
		act(() => root.render(createElement(CompactFullscreenTrigger)));
		act(() => host.querySelector('button')!.click());
		render();
		expect(host.querySelector('[data-room]')).toBeNull();
		expect(host.querySelector('[data-call-layout]')?.getAttribute('data-call-layout')).toBe(layout);
		if (layout === 'focus')
			expect(host.querySelector('[data-focused-identity]')?.getAttribute('data-focused-identity')).toBe(
				'user_123_conn',
			);
	});
	it('preserves direct room entry and clears compact presentation when its scope closes', () => {
		act(() => root.render(createElement(CompactFullscreenTrigger)));
		act(() => host.querySelector('button')!.click());
		VoiceCallFullscreen.close('guild-voice:c');
		VoiceCallFullscreen.open('guild-voice:c');
		render();
		expect(host.querySelector('[data-room]')).not.toBeNull();
	});
	it('allows an explicit header room action after compact fullscreen', () => {
		act(() => root.render(createElement(CompactFullscreenTrigger)));
		act(() => host.querySelector('button')!.click());
		render();
		const room = host.querySelector<HTMLButtonElement>('button[aria-label="Show 3D room"]');
		expect(room).not.toBeNull();
		act(() => room!.click());
		expect(host.querySelector('[data-room]')).not.toBeNull();
	});
	it('does not let a different scope suppress this room', () => {
		VoiceCallFullscreen.open('guild-voice:other');
		render();
		expect(host.querySelector('[data-room]')).not.toBeNull();
	});
	it.each(['context_lost', 'load_failed'] as const)('retries %s into the room after a compact request', (failure) => {
		VoiceSceneSettings.reportFailure(failure);
		act(() => root.render(createElement(CompactFullscreenTrigger)));
		act(() => host.querySelector('button')!.click());
		render();
		expect(host.querySelector('[data-room]')).toBeNull();
		act(() => host.querySelector<HTMLButtonElement>('button[aria-label="3D view stopped. Try again"]')!.click());
		expect(VoiceSceneSettings.failure).toBeNull();
		expect(host.querySelector('[data-room]')).not.toBeNull();
	});
	it('keeps TV fullscreen on the flat watched stream', () => {
		env.tv = true;
		render();
		expect(host.querySelector('[data-room]')).toBeNull();
		expect(host.querySelector('[data-focused-identity]')?.getAttribute('data-focused-identity')).toBe('user_123_conn');
	});
});

describe('existing focused stream audio controls', () => {
	it('updates volume visibility when an audio publication arrives and leaves', () => {
		env.room = false;
		env.track = track(false);
		render();
		expect(host.querySelector('[data-stream-volume]')).toBeNull();
		const publications = env.track!.participant.audioTrackPublications;
		act(() => {
			publications.set('audio', {source: 'screen_share_audio'} as never);
			mediaUpdates.version += 1;
			for (const listener of mediaUpdates.listeners) listener();
		});
		expect(host.querySelector('[data-stream-volume]')).not.toBeNull();
		act(() => {
			publications.clear();
			mediaUpdates.version += 1;
			for (const listener of mediaUpdates.listeners) listener();
		});
		expect(host.querySelector('[data-stream-volume]')).toBeNull();
	});
	it('renders volume for a remote publication and applies stream volume and mute', () => {
		env.room = false;
		render();
		expect(host.querySelector('[data-stream-volume]')).not.toBeNull();
		act(() => host.querySelector<HTMLButtonElement>('[data-stream-volume] button')!.click());
		expect(StreamAudioPrefs.getVolume('g:c:conn')).toBe(45);
		act(() => host.querySelector<HTMLButtonElement>('[data-stream-volume] button:last-child')!.click());
		expect(StreamAudioPrefs.isMuted('g:c:conn')).toBe(true);
		expect(applyAudio).toHaveBeenCalledWith('123');
	});
	it.each(['no_audio', 'local', 'camera', 'grid'])('does not expose stream volume for %s', (state) => {
		env.room = false;
		env.track = track(state !== 'no_audio', state === 'local', state === 'camera' ? 'camera' : 'screen_share');
		if (state === 'grid') env.layout = 'grid';
		render();
		expect(host.querySelector('[data-stream-volume]')).toBeNull();
	});
});
