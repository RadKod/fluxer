// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import {PortalHostContext} from '@app/features/ui/overlay/PortalHostContext';
import {setupI18n} from '@lingui/core';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const update = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const i18n = setupI18n({locale: 'en', messages: {en: {}}});
vi.mock('@lingui/core/macro', () => ({msg: (value: unknown) => value}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/channel/commands/ChannelCommands', () => ({update}));
vi.mock('@app/features/channel/components/alerts/ChannelErrorModalUtils', () => ({showChannelErrorModal: vi.fn()}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => true}}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({
	default: {response: {assignments: {voice_room: {rooms: true, default_room_theme: 'gece-lounge'}}}},
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {useSmoothScrolling: false, useReducedMotion: true},
}));
const {VoiceSceneRoomThemeSelect} = await import('./VoiceSceneRoomThemeSelect');
let container: HTMLDivElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	update.mockClear();
	container = document.createElement('div');
	host = document.createElement('div');
	document.body.append(container, host);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	host.remove();
});
it('opens selectable room options in the call portal host for fullscreen and popout calls', async () => {
	const channel = {id: '42', guildId: '1', roomTheme: 'gece-lounge'} as Channel;
	await act(async () =>
		root.render(
			createElement(PortalHostContext.Provider, {value: host}, createElement(VoiceSceneRoomThemeSelect, {channel})),
		),
	);
	await act(async () =>
		container.querySelector<HTMLButtonElement>('[data-flx="ui.form.combobox.trigger-button"]')?.click(),
	);
	// Default, None and the seven rooms in the manifest.
	expect(document.querySelectorAll('[role="option"]')).toHaveLength(9);
	expect(host.querySelectorAll('[role="option"]')).toHaveLength(9);
	const coffeehouse = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find(
		(node) => node.textContent === 'Coffeehouse',
	);
	expect(coffeehouse).toBeDefined();
	await act(async () => coffeehouse?.click());
	expect(update).toHaveBeenCalledWith('42', {room_theme: 'kahvehane'});
});
