// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en'}}),
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/ui/state/ContextMenu', () => ({
	default: {contextMenu: null},
	isContextMenuNodeTarget: () => false,
}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: false}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/voice/components/compact_voice_call_view/CompactCallHeightToggleButton', () => ({
	CompactCallHeightToggleButton: () => null,
}));
vi.mock('@app/features/voice/components/compact_voice_call_view/useCompactVoiceCallResize', () => ({
	useCompactVoiceCallResize: () => ({
		compactHeight: null,
		maxHeight: 0,
		isResizing: false,
		handleResizePointerDown: vi.fn(),
		handleResizeKeyDown: vi.fn(),
	}),
}));
vi.mock('@app/features/voice/components/compact_voice_call_view/useConnectionLabel', () => ({
	useConnectionLabel: () => 'Connected',
}));
vi.mock('@app/features/voice/components/popout/PoppedOutOverlay', () => ({PoppedOutOverlay: () => null}));
vi.mock('@app/features/voice/components/popout/PoppedOutSurfaceStateMachine', () => ({
	selectPoppedOutOverlayTransition: () => null,
	shouldRenderPoppedOutOverlay: () => false,
}));
vi.mock('@app/features/voice/components/popout/usePoppedOutTransition', () => ({
	usePoppedOutTransition: () => ({snapshot: null, handleTransitionEnd: vi.fn()}),
}));
vi.mock('@app/features/voice/components/useVoiceCallAppFullscreen', () => ({
	useVoiceCallAppFullscreen: () => ({
		isFullscreen: false,
		supportsFullscreen: true,
		enterFullscreen: vi.fn(),
		exitFullscreen: vi.fn(),
		toggleFullscreen: vi.fn(),
	}),
}));
const tracksAndLayout = vi.hoisted(() => ({current: {} as Record<string, unknown>}));
vi.mock('@app/features/voice/components/useVoiceCallTracksAndLayout', () => ({
	useVoiceCallTracksAndLayout: () => tracksAndLayout.current,
}));
vi.mock('@app/features/voice/components/useVoiceEngineConnectionState', () => ({
	useVoiceEngineConnectionState: () => 'connected',
}));
vi.mock('@app/features/voice/components/VoiceCallLayoutContent', () => ({VoiceCallLayoutContent: () => null}));
vi.mock('@app/features/voice/components/VoiceControlBar', () => ({VoiceControlBar: () => null}));
vi.mock('@app/features/voice/components/VoiceParticipantAvatarList', () => ({
	useVoiceParticipantAvatarEntries: () => [],
	VoiceParticipantWrappedAvatarList: () => null,
}));
vi.mock('@app/features/voice/diagnostics/VoiceDebugStatsForwarder', () => ({VoiceDebugStatsForwarder: () => null}));
vi.mock('@app/features/voice/state/CallState', () => ({default: {getCall: () => null}}));
vi.mock('@app/features/voice/state/PopoutWindowManager', () => ({
	default: {isCallPopoutOpenForChannel: () => false, openCallPopout: vi.fn()},
	getVoiceCallPopoutKey: () => 'call',
	isVoicePopoutSupported: () => false,
}));
vi.mock('@app/features/channel/components/channel_header_components/ChannelHeaderIcon', () => ({
	ChannelHeaderIcon: () => null,
}));
vi.mock('@app/features/voice/components/FocusedStreamVolumeControl', async () => {
	const {createElement: h} = await import('react');
	return {
		FocusedStreamVolumeControl: ({track}: {track: {source: string} | null}) =>
			h('span', {'data-focused-track': track?.source ?? 'none'}),
	};
});

const {CompactVoiceCallViewInner} = await import(
	'@app/features/voice/components/compact_voice_call_view/CompactVoiceCallViewInner'
);

const channel = {id: 'c', guildId: 'g', name: 'voice'} as Channel;

function layout(layoutMode: 'grid' | 'focus', focusSource: string | null) {
	return {
		layoutMode,
		pinnedParticipantIdentity: null,
		hasScreenShare: focusSource === 'screen_share',
		cameraTracksAll: [],
		screenShareTracks: [],
		filteredCameraTracks: [],
		gridEntries: [],
		focusMainTrack: focusSource ? {source: focusSource, participant: {identity: 'user_a_conn', isLocal: false}} : null,
		carouselTracks: [],
		participantCount: 2,
	};
}

describe('compact call corner volume', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render() {
		act(() => root.render(createElement(CompactVoiceCallViewInner, {channel, fillHeight: true})));
		return container.querySelector('[data-focused-track]')?.getAttribute('data-focused-track');
	}

	it('points the corner volume at the focused stream', () => {
		tracksAndLayout.current = layout('focus', 'screen_share');
		expect(render()).toBe('screen_share');
	});

	it('passes no track in grid', () => {
		tracksAndLayout.current = layout('grid', 'screen_share');
		expect(render()).toBe('none');
	});
});
