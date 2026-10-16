// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {observable, runInAction} from 'mobx';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({
	rooms: true,
	mobile: false,
	webgl: {webgl2: true, renderer: 'GPU', hardwareConcurrency: 8, deviceMemory: 8},
	channel: {id: 'c', guildId: 'g' as string | null, roomTheme: 'kahvehane' as string | null},
	channelMissing: false,
	popout: false,
}));
const media = observable({
	room: null,
	connected: true,
	channelId: 'c' as string | null,
	guildId: 'g' as string | null,
	participants: {local: {isLocal: true, isCameraEnabled: false, isScreenShareEnabled: false}},
});
const navigation = observable({channelId: 'c' as string | null});
const accessibility = observable({useReducedMotion: false, systemReducedMotion: false});
const hydration = vi.hoisted(() => ({promise: Promise.resolve()}));
const transitionTo = vi.fn();
const openPicker = vi.fn();
const preloadPicker = vi.fn();
const openMenu = vi.fn();
const dispatch = vi.fn();

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({
	makePersistent: vi.fn(),
	awaitHydration: () => hydration.promise,
}));
vi.mock('@app/features/platform/utils/ComponentBus', () => ({ComponentBus: {dispatch}}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: accessibility}));
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({marketingUrl: () => ''}));
vi.mock('@app/features/channel/state/Channels', () => ({
	default: {getChannel: () => (env.channelMissing ? null : env.channel)},
}));
vi.mock('@app/features/navigation/state/Navigation', () => ({default: navigation}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: env.rooms}),
}));
vi.mock('@app/features/voice_scene/utils/WebglSupport', () => ({getWebglSupport: () => env.webgl}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => env.mobile}}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: media, useMediaEngineVersion: () => 0}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => true}}));
vi.mock('@app/features/permissions/system/state/NativePermission', () => ({
	default: {isLinuxWaylandDesktop: false},
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({isDesktop: () => false}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: openMenu}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: vi.fn()}));
vi.mock('@app/features/voice/components/ActiveScreenShareMenu', () => ({ActiveScreenShareMenu: () => null}));
vi.mock('@app/features/voice/components/VoiceSettingsMenus', () => ({VoiceCameraSettingsMenu: () => null}));
vi.mock('@app/features/voice/components/modals/CameraPreviewModal', () => ({
	CameraPreviewModalInRoom: () => null,
	CameraPreviewModalStandalone: () => null,
}));
vi.mock('@app/features/voice/components/modals/ScreenSharePickerModal', () => ({
	openScreenSharePickerModal: openPicker,
	preloadScreenSharePickerSources: preloadPicker,
}));
vi.mock('@app/features/voice/hooks/useCameraUserCapBlocked', () => ({useCameraUserCapBlocked: () => false}));
vi.mock('@app/features/voice/hooks/useMediaDevices', () => ({useMediaDevices: () => ({videoDevices: []})}));
vi.mock('@app/features/voice/state/ActiveScreenShareSource', () => ({
	default: {getShareContext: () => null, getPublishedSource: () => null},
}));
vi.mock('@app/features/voice/state/PopoutWindowManager', () => ({
	default: {isCallPopoutOpenForChannel: () => env.popout},
}));
vi.mock('@app/features/voice/components/voice_connection_status/shared', () => ({logger: {error: vi.fn()}}));
vi.mock('@app/features/voice_scene/state/VoiceSceneTvRequest', async () => {
	const {observable: makeObservable} = await import('mobx');
	return {default: makeObservable({fullscreen: null as {kind: string; identity: string} | null})};
});

const {LocalParticipantControls} = await import('./LocalParticipantControls');
const {default: VoiceSceneSettings} = await import('@app/features/voice_scene/state/VoiceSceneSettings');
const {default: VoiceRoomControlDiscovery} = await import('@app/features/voice_scene/state/VoiceRoomControlDiscovery');
const {default: VoiceCallFullscreen} = await import('@app/features/voice/state/VoiceCallFullscreen');
const {default: VoiceSceneTvRequest} = await import('@app/features/voice_scene/state/VoiceSceneTvRequest');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	Object.assign(env, {
		rooms: true,
		mobile: false,
		webgl: {webgl2: true, renderer: 'GPU', hardwareConcurrency: 8, deviceMemory: 8},
		channel: {id: 'c', guildId: 'g', roomTheme: 'kahvehane'},
		channelMissing: false,
		popout: false,
	});
	runInAction(() => {
		Object.assign(accessibility, {useReducedMotion: false, systemReducedMotion: false});
		VoiceRoomControlDiscovery.dismissed = false;
		VoiceRoomControlDiscovery.shimmerShown = false;
		Object.assign(media, {room: null, connected: true, channelId: 'c', guildId: 'g'});
		media.participants.local.isScreenShareEnabled = false;
		navigation.channelId = 'c';
		VoiceSceneTvRequest.fullscreen = null;
	});
	VoiceSceneSettings.retry();
	hydration.promise = Promise.resolve();
	VoiceCallFullscreen.close();
	vi.clearAllMocks();
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

async function render(): Promise<void> {
	await act(async () => root.render(createElement(LocalParticipantControls)));
}

function roomButton(): HTMLButtonElement | null {
	return host.querySelector('button[data-flx="voice.voice-connection-status.local-participant-controls.room-button"]');
}

function roomBadge(): HTMLElement | null {
	return roomButton()?.querySelector('[data-flx="user.settings-status-badge.badge"]') ?? null;
}

describe('voice panel 3D room control', () => {
	it('shows the existing NEW badge with an accessible new hint until first click', async () => {
		await render();
		expect(roomBadge()?.textContent).toBe('NEW');
		expect(roomButton()?.getAttribute('aria-label')).toBe('3D room, New');
		act(() => roomButton()?.click());
		expect(roomBadge()).toBeNull();
		expect(VoiceRoomControlDiscovery.dismissed).toBe(true);
		expect(roomButton()?.getAttribute('aria-label')).toBe('Close 3D room');
		act(() => root.unmount());
		root = createRoot(host);
		await render();
		expect(roomBadge()).toBeNull();
	});

	it('dismisses the badge when closing an already expanded room', async () => {
		VoiceCallFullscreen.open('guild-voice:c');
		await render();
		expect(roomButton()?.getAttribute('aria-label')).toBe('Close 3D room, New');
		act(() => roomButton()?.click());
		expect(roomBadge()).toBeNull();
		expect(VoiceSceneSettings.preferRoom).toBe(false);
		expect(VoiceCallFullscreen.activeScopeKey).toBe('guild-voice:c');
	});

	it('shimmers once and does not replay on rerender or remount', async () => {
		await render();
		expect(roomBadge()?.className).toContain('roomNewBadgeShimmer');
		expect(VoiceRoomControlDiscovery.shimmerShown).toBe(true);
		await render();
		act(() => roomBadge()?.dispatchEvent(new Event('animationend', {bubbles: true})));
		expect(roomBadge()?.className).not.toContain('roomNewBadgeShimmer');
		await render();
		expect(roomBadge()?.className).not.toContain('roomNewBadgeShimmer');
		act(() => root.unmount());
		root = createRoot(host);
		await render();
		expect(roomBadge()?.textContent).toBe('NEW');
		expect(roomBadge()?.className).not.toContain('roomNewBadgeShimmer');
	});

	it.each(['system', 'app'])('keeps the badge still under %s reduced motion', async (source) => {
		runInAction(() => {
			accessibility.useReducedMotion = source === 'app';
			accessibility.systemReducedMotion = source === 'system';
		});
		await render();
		expect(roomBadge()?.textContent).toBe('NEW');
		expect(roomBadge()?.className).not.toContain('roomNewBadgeShimmer');
		act(() => {
			runInAction(() => {
				accessibility.useReducedMotion = false;
				accessibility.systemReducedMotion = false;
			});
		});
		expect(roomBadge()?.className).not.toContain('roomNewBadgeShimmer');
	});

	it('does not consume the first shimmer while the room control is hidden', async () => {
		env.mobile = true;
		await render();
		expect(roomBadge()).toBeNull();
		expect(VoiceRoomControlDiscovery.shimmerShown).toBe(false);
		env.mobile = false;
		act(() => root.unmount());
		root = createRoot(host);
		await render();
		expect(roomBadge()?.className).toContain('roomNewBadgeShimmer');
	});

	it('stops an active shimmer when reduced motion is enabled without replaying it', async () => {
		await render();
		expect(roomBadge()?.className).toContain('roomNewBadgeShimmer');
		act(() => {
			runInAction(() => {
				accessibility.useReducedMotion = true;
			});
		});
		expect(roomBadge()?.className).not.toContain('roomNewBadgeShimmer');
		act(() => {
			runInAction(() => {
				accessibility.useReducedMotion = false;
			});
		});
		expect(roomBadge()?.className).not.toContain('roomNewBadgeShimmer');
	});

	it('waits for persisted state before showing a badge or claiming its shimmer', async () => {
		let finishHydration!: () => void;
		hydration.promise = new Promise<void>((resolve) => {
			finishHydration = resolve;
		});
		await render();
		expect(roomBadge()).toBeNull();
		expect(VoiceRoomControlDiscovery.shimmerShown).toBe(false);
		await act(async () => {
			runInAction(() => {
				VoiceRoomControlDiscovery.dismissed = true;
			});
			finishHydration();
		});
		expect(roomBadge()).toBeNull();
	});

	it.each(['room', 'user_flat', 'context_lost', 'load_failed'] as const)('shows for %s', async (reason) => {
		if (reason === 'user_flat') VoiceSceneSettings.setPreferRoom(false);
		if (reason === 'context_lost' || reason === 'load_failed') VoiceSceneSettings.reportFailure(reason);
		await render();
		expect(roomButton()).not.toBeNull();
		expect(host.querySelectorAll('button')).toHaveLength(4);
	});

	it.each(['flag_off', 'no_theme', 'mobile', 'no_webgl', 'software_gpu', 'weak_device'])(
		'hides for %s',
		async (reason) => {
			if (reason === 'flag_off') env.rooms = false;
			if (reason === 'no_theme') env.channel.roomTheme = null;
			if (reason === 'mobile') env.mobile = true;
			if (reason === 'no_webgl') env.webgl.webgl2 = false;
			if (reason === 'software_gpu') env.webgl.renderer = 'SwiftShader';
			if (reason === 'weak_device') env.webgl.hardwareConcurrency = 2;
			await render();
			expect(roomButton()).toBeNull();
			expect(host.querySelectorAll('button')).toHaveLength(3);
		},
	);

	it.each(['disconnected', 'no_channel', 'missing_channel'])('hides when %s', async (state) => {
		runInAction(() => {
			if (state === 'disconnected') media.connected = false;
			if (state === 'no_channel') media.channelId = null;
		});
		if (state === 'missing_channel') env.channelMissing = true;
		await render();
		expect(roomButton()).toBeNull();
	});

	it('opens from compact even when preferRoom defaults true, then closes without collapsing the call', async () => {
		await render();
		expect(roomButton()?.getAttribute('aria-pressed')).toBe('false');
		act(() => roomButton()?.click());
		expect(transitionTo).toHaveBeenCalledWith('/channels/g/c');
		expect(VoiceCallFullscreen.activeScopeKey).toBe('guild-voice:c');
		expect(roomButton()?.getAttribute('aria-pressed')).toBe('true');
		expect(roomButton()?.getAttribute('aria-label')).toBe('Close 3D room');
		act(() => roomButton()?.click());
		expect(VoiceSceneSettings.preferRoom).toBe(false);
		expect(VoiceCallFullscreen.activeScopeKey).toBe('guild-voice:c');
		expect(transitionTo).toHaveBeenCalledTimes(1);
		expect(roomButton()?.getAttribute('aria-pressed')).toBe('false');
	});

	it('navigates to the connected channel and opens its scope from another channel', async () => {
		runInAction(() => {
			navigation.channelId = 'other';
		});
		VoiceCallFullscreen.open('guild-voice:c');
		await render();
		expect(roomButton()?.getAttribute('aria-pressed')).toBe('false');
		act(() => roomButton()?.click());
		expect(transitionTo).toHaveBeenCalledWith('/channels/g/c');
		expect(VoiceSceneSettings.preferRoom).toBe(true);
		act(() => {
			runInAction(() => {
				navigation.channelId = 'c';
			});
		});
		expect(roomButton()?.getAttribute('aria-pressed')).toBe('true');
	});

	it('uses the DM route and fullscreen scope', async () => {
		env.channel.guildId = null;
		runInAction(() => {
			media.guildId = null;
		});
		await render();
		act(() => roomButton()?.click());
		expect(transitionTo).toHaveBeenCalledWith('/channels/@me/c');
		expect(VoiceCallFullscreen.activeScopeKey).toBe('dm-call:c');
		expect(roomButton()?.getAttribute('aria-pressed')).toBe('true');
	});

	it.each(['context_lost', 'load_failed'] as const)(
		'retries %s through the existing settings flow',
		async (failure) => {
			VoiceSceneSettings.reportFailure(failure);
			VoiceCallFullscreen.open('guild-voice:c');
			await render();
			expect(roomButton()?.getAttribute('aria-pressed')).toBe('false');
			act(() => roomButton()?.click());
			expect(VoiceSceneSettings.failure).toBeNull();
			expect(VoiceSceneSettings.preferRoom).toBe(true);
			expect(roomButton()?.getAttribute('aria-pressed')).toBe('true');
		},
	);

	it.each(['other_scope', 'popout', 'tv_fullscreen'])(
		'does not mark %s as a displayed room or change its state',
		async (state) => {
			VoiceCallFullscreen.open(state === 'other_scope' ? 'guild-voice:other' : 'guild-voice:c');
			if (state === 'popout') env.popout = true;
			if (state === 'tv_fullscreen') {
				runInAction(() => {
					VoiceSceneTvRequest.fullscreen = {kind: 'screen', identity: 'local'};
				});
			}
			await render();
			expect(roomButton()?.getAttribute('aria-pressed')).toBe('false');
			act(() => roomButton()?.click());
			expect(VoiceSceneSettings.preferRoom).toBe(true);
			expect(env.popout).toBe(state === 'popout');
			expect(VoiceSceneTvRequest.fullscreen !== null).toBe(state === 'tv_fullscreen');
		},
	);

	it('clears a session failure hidden by the flat-view preference before opening', async () => {
		VoiceSceneSettings.reportFailure('load_failed');
		VoiceSceneSettings.setPreferRoom(false);
		await render();
		act(() => roomButton()?.click());
		expect(VoiceSceneSettings.failure).toBeNull();
		expect(roomButton()?.getAttribute('aria-pressed')).toBe('true');
	});

	it('preserves share picker, preload, and the active-share menu', async () => {
		await render();
		const share = () => host.querySelector('button[aria-label="Share your screen"]') as HTMLButtonElement;
		act(() => share().dispatchEvent(new Event('focusin', {bubbles: true})));
		expect(preloadPicker).toHaveBeenCalledTimes(1);
		act(() => share().click());
		expect(openPicker).toHaveBeenCalledTimes(1);
		act(() => {
			runInAction(() => {
				media.participants.local.isScreenShareEnabled = true;
			});
		});
		const activeShare = host.querySelector('button[aria-label="Configure or end screen share"]') as HTMLButtonElement;
		act(() => activeShare.click());
		expect(openMenu).toHaveBeenCalledTimes(1);
		act(() => roomButton()?.click());
		expect(media.participants.local.isScreenShareEnabled).toBe(true);
		expect(openPicker).toHaveBeenCalledTimes(1);
		expect(openMenu).toHaveBeenCalledTimes(1);
	});
});

describe('voice panel soundboard entry', () => {
	it('provides one accessible soundboard control using the existing toggle bus', async () => {
		await render();
		const buttons = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Soundboard"]');
		expect(buttons).toHaveLength(1);
		expect(buttons[0].disabled).toBe(false);
		expect(buttons[0].getAttribute('aria-haspopup')).toBe('dialog');
		const {getSoundboardAnchor} = await import('@app/features/voice/state/SoundboardAnchor');
		expect(getSoundboardAnchor()).toBe(buttons[0]);
		act(() => buttons[0].click());
		expect(dispatch).toHaveBeenCalledExactlyOnceWith('SOUNDBOARD_TOGGLE');
	});

	it.each(['disconnected', 'dm', 'missing_channel'])('does not open a soundboard for %s', async (state) => {
		runInAction(() => {
			if (state === 'disconnected') media.connected = false;
			if (state === 'dm') media.guildId = null;
		});
		if (state === 'missing_channel') env.channelMissing = true;
		await render();
		const button = host.querySelector<HTMLButtonElement>('button[aria-label="Soundboard"]');
		button?.click();
		expect(button === null || button.disabled).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
