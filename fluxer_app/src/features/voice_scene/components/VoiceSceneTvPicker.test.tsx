// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const menu = vi.hoisted(() => ({render: null as null | ((p: {onClose: () => void}) => ReactNode)}));

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: (event: unknown) => void}) =>
		createElement('button', {type: 'button', 'data-picker': '', onClick}, children),
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({
	openFromElementBottomRight: (_event: unknown, render: (p: {onClose: () => void}) => ReactNode) => {
		menu.render = render;
	},
}));
vi.mock('@app/features/ui/action_menu/ContextMenu', () => ({
	ContextMenuCloseProvider: ({children}: {children: ReactNode}) => children,
	MenuGroup: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/ui/action_menu/MenuItemRadio', () => ({
	MenuItemRadio: ({children, selected, onSelect}: {children: ReactNode; selected: boolean; onSelect: () => void}) =>
		createElement(
			'button',
			{type: 'button', 'data-item': '', 'data-selected': String(selected), onClick: onSelect},
			children,
		),
}));

const {default: VoiceSceneTvRequest} = await import('@app/features/voice_scene/state/VoiceSceneTvRequest');
const {VoiceSceneTvPicker} = await import('@app/features/voice_scene/components/VoiceSceneTvPicker');

function entry(userId: string, connectionId: string) {
	return {
		user: {id: userId, username: `u${userId}`},
		userId,
		connectionId,
		speaking: false,
		hasCamera: true,
		hasScreenShare: true,
		isLocal: false,
		selfMute: false,
		selfDeaf: false,
	};
}

const ENTRIES = [entry('2', 'b'), entry('3', 'c')];
const SOURCES = [
	{kind: 'screen', identity: 'user_2_b'},
	{kind: 'camera', identity: 'user_2_b'},
	{kind: 'camera', identity: 'user_3_c'},
] as const;
const CHANNEL = {id: '500', guildId: '9'} as never;

let root: Root;
let host: HTMLDivElement;
let menuHost: HTMLDivElement;
let menuRoot: Root;

function openMenu(): Array<HTMLButtonElement> {
	act(() => (host.querySelector('[data-picker]') as HTMLButtonElement).click());
	act(() => menuRoot.render(createElement('div', null, menu.render?.({onClose: vi.fn()}))));
	return [...menuHost.querySelectorAll<HTMLButtonElement>('[data-item]')];
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	host = document.createElement('div');
	menuHost = document.createElement('div');
	root = createRoot(host);
	menuRoot = createRoot(menuHost);
	menu.render = null;
	act(() =>
		root.render(
			createElement(VoiceSceneTvPicker, {
				channel: CHANNEL,
				entries: ENTRIES as never,
				sources: SOURCES,
				current: SOURCES[0],
			}),
		),
	);
});

afterEach(() => {
	act(() => {
		root.unmount();
		menuRoot.unmount();
	});
});

describe('VoiceSceneTvPicker', () => {
	it('lists remote screen shares then remote cameras in the given order, the current one checked', () => {
		const items = openMenu();
		expect(items.map((item) => item.textContent)).toEqual(["u2's screen", "u2's camera", "u3's camera"]);
		expect(items.map((item) => item.getAttribute('data-selected'))).toEqual(['true', 'false', 'false']);
	});

	it('selection is local to this viewer and this channel', () => {
		const items = openMenu();
		act(() => items[2]?.click());
		expect(VoiceSceneTvRequest.selected('500')).toEqual({kind: 'camera', identity: 'user_3_c'});
		expect(VoiceSceneTvRequest.selected('501')).toBeNull();
	});
});
