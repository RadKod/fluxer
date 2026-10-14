// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/features/user/models/User';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const useMediaDevices = vi.fn(() => ({inputDevices: [], outputDevices: []}));
let openedMenu: ((props: {onClose: () => void}) => ReactNode) | null = null;

vi.mock('@lingui/core/macro', () => {
	const descriptor = (value: unknown): unknown => (typeof value === 'string' ? {message: value} : value);
	return {msg: descriptor, t: descriptor, plural: () => '', select: () => '', selectOrdinal: () => ''};
});
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children?: ReactNode}) => children ?? null,
	useLingui: () => ({i18n: {_: (descriptor: {message?: string}) => descriptor?.message ?? ''}}),
}));
vi.mock('@app/features/voice/hooks/useMediaDevices', () => ({useMediaDevices}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({
	openFromEvent: (_event: unknown, render: (props: {onClose: () => void}) => ReactNode) => {
		openedMenu = render;
	},
}));
vi.mock('@app/features/voice/components/VoiceSettingsMenus', () => ({VoiceAudioSettingsMenu: () => null}));
vi.mock('@app/features/voice/components/VoiceConnectionStatus', () => ({VoiceConnectionStatus: () => null}));
vi.mock('@app/features/app/components/floating/UserAreaPopout', () => ({UserAreaPopout: () => null}));
vi.mock('@app/features/app/components/dialogs/LoadableSettingsModals', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/ui/action_menu/SettingsContextMenu', () => ({SettingsContextMenu: () => null}));
vi.mock('@app/features/ui/components/StatusAwareAvatar', () => ({StatusAwareAvatar: () => null}));
vi.mock('@app/features/app/components/shared/custom_status_display/CustomStatusDisplay', () => ({
	CustomStatusDisplay: () => null,
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {channelId: null, guildId: null, getVoiceState: () => null, getMuteReason: () => null},
}));

const {UserArea} = await import('@app/features/app/components/layout/UserArea');

const user = {id: 'me', username: 'me', globalName: null, discriminator: '0'} as unknown as User;
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

it('reads the media device list only once a device menu is opened', () => {
	act(() => root.render(createElement(UserArea, {user})));
	expect(useMediaDevices).not.toHaveBeenCalled();
	const micButton = container.querySelector('button[aria-label*="icrophone"]');
	expect(micButton).not.toBeNull();
	act(() => {
		micButton!.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}));
	});
	expect(openedMenu).not.toBeNull();
	act(() => root.render(createElement('div', null, openedMenu!({onClose: () => {}}))));
	expect(useMediaDevices).toHaveBeenCalled();
});
